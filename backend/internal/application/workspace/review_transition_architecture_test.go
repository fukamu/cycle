package workspace

import (
	"go/ast"
	"path/filepath"
	"testing"
)

var reviewTransitionHighLevelOperations = []string{"ContinueReview", "Terminate"}

func TestReviewTransitionBoundaryIsOwnedByApplication(t *testing.T) {
	t.Parallel()

	application := parseProductionGoPackage(t, ".")
	postgresDirectory := filepath.Join("..", "..", "infrastructure", "postgres")
	postgres := parseProductionGoPackage(t, postgresDirectory)
	postgresWithTests := parseAllGoPackage(t, postgresDirectory)

	t.Run("typed Unit of Work port", func(t *testing.T) {
		unitOfWork := findInterfaceType(t, application, "ReviewTransitionUnitOfWork")
		transaction := findNamedInterfaceMethod(t, unitOfWork, "WithinReviewTransitionTransaction")
		parameters := fieldTypes(transaction.Type.(*ast.FuncType).Params)
		if len(parameters) != 2 || !isSelectorType(parameters[0], "context", "Context") {
			t.Fatalf("ReviewTransitionUnitOfWork parameters = %s", formatExpressionList(parameters))
		}
		callback, ok := parameters[1].(*ast.FuncType)
		if !ok || len(fieldTypes(callback.Params)) != 1 ||
			!isIdentifierType(fieldTypes(callback.Params)[0], "ReviewTransitionTx") ||
			!returnsOnlyError(callback) || !returnsOnlyError(transaction.Type.(*ast.FuncType)) {
			t.Fatal("WithinReviewTransitionTransaction must have signature (context.Context, func(ReviewTransitionTx) error) error")
		}
		transactionPort := findInterfaceType(t, application, "ReviewTransitionTx")
		assertInterfaceExcludesReviewTransitionOperations(t, application, "ReviewTransitionTx", transactionPort, make(map[*ast.InterfaceType]bool))
	})

	t.Run("generic Store excludes Review transition commands", func(t *testing.T) {
		store := findInterfaceType(t, application, "Store")
		assertInterfaceExcludesReviewTransitionOperations(t, application, "Store", store, make(map[*ast.InterfaceType]bool))
	})

	t.Run("Service commands each enter one Review transition Unit of Work", func(t *testing.T) {
		functions := indexApplicationFunctions(application)
		fields := indexApplicationStructFields(application)
		for _, operation := range reviewTransitionHighLevelOperations {
			key := applicationFunctionKey{receiver: "Service", name: operation}
			if functions[key] == nil {
				t.Fatalf("Application entrypoint (*Service).%s is missing", operation)
			}
			if count := countReachableNamedCalls(key, "WithinReviewTransitionTransaction", functions, fields, make(map[applicationFunctionKey]bool)); count != 1 {
				t.Fatalf("(*Service).%s reaches WithinReviewTransitionTransaction %d times, want 1", operation, count)
			}
		}
	})

	t.Run("Postgres excludes high-level Review transition orchestration", func(t *testing.T) {
		assertPackageExcludesReviewTransitionOperations(t, postgres, false)
		assertPackageExcludesReviewTransitionOperations(t, postgresWithTests, true)
	})

	t.Run("Postgres implements one READ COMMITTED adapter", func(t *testing.T) {
		var adapter *ast.FuncDecl
		for _, file := range postgres.files {
			for _, declaration := range file.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if ok && function.Recv != nil && function.Name.Name == "WithinReviewTransitionTransaction" {
					if adapter != nil {
						t.Fatal("Postgres must implement exactly one Review transition Unit of Work adapter")
					}
					adapter = function
				}
			}
		}
		if adapter == nil {
			t.Fatal("Postgres Review transition Unit of Work adapter is missing")
		}
		beginTx, readCommitted := 0, false
		ast.Inspect(adapter.Body, func(node ast.Node) bool {
			switch current := node.(type) {
			case *ast.SelectorExpr:
				if current.Sel.Name == "ReadCommitted" {
					readCommitted = true
				}
			case *ast.CallExpr:
				if selector, ok := current.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "BeginTx" {
					beginTx++
				}
			}
			return true
		})
		if beginTx != 1 || !readCommitted {
			t.Fatalf("Review transition adapter must begin exactly one explicit READ COMMITTED transaction; BeginTx=%d ReadCommitted=%t", beginTx, readCommitted)
		}
	})
}

func assertInterfaceExcludesReviewTransitionOperations(
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
			if isReviewTransitionOperation(name.Name) {
				t.Errorf("%s still exposes high-level %s orchestration", interfaceName, name.Name)
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
			assertInterfaceExcludesReviewTransitionOperations(t, application, interfaceName, nested, visited)
		}
	}
}

func assertPackageExcludesReviewTransitionOperations(t *testing.T, parsed parsedGoPackage, workspaceStoreOnly bool) {
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
			if isReviewTransitionOperation(function.Name.Name) {
				position := parsed.fileSet.Position(function.Pos())
				t.Errorf("Postgres still owns high-level %s in %s:%d", function.Name.Name, path, position.Line)
			}
		}
	}
}

func isReviewTransitionOperation(name string) bool {
	for _, operation := range reviewTransitionHighLevelOperations {
		if name == operation {
			return true
		}
	}
	return false
}
