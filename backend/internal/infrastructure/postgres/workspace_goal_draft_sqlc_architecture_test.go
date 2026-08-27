package postgres

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func TestGoalDraftStableSQLMethodsUseTransactionBoundGeneratedQueries(t *testing.T) {
	t.Parallel()

	targets := map[string]struct{}{
		"FindCreationDraft":          {},
		"LockDraftByID":              {},
		"LockReviewDraftByGoal":      {},
		"InsertCreationDraft":        {},
		"SaveDraftCAS":               {},
		"DeleteCreationDraftCAS":     {},
		"CountProgressingGoals":      {},
		"InsertInitialGoal":          {},
		"InsertInitialVersion":       {},
		"LockGoalWithCurrentVersion": {},
		"AdoptDraftCAS":              {},
	}
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "workspace_goal_draft_uow.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	generated := map[string]bool{}
	var violations []string
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		if _, ok = targets[function.Name.Name]; !ok {
			continue
		}
		found[function.Name.Name] = true
		ast.Inspect(function.Body, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.CallExpr:
				selector, selectorOK := value.Fun.(*ast.SelectorExpr)
				if !selectorOK {
					return true
				}
				base, baseOK := selector.X.(*ast.SelectorExpr)
				if baseOK {
					if base.Sel.Name == "queries" {
						generated[function.Name.Name] = true
					}
					if base.Sel.Name == "tx" && (selector.Sel.Name == "Exec" || selector.Sel.Name == "Query" || selector.Sel.Name == "QueryRow") {
						position := fileSet.Position(value.Pos())
						violations = append(violations, fmt.Sprintf("%s:%d calls transaction.tx.%s", function.Name.Name, position.Line, selector.Sel.Name))
					}
				}
			case *ast.BasicLit:
				if value.Kind != token.STRING {
					return true
				}
				literal, unquoteErr := strconv.Unquote(value.Value)
				if unquoteErr != nil {
					return true
				}
				normalized := strings.ToLower(strings.Join(strings.Fields(literal), " "))
				for _, prefix := range []string{"select ", "insert ", "update ", "delete ", "with "} {
					if strings.HasPrefix(normalized, prefix) {
						position := fileSet.Position(value.Pos())
						violations = append(violations, fmt.Sprintf("%s:%d embeds SQL: %s", function.Name.Name, position.Line, normalized))
						break
					}
				}
			}
			return true
		})
	}
	for name := range targets {
		if !found[name] {
			violations = append(violations, name+" is missing")
		} else if !generated[name] {
			violations = append(violations, name+" does not call transaction-bound generated queries")
		}
	}
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	t.Fatalf("Goal Draft stable SQL must use generated methods bound to the active transaction:\n%s", strings.Join(violations, "\n"))
}

func TestGoalDraftEmbeddingTransactionsBindGeneratedQueries(t *testing.T) {
	t.Parallel()

	targets := map[string]string{
		"workspace_goal_draft_uow.go":        "WithinGoalDraftTransaction",
		"workspace_action_ai_uow.go":         "WithinActionAITransaction",
		"workspace_review_transition_uow.go": "WithinReviewTransitionTransaction",
	}
	for path, functionName := range targets {
		path, functionName := path, functionName
		t.Run(functionName, func(t *testing.T) {
			t.Parallel()
			fileSet := token.NewFileSet()
			file, err := parser.ParseFile(fileSet, path, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			var foundFunction, bindsQueries, assignsQueries bool
			for _, declaration := range file.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if !ok || function.Name.Name != functionName || function.Body == nil {
					continue
				}
				foundFunction = true
				ast.Inspect(function.Body, func(node ast.Node) bool {
					switch value := node.(type) {
					case *ast.CallExpr:
						selector, ok := value.Fun.(*ast.SelectorExpr)
						if ok && selector.Sel.Name == "WithTx" {
							bindsQueries = true
						}
					case *ast.CompositeLit:
						selector, ok := value.Type.(*ast.Ident)
						if !ok || selector.Name != "workspaceGoalDraftTx" {
							return true
						}
						for _, element := range value.Elts {
							pair, pairOK := element.(*ast.KeyValueExpr)
							key, keyOK := pair.Key.(*ast.Ident)
							if pairOK && keyOK && key.Name == "queries" {
								assignsQueries = true
							}
						}
					}
					return true
				})
			}
			if !foundFunction || !bindsQueries || !assignsQueries {
				t.Fatalf("%s must assign store.queries.WithTx(tx) to workspaceGoalDraftTx (function=%v WithTx=%v queries=%v)",
					functionName, foundFunction, bindsQueries, assignsQueries)
			}
		})
	}
}

func TestGoalDraftSQLPreservesOwnerTupleLocksAndCAS(t *testing.T) {
	t.Parallel()

	contents, err := os.ReadFile("queries/goal_drafts.sql")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	contracts := map[string][]string{
		"FindCreationDraft":      {"from goal_drafts", "where user_id =", "draft_type = 'creation'"},
		"LockDraftByID":          {"from goal_drafts", "where id =", "and user_id =", "for update"},
		"LockReviewDraftByGoal":  {"from goal_drafts", "where goal_id =", "and user_id =", "draft_type = 'review'", "for update"},
		"InsertCreationDraft":    {"insert into goal_drafts", "draft_type", "'creation'"},
		"SaveDraftCAS":           {"update goal_drafts", "where id =", "and user_id =", "and draft_type =", "and revision ="},
		"DeleteCreationDraftCAS": {"delete from goal_drafts", "where id =", "and user_id =", "draft_type = 'creation'", "and revision ="},
		"InsertInitialGoal":      {"insert into goals", "id", "user_id", "current_version_number", "next_cycle_sequence_number", "revision"},
		"InsertGoalVersion":      {"insert into goal_versions", "id", "user_id", "goal_id", "version_number", "created_by_operation_id"},
		"LockGoalWithCurrentVersion": {
			"from goals g", "join goal_versions gv", "gv.user_id = g.user_id", "gv.goal_id = g.id",
			"gv.version_number = g.current_version_number", "where g.id =", "g.user_id =", "for update of g",
		},
		"AdoptDraftCAS": {"update goal_drafts", "where id =", "and user_id =", "and revision ="},
	}
	for name, fragments := range contracts {
		query := strings.ToLower(strings.Join(strings.Fields(goalDraftNamedQuery(t, source, name)), " "))
		for _, fragment := range fragments {
			if !strings.Contains(query, fragment) {
				t.Errorf("%s missing contract fragment %q", name, fragment)
			}
		}
	}
}

func goalDraftNamedQuery(t *testing.T, source, name string) string {
	t.Helper()
	marker := "-- name: " + name + " "
	start := strings.Index(source, marker)
	if start < 0 {
		t.Fatalf("missing sqlc query %s", name)
	}
	rest := source[start+len(marker):]
	if next := strings.Index(rest, "\n-- name: "); next >= 0 {
		rest = rest[:next]
	}
	return rest
}
