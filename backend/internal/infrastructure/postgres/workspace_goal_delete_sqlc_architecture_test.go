package postgres

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestGoalDeleteAdaptersDoNotEmbedOwnedGoalRawSQL(t *testing.T) {
	t.Parallel()

	targets := map[string]map[string]bool{
		"workspace_goal_uow.go": {
			"FindGoalDeleteReceipt":               false,
			"LockGoalForDelete":                   false,
			"LockGoalDraftIDs":                    false,
			"LockGoalCycleIDs":                    false,
			"LockRunningGoalGenerations":          false,
			"SumLockedGoalReservationsByMonth":    false,
			"ReleaseGoalBudgetReservationCAS":     false,
			"TerminalizeGoalGenerationCAS":        false,
			"FailRunningGoalUsageCAS":             false,
			"LockGoalUsages":                      false,
			"RedactGoalUsagesCAS":                 false,
			"DeleteExpiredFinalizedGoalUsagesCAS": false,
			"DeleteGoalCAS":                       false,
			"InsertGoalDeleteReceipt":             false,
		},
		"account_repository.go": {
			"DeleteAccount": true,
		},
	}
	fileSet := token.NewFileSet()
	var violations []string
	for path, functions := range targets {
		file, err := parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			accountDelete, ok := functions[function.Name.Name]
			if !ok {
				continue
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				if accountDelete {
					literal, literalOK := node.(*ast.BasicLit)
					if !literalOK || literal.Kind != token.STRING {
						return true
					}
					value, unquoteErr := strconv.Unquote(literal.Value)
					if unquoteErr != nil || !goalDeleteOwnedTableSQL(value) {
						return true
					}
					position := fileSet.Position(literal.Pos())
					violations = append(violations, fmt.Sprintf("%s:%d %s embeds owned Goal SQL", path, position.Line, function.Name.Name))
					return true
				}
				call, callOK := node.(*ast.CallExpr)
				if !callOK {
					return true
				}
				selector, selectorOK := call.Fun.(*ast.SelectorExpr)
				if !selectorOK || selector.Sel.Name != "Exec" && selector.Sel.Name != "Query" && selector.Sel.Name != "QueryRow" {
					return true
				}
				position := fileSet.Position(call.Pos())
				violations = append(violations, fmt.Sprintf("%s:%d %s calls %s directly", path, position.Line, function.Name.Name, selector.Sel.Name))
				return true
			})
		}
	}
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	t.Fatalf("Goal Delete stable SQL must live in queries/*.sql and use generated methods:\n%s", strings.Join(violations, "\n"))
}

func TestGoalDeleteAISQLPreservesOwnerLocksExactNumericAndCAS(t *testing.T) {
	t.Parallel()

	aiContents, err := os.ReadFile("queries/goal_delete_ai.sql")
	if err != nil {
		t.Fatal(err)
	}
	budgetContents, err := os.ReadFile("queries/ai_budget.sql")
	if err != nil {
		t.Fatal(err)
	}
	contracts := map[string]struct {
		source    string
		fragments []string
	}{
		"LockRunningGoalGenerations": {string(aiContents), []string{
			"budget_reserved_cost_usd::text", "where user_id =", "and goal_id =", "status = 'running'",
			"order by id", "for update",
		}},
		"SumLockedGoalReservationsByMonth": {string(aiContents), []string{
			"sum(budget_reserved_cost_usd)::text", "where user_id =", "and goal_id =", "id = any",
			"status = 'running'", "having sum(budget_reserved_cost_usd) > 0", "order by budget_month_utc",
		}},
		"TerminalizeGoalGenerationCAS": {string(aiContents), []string{
			"failure_code = 'goal_deleted'", "budget_reserved_cost_usd = 0", "lease_expires_at = null",
			"where id =", "and user_id =", "and goal_id =", "status = 'running'",
			"budget_reserved_cost_usd = sqlc.arg(expected_reservation_usd)::text::numeric",
		}},
		"FailRunningGoalUsageCAS": {string(aiContents), []string{
			"set goal_id = null", "status = 'failed'", "content_deleted = true", "where operation_id =",
			"and user_id =", "and goal_id =", "status = 'accepted'", "provider_usage_finalized_at is null",
		}},
		"LockGoalUsages": {string(aiContents), []string{
			"from ai_usage_events", "where user_id =", "and goal_id =", "order by operation_id", "for update",
		}},
		"RedactGoalUsagesCAS": {string(aiContents), []string{
			"set goal_id = null", "when status = 'accepted' then 'failed'", "content_deleted = true",
			"where user_id =", "and goal_id =", "operation_id = any",
		}},
		"DeleteExpiredFinalizedGoalUsagesCAS": {string(aiContents), []string{
			"delete from ai_usage_events", "where user_id =", "and goal_id =", "operation_id = any",
			"quota_retain_until <=", "provider_usage_finalized_at is not null",
		}},
		"ReleaseBudgetReservationCAS": {string(budgetContents), []string{
			"reserved_cost_usd = reserved_cost_usd - sqlc.arg(amount_usd)::text::numeric",
			"where month_utc =", "reserved_cost_usd >= sqlc.arg(amount_usd)::text::numeric",
		}},
	}
	for name, contract := range contracts {
		query := strings.ToLower(strings.Join(strings.Fields(goalDeleteNamedQuery(t, contract.source, name)), " "))
		for _, fragment := range contract.fragments {
			if !strings.Contains(query, fragment) {
				t.Errorf("%s missing contract fragment %q", name, fragment)
			}
		}
	}
}

func TestGoalDeleteSQLPreservesOwnerLocksCASAndReceiptReplay(t *testing.T) {
	t.Parallel()

	contents, err := os.ReadFile("queries/goal_delete.sql")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	find := goalDeleteNamedQuery(t, source, "FindGoalDeleteReceipt")
	whereIndex := strings.Index(strings.ToLower(find), "where ")
	if whereIndex < 0 {
		t.Fatal("FindGoalDeleteReceipt is missing WHERE clause")
	}
	where := find[whereIndex:]
	if strings.Contains(strings.ToLower(where), "expires_at") {
		t.Fatal("FindGoalDeleteReceipt must return an existing receipt regardless of expiry; expiry is interpreted by Application")
	}

	contracts := map[string][]string{
		"FindGoalDeleteReceipt": {"from goal_delete_receipts", "where user_id =", "and idempotency_key ="},
		"LockGoalForDelete":     {"from goals", "where id =", "and user_id =", "for update"},
		"LockGoalDraftIDs":      {"from goal_drafts", "where goal_id =", "and user_id =", "order by id", "for update"},
		"DeleteGoalCAS":         {"delete from goals", "where id =", "and user_id =", "and revision ="},
		"InsertGoalDeleteReceipt": {
			"insert into goal_delete_receipts", "user_id", "idempotency_key", "deleted_goal_id",
			"request_hash", "deleted_at", "expires_at",
		},
		"LockAccountGoalIDs":      {"from goals", "where user_id =", "order by id", "for update"},
		"LockAccountGoalDraftIDs": {"from goal_drafts", "where user_id =", "order by id", "for update"},
	}
	for name, fragments := range contracts {
		query := strings.ToLower(strings.Join(strings.Fields(goalDeleteNamedQuery(t, source, name)), " "))
		for _, fragment := range fragments {
			if !strings.Contains(query, fragment) {
				t.Errorf("%s missing contract fragment %q", name, fragment)
			}
		}
	}
}

func TestGoalDeleteGeneratedMappingsFailClosedOnInvalidDatabaseValues(t *testing.T) {
	t.Parallel()

	validRow := db.FindGoalDeleteReceiptRow{
		DeletedGoalID: mustUUID("89000000-0000-7000-8000-000000000001"),
		RequestHash:   "request-hash",
		ExpiresAt:     timestamptz(time.Date(2026, time.August, 25, 0, 0, 0, 0, time.UTC)),
	}
	for name, mutate := range map[string]func(*db.FindGoalDeleteReceiptRow){
		"invalid deleted Goal ID": func(row *db.FindGoalDeleteReceiptRow) {
			row.DeletedGoalID = pgtype.UUID{}
		},
		"empty request hash": func(row *db.FindGoalDeleteReceiptRow) {
			row.RequestHash = ""
		},
		"invalid expiry": func(row *db.FindGoalDeleteReceiptRow) {
			row.ExpiresAt = pgtype.Timestamptz{}
		},
		"infinite expiry": func(row *db.FindGoalDeleteReceiptRow) {
			row.ExpiresAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
	} {
		t.Run(name, func(t *testing.T) {
			row := validRow
			mutate(&row)
			if _, err := goalDeleteReceiptFromRow(&row); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want persistence invariant", err)
			}
		})
	}
	if _, err := goalDeleteReceiptFromRow(nil); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("nil row error = %v, want persistence invariant", err)
	}

	validID := mustUUID("89000000-0000-7000-8000-000000000002")
	for name, ids := range map[string][]pgtype.UUID{
		"first":  {{}, validID},
		"middle": {validID, {}, validID},
		"last":   {validID, {}},
	} {
		t.Run("invalid draft ID "+name, func(t *testing.T) {
			if got, err := goalDeleteDraftIDsFromRows(ids); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) || got != nil {
				t.Fatalf("result/error = %#v/%v, want nil persistence invariant", got, err)
			}
		})
	}
}

func goalDeleteOwnedTableSQL(value string) bool {
	normalized := " " + strings.ToLower(strings.Join(strings.Fields(value), " ")) + " "
	return strings.Contains(normalized, " from goals ") ||
		strings.Contains(normalized, " into goals ") ||
		strings.Contains(normalized, " update goals ") ||
		strings.Contains(normalized, " delete from goals ") ||
		strings.Contains(normalized, " from goal_drafts ") ||
		strings.Contains(normalized, " into goal_drafts ") ||
		strings.Contains(normalized, " update goal_drafts ") ||
		strings.Contains(normalized, " delete from goal_drafts ")
}

func goalDeleteNamedQuery(t *testing.T, source, name string) string {
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
