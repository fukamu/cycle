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

func TestCycleStableSQLMethodsUseGeneratedQueries(t *testing.T) {
	t.Parallel()

	targets := map[string]map[string][]string{
		"workspace_cycle_query.go": {
			"QueryCycleRows": {"OwnedGoalExistsForCycleRead", "ListCycleSummaries"},
			"QueryCycle":     {"OwnedGoalExistsForCycleRead"},
			"queryCycleView": {"GetCycleView"},
		},
		"workspace_cycle_uow.go": {
			"FindCompleteCycleReceipt":  {"FindCompleteCycleReceipt"},
			"LockCycle":                 {"LockCycleForTransition"},
			"HasRunningCycleGeneration": {"HasRunningCycleGenerationForTransition"},
			"SaveCycleFrameCAS":         {"SaveCyclePlanCAS", "SaveCycleDoCAS", "SaveCycleCheckCAS", "SaveCycleActionCAS"},
			"CompleteCycleCAS":          {"CompleteCycleCAS"},
			"LoadCycleView":             {},
		},
		"workspace_action_ai_uow.go": {
			"LockActionCycle": {"LockCycleForTransition"},
		},
		"workspace_review_transition_uow.go": {
			"FindContinueReviewReceipt": {"FindContinueReviewReceipt"},
			"HasRunningGoalGeneration":  {"HasRunningGoalGenerationForReviewTransition"},
			"TryInsertReviewCycleClaim": {"TryInsertCycleClaim"},
			"CancelCycleCAS":            {"CancelCycleCAS"},
		},
		"workspace_goal_draft_uow.go": {
			"FindStartReplay":            {"FindStartReplay"},
			"TryInsertInitialCycleClaim": {"TryInsertCycleClaim"},
			"ListAIContextCycles":        {"ListAIContextCycles"},
		},
		"workspace_goal_uow.go": {
			"LockGoalCycleIDs": {"LockGoalCycleIDs"},
		},
		"account_repository.go": {
			"DeleteAccount": {"LockAccountCycleIDs"},
		},
	}

	var violations []string
	for path, functions := range targets {
		fileSet := token.NewFileSet()
		file, err := parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		found := map[string]bool{}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			expected, targeted := functions[function.Name.Name]
			if !targeted {
				continue
			}
			found[function.Name.Name] = true
			calls := map[string]bool{}
			checkRawSQL := path != "account_repository.go"
			ast.Inspect(function.Body, func(node ast.Node) bool {
				switch value := node.(type) {
				case *ast.CallExpr:
					selector, selectorOK := value.Fun.(*ast.SelectorExpr)
					if !selectorOK {
						return true
					}
					calls[selector.Sel.Name] = true
					if checkRawSQL &&
						(selector.Sel.Name == "Exec" || selector.Sel.Name == "Query" || selector.Sel.Name == "QueryRow") {
						position := fileSet.Position(value.Pos())
						violations = append(
							violations,
							fmt.Sprintf("%s:%d %s calls %s directly", path, position.Line, function.Name.Name, selector.Sel.Name),
						)
					}
				case *ast.BasicLit:
					if !checkRawSQL || value.Kind != token.STRING {
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
							violations = append(
								violations,
								fmt.Sprintf("%s:%d %s embeds SQL", path, position.Line, function.Name.Name),
							)
							break
						}
					}
				}
				return true
			})
			for _, method := range expected {
				if !calls[method] {
					violations = append(violations, path+" "+function.Name.Name+" does not call "+method)
				}
			}
		}
		for function := range functions {
			if !found[function] {
				violations = append(violations, path+" "+function+" is missing")
			}
		}
	}
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	t.Fatalf("Cycle stable SQL must use generated methods:\n%s", strings.Join(violations, "\n"))
}

func TestCycleReadsKeepRepeatableReadSnapshot(t *testing.T) {
	t.Parallel()

	contents, err := os.ReadFile("workspace_cycle_query.go")
	if err != nil {
		t.Fatal(err)
	}
	normalized := strings.ToLower(strings.Join(strings.Fields(string(contents)), " "))
	if count := strings.Count(normalized, "isolevel: pgx.repeatableread"); count != 2 {
		t.Fatalf("Cycle reads with REPEATABLE READ = %d, want 2", count)
	}
	if count := strings.Count(normalized, "accessmode: pgx.readonly"); count != 2 {
		t.Fatalf("read-only Cycle transactions = %d, want 2", count)
	}
	if count := strings.Count(normalized, "store.queries.withtx(tx)"); count != 2 {
		t.Fatalf("transaction-bound Cycle query sets = %d, want 2", count)
	}
}

func TestCycleSQLPreservesOwnerLockOrderingAndCASContracts(t *testing.T) {
	t.Parallel()

	readContents, err := os.ReadFile("queries/cycle_reads.sql")
	if err != nil {
		t.Fatal(err)
	}
	transitionContents, err := os.ReadFile("queries/cycle_transitions.sql")
	if err != nil {
		t.Fatal(err)
	}
	contracts := map[string]struct {
		source    string
		fragments []string
	}{
		"OwnedGoalExistsForCycleRead": {string(readContents), []string{
			"from goals", "id = sqlc.arg(goal_id)::uuid", "user_id = sqlc.arg(user_id)::uuid",
		}},
		"ListCycleSummaries": {string(readContents), []string{
			"left join goal_versions", "(c.sequence_number, c.id) <", "order by c.sequence_number desc, c.id desc",
			"limit sqlc.arg(fetch_limit)::integer",
		}},
		"GetCycleView": {string(readContents), []string{
			"join goals as g", "g.user_id = c.user_id", "left join goal_versions", "c.id = sqlc.arg(cycle_id)::uuid",
			"c.goal_id = sqlc.arg(goal_id)::uuid", "c.user_id = sqlc.arg(user_id)::uuid",
		}},
		"FindCompleteCycleReceipt": {string(transitionContents), []string{
			"completion_operation_id = sqlc.arg(operation_id)::uuid", "user_id = sqlc.arg(user_id)::uuid",
		}},
		"FindContinueReviewReceipt": {string(transitionContents), []string{
			"gv.user_id = c.user_id", "gv.goal_id = c.goal_id", "gv.created_by_operation_id = c.start_operation_id",
		}},
		"LockCycleForTransition": {string(transitionContents), []string{
			"c.id = sqlc.arg(cycle_id)::uuid", "c.goal_id = sqlc.arg(goal_id)::uuid",
			"c.user_id = sqlc.arg(user_id)::uuid", "for update",
		}},
		"TryInsertCycleClaim": {string(transitionContents), []string{
			"insert into pdca_cycles", "on conflict (user_id, start_operation_id) do nothing",
		}},
		"SaveCyclePlanCAS": {string(transitionContents), []string{
			"status = 'active'", "plan_revision = sqlc.arg(expected_frame_revision)::bigint",
		}},
		"SaveCycleDoCAS": {string(transitionContents), []string{
			"status = 'active'", "do_revision = sqlc.arg(expected_frame_revision)::bigint",
		}},
		"SaveCycleCheckCAS": {string(transitionContents), []string{
			"status = 'active'", "check_revision = sqlc.arg(expected_frame_revision)::bigint",
		}},
		"SaveCycleActionCAS": {string(transitionContents), []string{
			"action_user_modified_after_ai", "status = 'active'",
			"action_revision = sqlc.arg(expected_frame_revision)::bigint",
		}},
		"CompleteCycleCAS": {string(transitionContents), []string{
			"status = 'active'", "content_revision = sqlc.arg(expected_content_revision)::bigint",
			"completion_operation_id is null", "completion_request_hash is null",
		}},
		"CancelCycleCAS": {string(transitionContents), []string{
			"status = 'active'", "content_revision = sqlc.arg(expected_content_revision)::bigint",
		}},
		"ListAIContextCycles": {string(transitionContents), []string{
			"c.user_id = sqlc.arg(user_id)::uuid", "c.goal_id = sqlc.arg(goal_id)::uuid",
			"c.status in ('completed', 'canceled')", "c.id <> sqlc.narg(exclude_cycle_id)::uuid",
			"order by c.sequence_number desc",
		}},
		"LockGoalCycleIDs": {string(transitionContents), []string{
			"goal_id = sqlc.arg(goal_id)::uuid", "user_id = sqlc.arg(user_id)::uuid", "order by id", "for update",
		}},
		"LockAccountCycleIDs": {string(transitionContents), []string{
			"user_id = sqlc.arg(user_id)::uuid", "order by id", "for update",
		}},
	}
	for name, contract := range contracts {
		query := strings.ToLower(strings.Join(strings.Fields(cycleNamedQuery(t, contract.source, name)), " "))
		for _, fragment := range contract.fragments {
			if !strings.Contains(query, fragment) {
				t.Errorf("%s missing contract fragment %q", name, fragment)
			}
		}
	}
	for _, obsolete := range []string{"queries/cycles.sql", "generated/cycles.sql.go"} {
		if _, err = os.Stat(obsolete); !os.IsNotExist(err) {
			t.Errorf("obsolete %s still exists or could not be checked: %v", obsolete, err)
		}
	}
}

func cycleNamedQuery(t *testing.T, source, name string) string {
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
