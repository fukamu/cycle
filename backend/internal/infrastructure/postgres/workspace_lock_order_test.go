package postgres

import (
	"go/ast"
	"go/parser"
	"go/token"
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
	assertWorkspaceQueryContains(t, accountFile, "lockUser",
		"SELECT id FROM users WHERE id=$1 FOR UPDATE")
	assertWorkspaceQueryContains(t, transitionFile, "loadCycleForUpdate",
		"FROM pdca_cycles WHERE id=$1 AND goal_id=$2 AND user_id=$3 FOR UPDATE")
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
