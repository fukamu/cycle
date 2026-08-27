package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func TestGoalDeleteGenerationMappingsPreserveExactNumericAndFailClosed(t *testing.T) {
	t.Parallel()

	valid := db.LockRunningGoalGenerationsRow{
		ID:                    mustUUID("61000000-0000-7000-8000-000000000001"),
		BudgetReservedCostUsd: "0.12500000",
	}
	items, err := goalDeleteGenerationsFromSQLC([]*db.LockRunningGoalGenerationsRow{&valid})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID == "" || items[0].ReservedCostUSD != valid.BudgetReservedCostUsd {
		t.Fatalf("Goal Delete Generation mapping = %#v", items)
	}

	for name, row := range map[string]*db.LockRunningGoalGenerationsRow{
		"nil row":             nil,
		"invalid identity":    {BudgetReservedCostUsd: valid.BudgetReservedCostUsd},
		"empty exact numeric": {ID: valid.ID},
	} {
		name, row := name, row
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got, err := goalDeleteGenerationsFromSQLC([]*db.LockRunningGoalGenerationsRow{row}); !errors.Is(
				err,
				workspace.ErrGoalPersistenceInvariant,
			) || got != nil {
				t.Fatalf("result/error = %#v/%v", got, err)
			}
		})
	}
}

func TestGoalDeleteMonthlyReservationMappingsRequireFiniteDate(t *testing.T) {
	t.Parallel()

	month := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.FixedZone("test", 9*60*60))
	valid := db.SumLockedGoalReservationsByMonthRow{
		BudgetMonthUtc: pgtype.Date{Time: month, Valid: true},
		AmountUsd:      "1.25000000",
	}
	items, err := goalDeleteMonthlyReservationsFromSQLC([]*db.SumLockedGoalReservationsByMonthRow{&valid})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].MonthUtc.Location() != time.UTC || items[0].AmountUSD != valid.AmountUsd {
		t.Fatalf("Goal Delete monthly reservation mapping = %#v", items)
	}

	tests := map[string]func(*db.SumLockedGoalReservationsByMonthRow){
		"invalid date": func(row *db.SumLockedGoalReservationsByMonthRow) {
			row.BudgetMonthUtc = pgtype.Date{}
		},
		"positive infinity date": func(row *db.SumLockedGoalReservationsByMonthRow) {
			row.BudgetMonthUtc = pgtype.Date{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity date": func(row *db.SumLockedGoalReservationsByMonthRow) {
			row.BudgetMonthUtc = pgtype.Date{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"empty exact numeric": func(row *db.SumLockedGoalReservationsByMonthRow) {
			row.AmountUsd = ""
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			mutate(&row)
			if got, err := goalDeleteMonthlyReservationsFromSQLC(
				[]*db.SumLockedGoalReservationsByMonthRow{&row},
			); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) || got != nil {
				t.Fatalf("result/error = %#v/%v", got, err)
			}
		})
	}
	if got, err := goalDeleteMonthlyReservationsFromSQLC(
		[]*db.SumLockedGoalReservationsByMonthRow{nil},
	); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) || got != nil {
		t.Fatalf("nil row result/error = %#v/%v", got, err)
	}
}

func TestGoalDeleteUsageMappingDistinguishesNullFromInfiniteTimestamps(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 24, 12, 34, 56, 0, time.FixedZone("test", 9*60*60))
	valid := db.LockGoalUsagesRow{
		OperationID:      mustUUID("62000000-0000-7000-8000-000000000001"),
		Status:           "accepted",
		QuotaRetainUntil: timestamptz(now.Add(24*time.Hour + 15*time.Minute)),
	}
	unfinalized, err := goalDeleteUsageFromSQLC(&valid)
	if err != nil {
		t.Fatal(err)
	}
	if unfinalized.ProviderUsageFinalizedAt != nil || unfinalized.QuotaRetainUntil.Location() != time.UTC {
		t.Fatalf("unfinalized Goal usage mapping = %#v", unfinalized)
	}

	finalizedRow := valid
	finalizedRow.Status = "succeeded"
	finalizedRow.ProviderUsageFinalizedAt = timestamptz(now.Add(time.Minute))
	finalized, err := goalDeleteUsageFromSQLC(&finalizedRow)
	if err != nil {
		t.Fatal(err)
	}
	if finalized.ProviderUsageFinalizedAt == nil || finalized.ProviderUsageFinalizedAt.Location() != time.UTC {
		t.Fatalf("finalized Goal usage mapping = %#v", finalized)
	}

	tests := map[string]func(*db.LockGoalUsagesRow){
		"invalid identity": func(row *db.LockGoalUsagesRow) {
			row.OperationID = pgtype.UUID{}
		},
		"invalid status": func(row *db.LockGoalUsagesRow) {
			row.Status = "unknown"
		},
		"invalid retention": func(row *db.LockGoalUsagesRow) {
			row.QuotaRetainUntil = pgtype.Timestamptz{}
		},
		"positive infinity retention": func(row *db.LockGoalUsagesRow) {
			row.QuotaRetainUntil = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity retention": func(row *db.LockGoalUsagesRow) {
			row.QuotaRetainUntil = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
		"positive infinity finalization": func(row *db.LockGoalUsagesRow) {
			row.ProviderUsageFinalizedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
		},
		"negative infinity finalization": func(row *db.LockGoalUsagesRow) {
			row.ProviderUsageFinalizedAt = pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity}
		},
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			row := valid
			mutate(&row)
			if _, err := goalDeleteUsageFromSQLC(&row); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want persistence invariant", err)
			}
		})
	}
	if _, err := goalDeleteUsageFromSQLC(nil); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("nil row error = %v, want persistence invariant", err)
	}
}

func TestSumLockedGoalReservationsByMonthEmptySkipsDatabase(t *testing.T) {
	t.Parallel()

	transaction := &workspaceGoalTx{}
	items, err := transaction.SumLockedGoalReservationsByMonth(
		context.Background(),
		"not-a-uuid",
		"not-a-uuid",
		nil,
	)
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("empty reservations = %#v, error = %v", items, err)
	}
}
