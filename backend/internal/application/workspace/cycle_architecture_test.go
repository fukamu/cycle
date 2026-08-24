package workspace

import (
	"go/ast"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

var cycleHighLevelOperations = []string{"ListCycles", "GetCycle", "SaveFrame", "CompleteCycle"}

func TestCycleBoundaryIsOwnedByApplication(t *testing.T) {
	t.Parallel()

	application := parseProductionGoPackage(t, ".")
	postgresDirectory := filepath.Join("..", "..", "infrastructure", "postgres")
	postgres := parseProductionGoPackage(t, postgresDirectory)
	postgresWithTests := parseAllGoPackage(t, postgresDirectory)

	t.Run("typed query and Unit of Work ports", func(t *testing.T) {
		assertCyclePorts(t, application)
	})
	t.Run("generic Store excludes Cycle operations", func(t *testing.T) {
		interfaceType := findInterfaceType(t, application, "Store")
		assertInterfaceFieldsExcludeCycleOperations(t, application, "Store", interfaceType, make(map[*ast.InterfaceType]bool))
	})
	t.Run("Save and Complete each enter one Cycle Unit of Work", func(t *testing.T) {
		functions := indexApplicationFunctions(application)
		fields := indexApplicationStructFields(application)
		for _, operation := range []string{"SaveFrame", "CompleteCycle"} {
			key := applicationFunctionKey{receiver: "Service", name: operation}
			if functions[key] == nil {
				t.Fatalf("Application entrypoint (*Service).%s is missing", operation)
			}
			if count := countReachableNamedCalls(key, "WithinCycleTransaction", functions, fields, make(map[applicationFunctionKey]bool)); count != 1 {
				t.Fatalf("(*Service).%s reaches WithinCycleTransaction %d times, want 1", operation, count)
			}
		}
	})
	t.Run("Cycle target is locked before Goal command conflicts", func(t *testing.T) {
		assertCycleTargetPrecedesGoalConflicts(t, application)
	})
	t.Run("Postgres excludes Cycle use case orchestration", func(t *testing.T) {
		assertPackageExcludesCycleOperations(t, postgres, false)
	})
	t.Run("Postgres tests do not reattach WorkspaceStore Cycle operations", func(t *testing.T) {
		assertPackageExcludesCycleOperations(t, postgresWithTests, true)
	})
	t.Run("Postgres implements one generic Cycle transaction adapter", func(t *testing.T) {
		assertPostgresCycleUnitOfWorkAdapter(t, postgres)
	})
}

func assertCycleTargetPrecedesGoalConflicts(t *testing.T, application parsedGoPackage) {
	t.Helper()
	functions := indexApplicationFunctions(application)
	tests := []struct {
		method    string
		conflicts []string
	}{
		{method: "SaveFrame", conflicts: []string{"ErrGoalStateConflict"}},
		{method: "CompleteCycle", conflicts: []string{"ErrGoalStateConflict", "ErrGoalRevisionConflict"}},
	}
	for _, test := range tests {
		function := functions[applicationFunctionKey{receiver: "CycleUseCases", name: test.method}]
		if function == nil {
			t.Errorf("(*CycleUseCases).%s is missing", test.method)
			continue
		}
		goalLock := firstSelectorPosition(function.declaration.Body, "LockGoal")
		cycleLock := firstSelectorPosition(function.declaration.Body, "LockCycle")
		if !goalLock.IsValid() || !cycleLock.IsValid() || goalLock >= cycleLock {
			t.Errorf("(*CycleUseCases).%s must lock Goal before Cycle", test.method)
			continue
		}
		for _, conflict := range test.conflicts {
			position := firstIdentifierPosition(function.declaration.Body, conflict)
			if !position.IsValid() || position <= cycleLock {
				t.Errorf("(*CycleUseCases).%s must resolve Cycle before %s", test.method, conflict)
			}
		}
	}
}

func firstSelectorPosition(node ast.Node, name string) token.Pos {
	var position token.Pos
	ast.Inspect(node, func(current ast.Node) bool {
		selector, ok := current.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == name && !position.IsValid() {
			position = selector.Pos()
		}
		return true
	})
	return position
}

func firstIdentifierPosition(node ast.Node, name string) token.Pos {
	var position token.Pos
	ast.Inspect(node, func(current ast.Node) bool {
		identifier, ok := current.(*ast.Ident)
		if ok && identifier.Name == name && !position.IsValid() {
			position = identifier.Pos()
		}
		return true
	})
	return position
}

func assertCyclePorts(t *testing.T, application parsedGoPackage) {
	t.Helper()
	queryPort := findInterfaceType(t, application, "CycleQueryRepository")
	findNamedInterfaceMethod(t, queryPort, "QueryCycleRows")
	findNamedInterfaceMethod(t, queryPort, "QueryCycle")

	unitOfWork := findInterfaceType(t, application, "CycleUnitOfWork")
	transaction := findNamedInterfaceMethod(t, unitOfWork, "WithinCycleTransaction")
	parameters := fieldTypes(transaction.Type.(*ast.FuncType).Params)
	if len(parameters) != 2 || !isSelectorType(parameters[0], "context", "Context") {
		t.Fatalf("CycleUnitOfWork.WithinCycleTransaction parameters must start with context.Context; got %s", formatExpressionList(parameters))
	}
	callback, ok := parameters[1].(*ast.FuncType)
	if !ok {
		t.Fatalf("CycleUnitOfWork.WithinCycleTransaction second parameter must be func(CycleTx) error; got %T", parameters[1])
	}
	callbackParameters := fieldTypes(callback.Params)
	if len(callbackParameters) != 1 || !isIdentifierType(callbackParameters[0], "CycleTx") || !returnsOnlyError(callback) ||
		!returnsOnlyError(transaction.Type.(*ast.FuncType)) {
		t.Fatal("CycleUnitOfWork.WithinCycleTransaction must have signature (context.Context, func(CycleTx) error) error")
	}
	txPort := findInterfaceType(t, application, "CycleTx")
	if len(txPort.Methods.List) == 0 {
		t.Fatal("CycleTx must expose narrow SQL and lock primitives")
	}
	assertInterfaceFieldsExcludeCycleOperations(t, application, "CycleTx", txPort, make(map[*ast.InterfaceType]bool))

	useCases := findStructType(t, application, "CycleUseCases")
	if !structHasFieldType(useCases, "CycleQueryRepository") || !structHasFieldType(useCases, "CycleUnitOfWork") {
		t.Fatal("CycleUseCases must own the typed Cycle query repository and Unit of Work")
	}
	service := findStructType(t, application, "Service")
	if !structHasFieldType(service, "CycleUseCases") {
		t.Fatal("Service must depend on typed CycleUseCases separately from its generic Store")
	}
}

func assertInterfaceFieldsExcludeCycleOperations(
	t *testing.T,
	application parsedGoPackage,
	interfaceName string,
	interfaceType *ast.InterfaceType,
	visited map[*ast.InterfaceType]bool,
) {
	t.Helper()
	if visited[interfaceType] {
		return
	}
	visited[interfaceType] = true
	for _, field := range interfaceType.Methods.List {
		for _, name := range field.Names {
			if operation, found := matchingCycleOperation(name.Name); found {
				t.Errorf("%s still exposes high-level %s orchestration", interfaceName, operation)
			}
		}
		if len(field.Names) != 0 {
			continue
		}
		embedded := lookupTypeSpec(application, baseTypeName(field.Type))
		if embedded == nil {
			continue
		}
		if nested, ok := embedded.Type.(*ast.InterfaceType); ok {
			assertInterfaceFieldsExcludeCycleOperations(t, application, interfaceName, nested, visited)
		}
	}
}

func assertPackageExcludesCycleOperations(t *testing.T, parsed parsedGoPackage, workspaceStoreOnly bool) {
	t.Helper()
	for path, file := range parsed.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv == nil || len(function.Recv.List) != 1 {
				continue
			}
			if workspaceStoreOnly && baseTypeName(function.Recv.List[0].Type) != "WorkspaceStore" {
				continue
			}
			if operation, found := matchingCycleOperation(function.Name.Name); found {
				position := parsed.fileSet.Position(function.Pos())
				t.Errorf("Postgres still owns high-level %s in %s:%d", operation, path, position.Line)
			}
		}
	}
}

func assertPostgresCycleUnitOfWorkAdapter(t *testing.T, postgres parsedGoPackage) {
	t.Helper()
	var adapter *ast.FuncDecl
	for _, file := range postgres.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if ok && function.Recv != nil && function.Name.Name == "WithinCycleTransaction" {
				if adapter != nil {
					t.Fatal("Postgres must have exactly one WithinCycleTransaction adapter")
				}
				adapter = function
			}
		}
	}
	if adapter == nil {
		t.Fatal("Postgres must implement CycleUnitOfWork with WithinCycleTransaction")
	}

	beginCalls, commitCalls, callbackCalls, databaseCalls, readCommitted := 0, 0, 0, 0, false
	callbackNames := functionParameterNamesOfType(adapter.Type, func(expression ast.Expr) bool {
		_, ok := expression.(*ast.FuncType)
		return ok
	})
	ast.Inspect(adapter.Body, func(node ast.Node) bool {
		switch current := node.(type) {
		case *ast.CallExpr:
			switch called := current.Fun.(type) {
			case *ast.SelectorExpr:
				switch called.Sel.Name {
				case "BeginTx":
					beginCalls++
				case "Commit":
					commitCalls++
				case "Query", "QueryRow", "Exec", "SendBatch":
					databaseCalls++
				}
			case *ast.Ident:
				if callbackNames[called.Name] {
					callbackCalls++
				}
			}
		case *ast.SelectorExpr:
			if qualifier, ok := current.X.(*ast.Ident); ok && qualifier.Name == "pgx" && current.Sel.Name == "ReadCommitted" {
				readCommitted = true
			}
		}
		return true
	})
	if beginCalls != 1 || commitCalls != 1 || callbackCalls != 1 || !readCommitted {
		t.Fatalf("WithinCycleTransaction BeginTx/callback/commit/READ COMMITTED = %d/%d/%d/%v, want 1/1/1/true", beginCalls, callbackCalls, commitCalls, readCommitted)
	}
	if databaseCalls != 0 {
		t.Fatalf("WithinCycleTransaction contains %d SQL calls; SQL belongs in CycleTx primitives", databaseCalls)
	}
}

func matchingCycleOperation(name string) (string, bool) {
	for _, operation := range cycleHighLevelOperations {
		if strings.EqualFold(name, operation) {
			return operation, true
		}
	}
	return "", false
}
