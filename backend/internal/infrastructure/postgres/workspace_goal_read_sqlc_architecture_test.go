package postgres

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func TestGoalReadAdaptersDoNotEmbedRawSQL(t *testing.T) {
	t.Parallel()

	targets := map[string]map[string]struct{}{
		"workspace_store.go": {
			"Home":      {},
			"GetDraft":  {},
			"GetReview": {},
		},
		"workspace_goal_query.go": {
			"QueryGoalRows": {},
			"QueryGoal":     {},
		},
		"workspace_goal_read_mapping.go": {
			"getGoalView": {},
		},
	}
	fileSet := token.NewFileSet()
	var violations []string
	for path, functions := range targets {
		file, err := parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		violations = append(violations, goalReadRawSQLViolations(fileSet, path, file, functions)...)
	}
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	t.Fatalf("Goal read SQL must live in queries/*.sql and be called through generated methods; raw SQL found:\n%s",
		strings.Join(violations, "\n"))
}

func goalReadRawSQLViolations(
	fileSet *token.FileSet,
	path string,
	file *ast.File,
	targets map[string]struct{},
) []string {
	var violations []string
	for _, declaration := range file.Decls {
		switch value := declaration.(type) {
		case *ast.GenDecl:
			ast.Inspect(value, func(node ast.Node) bool {
				literal, ok := node.(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					return true
				}
				if normalized, ok := normalizedGoalReadSQL(literal); ok {
					position := fileSet.Position(literal.Pos())
					violations = append(violations, fmt.Sprintf("%s:%d package declaration: %s", path, position.Line, normalized))
				}
				return true
			})
		case *ast.FuncDecl:
			if value.Body == nil {
				continue
			}
			if _, ok := targets[value.Name.Name]; !ok {
				continue
			}
			ast.Inspect(value.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || selector.Sel.Name != "Query" && selector.Sel.Name != "QueryRow" {
					return true
				}
				position := fileSet.Position(call.Pos())
				violations = append(violations, fmt.Sprintf("%s:%d %s calls %s directly", path, position.Line, value.Name.Name, selector.Sel.Name))
				return true
			})
		}
	}
	return violations
}

func normalizedGoalReadSQL(literal *ast.BasicLit) (string, bool) {
	value, err := strconv.Unquote(literal.Value)
	if err != nil {
		return "", false
	}
	normalized := strings.Join(strings.Fields(value), " ")
	lower := strings.ToLower(normalized)
	if !strings.HasPrefix(lower, "select ") {
		return "", false
	}
	for _, table := range []string{" from goals ", " from goal_drafts ", " from goal_versions "} {
		if strings.Contains(lower, table) {
			return normalized, true
		}
	}
	return "", false
}
