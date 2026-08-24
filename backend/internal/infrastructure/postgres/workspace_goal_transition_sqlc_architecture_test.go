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

func TestGoalTransitionAdaptersDoNotCallRawSQL(t *testing.T) {
	t.Parallel()

	targets := map[string]map[string]struct{}{
		"workspace_cycle_uow.go": {
			"LockGoal":               {},
			"LoadCurrentGoalVersion": {},
			"InsertReviewDraft":      {},
			"EnterGoalReviewCAS":     {},
			"FindReviewDraftByCycle": {},
		},
		"workspace_review_transition_uow.go": {
			"FindGoalTerminationReceipt": {},
			"ContinueGoalCAS":            {},
			"DeleteReviewDraftCAS":       {},
			"TerminateGoalCAS":           {},
		},
	}
	fileSet := token.NewFileSet()
	var violations []string
	for path, functions := range targets {
		file, err := parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		violations = append(violations, goalTransitionRawSQLViolations(fileSet, path, file, functions)...)
	}
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	t.Fatalf("Goal transition SQL must live in queries/*.sql and be called through generated methods; direct database calls found:\n%s",
		strings.Join(violations, "\n"))
}

func goalTransitionRawSQLViolations(
	fileSet *token.FileSet,
	path string,
	file *ast.File,
	targets map[string]struct{},
) []string {
	var violations []string
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		if _, ok = targets[function.Name.Name]; !ok {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			if literal, literalOK := node.(*ast.BasicLit); literalOK && literal.Kind == token.STRING {
				value, unquoteErr := strconv.Unquote(literal.Value)
				if unquoteErr == nil && looksLikeGoalTransitionRawSQL(value) {
					position := fileSet.Position(literal.Pos())
					violations = append(violations, fmt.Sprintf("%s:%d %s embeds raw SQL", path, position.Line,
						function.Name.Name))
				}
			}
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "Exec" && selector.Sel.Name != "Query" && selector.Sel.Name != "QueryRow" {
				return true
			}
			position := fileSet.Position(call.Pos())
			violations = append(violations, fmt.Sprintf("%s:%d %s calls %s directly", path, position.Line,
				function.Name.Name, selector.Sel.Name))
			return true
		})
	}
	return violations
}

func looksLikeGoalTransitionRawSQL(value string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(value), " "))
	if !strings.HasPrefix(normalized, "select ") && !strings.HasPrefix(normalized, "insert ") &&
		!strings.HasPrefix(normalized, "update ") && !strings.HasPrefix(normalized, "delete ") {
		return false
	}
	return strings.Contains(normalized, " goals") || strings.Contains(normalized, " goal_versions") ||
		strings.Contains(normalized, " goal_drafts")
}
