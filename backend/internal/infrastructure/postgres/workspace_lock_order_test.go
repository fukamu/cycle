package postgres

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestWorkspaceTransitionSharedLockHelpersRemainOwnerScoped(t *testing.T) {
	t.Parallel()

	fileSet := token.NewFileSet()
	transitionFile, err := parser.ParseFile(fileSet, "workspace_transitions.go", nil, 0)
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
	assertWorkspaceQueryContains(t, transitionFile, "loadCycleForUpdate",
		"FROM pdca_cycles WHERE id=$1 AND goal_id=$2 AND user_id=$3 FOR UPDATE")
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

func assertWorkspaceQueryContains(t *testing.T, file *ast.File, functionName, expected string) {
	t.Helper()
	function := findWorkspaceQueryFunction(t, file, functionName)
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
	query := strings.Join(strings.Fields(strings.Join(queryParts, " ")), " ")
	if !strings.Contains(query, expected) {
		t.Fatalf("%s query literals = %q, want %q", functionName, query, expected)
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
