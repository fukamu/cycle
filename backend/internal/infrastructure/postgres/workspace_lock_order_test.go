package postgres

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"
)

func TestWorkspaceTransitionCommandsFollowGlobalLockOrder(t *testing.T) {
	t.Parallel()

	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "workspace_transitions.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	accountFile, err := parser.ParseFile(fileSet, "account_repository.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}

	assertWorkspaceLockCallsInOrder(t, file, "CompleteCycle",
		"lockUser",
		"loadGoalForUpdate",
		"loadCycleForUpdate",
	)
	assertWorkspaceLockCallsInOrder(t, file, "Terminate",
		"lockUser",
		"loadGoalForUpdate",
		"loadCycleForUpdate",
	)
	assertCompleteReplayChecksSurroundUserLock(t, file)
	assertTerminateReplayCheckFollowsUserLock(t, file)
	assertReadCommittedTransaction(t, file, "CompleteCycle")
	assertReadCommittedTransaction(t, file, "Terminate")
	assertUserUpdateLockHelper(t, accountFile)
	assertOwnerScopedGoalLockHelper(t, file)
	assertOwnerScopedCycleLockHelper(t, file)
}

func assertWorkspaceLockCallsInOrder(t *testing.T, file *ast.File, functionName string, expected ...string) {
	t.Helper()

	function := findWorkspaceLockFunction(t, file, functionName)
	positions := make(map[string][]token.Pos, len(expected))
	ast.Inspect(function.Body, func(node ast.Node) bool {
		if _, nestedFunction := node.(*ast.FuncLit); nestedFunction {
			return false
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := calledWorkspaceLockFunction(call)
		for _, candidate := range expected {
			if name == candidate {
				positions[candidate] = append(positions[candidate], call.Pos())
			}
		}
		return true
	})

	unconditional := unconditionalWorkspaceLockCalls(function.Body)
	var previous token.Pos
	for index, name := range expected {
		calls := positions[name]
		if len(calls) != 1 {
			t.Fatalf("%s calls %s %d times, want exactly once", functionName, name, len(calls))
		}
		if previous.IsValid() && calls[0] <= previous {
			t.Fatalf("%s does not acquire locks in %s order", functionName, strings.Join(expected, " -> "))
		}
		if index < len(expected)-1 && unconditional[name] != calls[0] {
			t.Fatalf("%s must acquire %s unconditionally before entering a branch that can acquire %s",
				functionName, name, expected[index+1])
		}
		previous = calls[0]
	}
}

func unconditionalWorkspaceLockCalls(body *ast.BlockStmt) map[string]token.Pos {
	positions := make(map[string]token.Pos)
	inspect := func(node ast.Node) {
		if node == nil {
			return
		}
		ast.Inspect(node, func(candidate ast.Node) bool {
			if _, nestedFunction := candidate.(*ast.FuncLit); nestedFunction {
				return false
			}
			call, ok := candidate.(*ast.CallExpr)
			if !ok {
				return true
			}
			name := calledWorkspaceLockFunction(call)
			if _, exists := positions[name]; !exists {
				positions[name] = call.Pos()
			}
			return true
		})
	}
	for _, statement := range body.List {
		switch statement := statement.(type) {
		case *ast.AssignStmt:
			inspect(statement)
		case *ast.DeclStmt:
			inspect(statement)
		case *ast.ExprStmt:
			inspect(statement)
		case *ast.IfStmt:
			inspect(statement.Init)
			inspect(statement.Cond)
		case *ast.ReturnStmt:
			inspect(statement)
		}
	}
	return positions
}

func assertUserUpdateLockHelper(t *testing.T, file *ast.File) {
	t.Helper()

	function := findWorkspaceLockFunction(t, file, "lockUser")
	query := workspaceLockQueryLiterals(function)
	if !strings.Contains(query, "SELECT id FROM users WHERE id=$1 FOR UPDATE") {
		t.Fatalf("lockUser must acquire the exclusive User command lock before Goal; query literals = %q", query)
	}
}

func assertOwnerScopedGoalLockHelper(t *testing.T, file *ast.File) {
	t.Helper()

	function := findWorkspaceLockFunction(t, file, "loadGoalForUpdate")
	query := workspaceLockQueryLiterals(function)
	if !strings.Contains(query, "FROM goals WHERE id=$1 AND user_id=$2 FOR UPDATE") {
		t.Fatalf("loadGoalForUpdate must lock the owner-scoped Goal row; query literals = %q", query)
	}
}

func assertOwnerScopedCycleLockHelper(t *testing.T, file *ast.File) {
	t.Helper()

	function := findWorkspaceLockFunction(t, file, "loadCycleForUpdate")
	query := workspaceLockQueryLiterals(function)
	if !strings.Contains(query, "FROM pdca_cycles WHERE id=$1 AND goal_id=$2 AND user_id=$3 FOR UPDATE") {
		t.Fatalf("loadCycleForUpdate must lock the owner-scoped Cycle row; query literals = %q", query)
	}
}

func assertCompleteReplayChecksSurroundUserLock(t *testing.T, file *ast.File) {
	t.Helper()

	function := findWorkspaceLockFunction(t, file, "CompleteCycle")
	receipts := directWorkspaceCallPositions(function, "loadCompleteCycleReplayReceipt")
	userLocks := directWorkspaceCallPositions(function, "lockUser")
	goalLocks := directWorkspaceCallPositions(function, "loadGoalForUpdate")
	replays := directWorkspaceCallPositions(function, "buildCompleteCycleReplay")
	if len(receipts) != 2 || len(userLocks) != 1 || len(goalLocks) != 1 || len(replays) != 1 {
		t.Fatalf("CompleteCycle receipt/user/goal/replay call counts = %d/%d/%d/%d, want 2/1/1/1",
			len(receipts), len(userLocks), len(goalLocks), len(replays))
	}
	if !(receipts[0] < userLocks[0] && userLocks[0] < receipts[1] && receipts[1] < goalLocks[0] && goalLocks[0] < replays[0]) {
		t.Fatal("CompleteCycle must classify the receipt before User lock, recheck after User lock, and build replay payload after Goal lock")
	}
}

func assertTerminateReplayCheckFollowsUserLock(t *testing.T, file *ast.File) {
	t.Helper()

	function := findWorkspaceLockFunction(t, file, "Terminate")
	userLocks := directWorkspaceCallPositions(function, "lockUser")
	replays := directWorkspaceCallPositions(function, "loadTerminateReplay")
	goalLocks := directWorkspaceCallPositions(function, "loadGoalForUpdate")
	if len(userLocks) != 1 || len(replays) != 1 || len(goalLocks) != 1 {
		t.Fatalf("Terminate user/replay/goal call counts = %d/%d/%d, want 1/1/1", len(userLocks), len(replays), len(goalLocks))
	}
	if !(userLocks[0] < replays[0] && replays[0] < goalLocks[0]) {
		t.Fatal("Terminate must check the User-scoped replay after User lock and before Goal lock")
	}
}

func assertReadCommittedTransaction(t *testing.T, file *ast.File, functionName string) {
	t.Helper()

	function := findWorkspaceLockFunction(t, file, functionName)
	found := 0
	ast.Inspect(function.Body, func(node ast.Node) bool {
		if _, nestedFunction := node.(*ast.FuncLit); nestedFunction {
			return false
		}
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) != 2 {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "BeginTx" {
			return true
		}
		options, ok := call.Args[1].(*ast.CompositeLit)
		if !ok || !isPackageSelector(options.Type, "pgx", "TxOptions") {
			return true
		}
		for _, element := range options.Elts {
			field, ok := element.(*ast.KeyValueExpr)
			if !ok {
				continue
			}
			key, ok := field.Key.(*ast.Ident)
			if ok && key.Name == "IsoLevel" && isPackageSelector(field.Value, "pgx", "ReadCommitted") {
				found++
			}
		}
		return true
	})
	if found != 1 {
		t.Fatalf("%s READ COMMITTED transaction declaration count = %d, want 1", functionName, found)
	}
}

func isPackageSelector(expression ast.Expr, packageName, selectorName string) bool {
	selector, ok := expression.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != selectorName {
		return false
	}
	packageIdentifier, ok := selector.X.(*ast.Ident)
	return ok && packageIdentifier.Name == packageName
}

func directWorkspaceCallPositions(function *ast.FuncDecl, name string) []token.Pos {
	var positions []token.Pos
	ast.Inspect(function.Body, func(node ast.Node) bool {
		if _, nestedFunction := node.(*ast.FuncLit); nestedFunction {
			return false
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		identifier, ok := call.Fun.(*ast.Ident)
		if ok && identifier.Name == name {
			positions = append(positions, call.Pos())
		}
		return true
	})
	return positions
}

func workspaceLockQueryLiterals(function *ast.FuncDecl) string {
	var queryParts []string
	ast.Inspect(function.Body, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, err := strconv.Unquote(literal.Value)
		if err == nil {
			queryParts = append(queryParts, value)
		}
		return true
	})
	return strings.Join(strings.Fields(strings.Join(queryParts, " ")), " ")
}

func findWorkspaceLockFunction(t *testing.T, file *ast.File, name string) *ast.FuncDecl {
	t.Helper()
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Name.Name == name {
			return function
		}
	}
	t.Fatalf("function %s not found", name)
	return nil
}

func calledWorkspaceLockFunction(call *ast.CallExpr) string {
	if function, ok := call.Fun.(*ast.Ident); ok {
		return function.Name
	}
	return ""
}
