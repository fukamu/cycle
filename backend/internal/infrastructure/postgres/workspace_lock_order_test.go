package postgres

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

func TestWorkspaceLockHelpersRemainOwnerScoped(t *testing.T) {
	t.Parallel()

	fileSet := token.NewFileSet()
	actionAIFile, err := parser.ParseFile(fileSet, "workspace_action_ai_uow.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	accountFile, err := parser.ParseFile(fileSet, "account_repository.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertWorkspaceCallsMethods(t, accountFile, "lockUser", "New", "LockUser")
	userQueries, err := os.ReadFile("queries/users.sql")
	if err != nil {
		t.Fatal(err)
	}
	normalizedUserQuery := strings.ToLower(strings.Join(strings.Fields(string(userQueries)), " "))
	for _, fragment := range []string{"select id from users", "where id = sqlc.arg(user_id)::uuid", "for update"} {
		if !strings.Contains(normalizedUserQuery, fragment) {
			t.Fatalf("LockUser query source = %q, want fragment %q", normalizedUserQuery, fragment)
		}
	}
	assertWorkspaceCallsMethods(t, actionAIFile, "LockActionCycle", "LockCycleForTransition")
}

func assertWorkspaceCallsMethods(t *testing.T, file *ast.File, functionName string, methods ...string) {
	t.Helper()
	function := findWorkspaceQueryFunction(t, file, functionName)
	found := make(map[string]bool, len(methods))
	ast.Inspect(function.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if ok {
			found[selector.Sel.Name] = true
		}
		return true
	})
	for _, method := range methods {
		if !found[method] {
			t.Fatalf("%s does not call %s", functionName, method)
		}
	}
}

func findWorkspaceQueryFunction(t *testing.T, file *ast.File, name string) *ast.FuncDecl {
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
