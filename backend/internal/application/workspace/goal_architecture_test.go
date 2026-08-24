package workspace

import (
	"go/ast"
	"path/filepath"
	"strings"
	"testing"
)

var goalHighLevelOperations = []string{"ListGoals", "GetGoal", "DeleteGoal"}

func TestGoalQueryDeleteBoundaryIsOwnedByApplication(t *testing.T) {
	t.Parallel()

	application := parseProductionGoPackage(t, ".")
	postgresDirectory := filepath.Join("..", "..", "infrastructure", "postgres")
	postgres := parseProductionGoPackage(t, postgresDirectory)
	postgresWithTests := parseAllGoPackage(t, postgresDirectory)

	t.Run("typed query and Unit of Work ports", func(t *testing.T) {
		assertGoalPorts(t, application)
	})
	t.Run("generic Store excludes Goal operations", func(t *testing.T) {
		assertInterfaceExcludesGoalOperations(t, application, "Store")
	})
	t.Run("Delete entrypoint enters Goal Unit of Work", func(t *testing.T) {
		functions := indexApplicationFunctions(application)
		fields := indexApplicationStructFields(application)
		key := applicationFunctionKey{receiver: "Service", name: "DeleteGoal"}
		if functions[key] == nil {
			t.Fatal("Application entrypoint (*Service).DeleteGoal is missing")
		}
		if count := countReachableNamedCalls(key, "WithinGoalTransaction", functions, fields, make(map[applicationFunctionKey]bool)); count != 1 {
			t.Fatalf("(*Service).DeleteGoal reaches WithinGoalTransaction %d times, want 1", count)
		}
	})
	t.Run("Postgres excludes Goal use case orchestration", func(t *testing.T) {
		assertPackageExcludesGoalOperations(t, postgres, false)
	})
	t.Run("Postgres tests do not reattach Goal operations", func(t *testing.T) {
		assertPackageExcludesGoalOperations(t, postgresWithTests, true)
	})
	t.Run("Postgres implements one generic Goal transaction adapter", func(t *testing.T) {
		assertPostgresGoalUnitOfWorkAdapter(t, postgres)
	})
}

func assertGoalPorts(t *testing.T, application parsedGoPackage) {
	t.Helper()

	queryPort := findInterfaceType(t, application, "GoalQueryRepository")
	findNamedInterfaceMethod(t, queryPort, "QueryGoalRows")
	findNamedInterfaceMethod(t, queryPort, "QueryGoal")

	unitOfWork := findInterfaceType(t, application, "GoalUnitOfWork")
	transaction := findNamedInterfaceMethod(t, unitOfWork, "WithinGoalTransaction")
	parameters := fieldTypes(transaction.Type.(*ast.FuncType).Params)
	if len(parameters) != 2 || !isSelectorType(parameters[0], "context", "Context") {
		t.Fatalf("GoalUnitOfWork.WithinGoalTransaction parameters must start with context.Context; got %s", formatExpressionList(parameters))
	}
	callback, ok := parameters[1].(*ast.FuncType)
	if !ok {
		t.Fatalf("GoalUnitOfWork.WithinGoalTransaction second parameter must be func(GoalTx) error; got %T", parameters[1])
	}
	callbackParameters := fieldTypes(callback.Params)
	if len(callbackParameters) != 1 || !isIdentifierType(callbackParameters[0], "GoalTx") || !returnsOnlyError(callback) ||
		!returnsOnlyError(transaction.Type.(*ast.FuncType)) {
		t.Fatal("GoalUnitOfWork.WithinGoalTransaction must have signature (context.Context, func(GoalTx) error) error")
	}
	transactionPort := findInterfaceType(t, application, "GoalTx")
	if len(transactionPort.Methods.List) == 0 {
		t.Fatal("GoalTx must expose narrow SQL and lock primitives")
	}
	assertInterfaceFieldsExcludeGoalOperations(t, application, "GoalTx", transactionPort, make(map[*ast.InterfaceType]bool))

	useCases := findStructType(t, application, "GoalUseCases")
	if !structHasFieldType(useCases, "GoalQueryRepository") || !structHasFieldType(useCases, "GoalUnitOfWork") {
		t.Fatal("GoalUseCases must own the typed Goal query repository and Unit of Work")
	}
	service := findStructType(t, application, "Service")
	if !structHasFieldType(service, "GoalUseCases") {
		t.Fatal("Service must depend on typed GoalUseCases separately from its generic Store")
	}
}

func assertInterfaceExcludesGoalOperations(t *testing.T, application parsedGoPackage, interfaceName string) {
	t.Helper()
	interfaceType := findInterfaceType(t, application, interfaceName)
	assertInterfaceFieldsExcludeGoalOperations(t, application, interfaceName, interfaceType, make(map[*ast.InterfaceType]bool))
}

func assertInterfaceFieldsExcludeGoalOperations(
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
			if operation, found := matchingGoalOperation(name.Name); found {
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
			assertInterfaceFieldsExcludeGoalOperations(t, application, interfaceName, nested, visited)
		}
	}
}

func countReachableNamedCalls(
	key applicationFunctionKey,
	callName string,
	functions map[applicationFunctionKey]*applicationFunction,
	structFields map[string]map[string]string,
	active map[applicationFunctionKey]bool,
) int {
	if active[key] || functions[key] == nil {
		return 0
	}
	active[key] = true
	defer delete(active, key)

	function := functions[key]
	count := 0
	var callees []applicationFunctionKey
	ast.Inspect(function.declaration.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch called := call.Fun.(type) {
		case *ast.SelectorExpr:
			if called.Sel.Name == callName {
				count++
				return true
			}
			switch receiver := called.X.(type) {
			case *ast.Ident:
				if function.receiverName != "" && receiver.Name == function.receiverName {
					callees = append(callees, applicationFunctionKey{receiver: key.receiver, name: called.Sel.Name})
				}
			case *ast.SelectorExpr:
				owner, ok := receiver.X.(*ast.Ident)
				if ok && function.receiverName != "" && owner.Name == function.receiverName {
					if fieldType := structFields[key.receiver][receiver.Sel.Name]; fieldType != "" {
						callees = append(callees, applicationFunctionKey{receiver: fieldType, name: called.Sel.Name})
					}
				}
			}
		case *ast.Ident:
			callees = append(callees, applicationFunctionKey{name: called.Name})
		}
		return true
	})
	for _, callee := range callees {
		count += countReachableNamedCalls(callee, callName, functions, structFields, active)
	}
	return count
}

func assertPackageExcludesGoalOperations(t *testing.T, parsed parsedGoPackage, workspaceStoreOnly bool) {
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
			if operation, found := matchingGoalOperation(function.Name.Name); found {
				position := parsed.fileSet.Position(function.Pos())
				t.Errorf("Postgres still owns high-level %s in %s:%d", operation, path, position.Line)
			}
		}
	}
}

func assertPostgresGoalUnitOfWorkAdapter(t *testing.T, postgres parsedGoPackage) {
	t.Helper()
	var adapter *ast.FuncDecl
	for _, file := range postgres.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if ok && function.Recv != nil && function.Name.Name == "WithinGoalTransaction" {
				if adapter != nil {
					t.Fatal("Postgres must have exactly one WithinGoalTransaction adapter")
				}
				adapter = function
			}
		}
	}
	if adapter == nil {
		t.Fatal("Postgres must implement GoalUnitOfWork with WithinGoalTransaction")
	}

	beginCalls, commitCalls, callbackCalls, databaseCalls := 0, 0, 0, 0
	callbackNames := functionParameterNamesOfType(adapter.Type, func(expression ast.Expr) bool {
		_, ok := expression.(*ast.FuncType)
		return ok
	})
	ast.Inspect(adapter.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch called := call.Fun.(type) {
		case *ast.SelectorExpr:
			switch called.Sel.Name {
			case "Begin", "BeginTx":
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
		return true
	})
	if beginCalls != 1 || commitCalls != 1 || callbackCalls != 1 {
		t.Fatalf("WithinGoalTransaction begin/callback/commit calls = %d/%d/%d, want 1/1/1", beginCalls, callbackCalls, commitCalls)
	}
	if databaseCalls != 0 {
		t.Fatalf("WithinGoalTransaction contains %d SQL calls; SQL belongs in GoalTx primitives", databaseCalls)
	}
}

func matchingGoalOperation(name string) (string, bool) {
	for _, operation := range goalHighLevelOperations {
		if strings.EqualFold(name, operation) {
			return operation, true
		}
	}
	return "", false
}
