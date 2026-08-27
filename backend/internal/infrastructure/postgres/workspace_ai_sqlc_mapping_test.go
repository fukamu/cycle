package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func TestAIAdapterSQLCMappingsPreserveSeparatedHashesNumericTextAndUTC(t *testing.T) {
	t.Parallel()

	requestHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	replay, err := goalRefineReplayFromSQLC(&db.FindGoalRefineReplayRow{
		GenerationID:           mustUUID("30000000-0000-7000-8000-000000000001"),
		IdempotencyRequestHash: requestHash,
		Status:                 "running",
		TargetRevision:         0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if replay.GenerationID != "30000000-0000-7000-8000-000000000001" ||
		replay.IdempotencyRequestHash != requestHash {
		t.Fatalf("Goal replay mapping = %#v", replay)
	}

	offset := time.FixedZone("test-offset", 9*60*60)
	lease := time.Date(2026, time.August, 24, 15, 30, 0, 0, offset)
	actionReplay, err := actionAIReplayFromSQLC(&db.FindActionAIReplayRow{
		GenerationID:           mustUUID("30000000-0000-7000-8000-000000000002"),
		GoalID:                 mustUUID("40000000-0000-7000-8000-000000000001"),
		CycleID:                mustUUID("50000000-0000-7000-8000-000000000001"),
		IdempotencyRequestHash: requestHash,
		Status:                 "running",
		TargetRevision:         4,
		LeaseExpiresAt: pgtype.Timestamptz{
			Time: lease, Valid: true, InfinityModifier: pgtype.Finite,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if actionReplay.IdempotencyRequestHash != requestHash || actionReplay.LeaseExpiresAt == nil ||
		!actionReplay.LeaseExpiresAt.Equal(lease.UTC()) || actionReplay.LeaseExpiresAt.Location() != time.UTC {
		t.Fatalf("Action replay mapping = %#v", actionReplay)
	}

	month := time.Date(2026, time.August, 1, 0, 0, 0, 0, offset)
	expired, err := expiredGenerationsFromSQLC([]*db.LockExpiredGenerationsRow{{
		ID: mustUUID("30000000-0000-7000-8000-000000000003"),
		BudgetMonthUtc: pgtype.Date{
			Time: month, Valid: true, InfinityModifier: pgtype.Finite,
		},
		BudgetReservedCostUsd: "0.12345678",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 1 || expired[0].ReservedCostUSD != "0.12345678" ||
		!expired[0].BudgetMonthUtc.Equal(month.UTC()) || expired[0].BudgetMonthUtc.Location() != time.UTC {
		t.Fatalf("expired Generation mapping = %#v", expired)
	}
}

func TestAIAdapterSQLCMappingsFailClosedOnInvalidUUIDAndNonFiniteTemporalValues(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		run  func() error
		want error
	}{
		{
			name: "Goal replay UUID",
			run: func() error {
				_, err := goalRefineReplayFromSQLC(&db.FindGoalRefineReplayRow{
					IdempotencyRequestHash: "hash", Status: "running",
				})
				return err
			},
			want: workspace.ErrGoalPersistenceInvariant,
		},
		{
			name: "Action replay lease infinity",
			run: func() error {
				_, err := actionAIReplayFromSQLC(&db.FindActionAIReplayRow{
					GenerationID:           mustUUID("30000000-0000-7000-8000-000000000004"),
					GoalID:                 mustUUID("40000000-0000-7000-8000-000000000002"),
					CycleID:                mustUUID("50000000-0000-7000-8000-000000000002"),
					IdempotencyRequestHash: "hash", Status: "running",
					LeaseExpiresAt: pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity},
				})
				return err
			},
			want: workspace.ErrActionAIPersistenceInvariant,
		},
		{
			name: "expired Generation month infinity",
			run: func() error {
				_, err := expiredGenerationsFromSQLC([]*db.LockExpiredGenerationsRow{{
					ID:                    mustUUID("30000000-0000-7000-8000-000000000005"),
					BudgetMonthUtc:        pgtype.Date{Valid: true, InfinityModifier: pgtype.Infinity},
					BudgetReservedCostUsd: "1.00000000",
				}})
				return err
			},
			want: workspace.ErrGoalPersistenceInvariant,
		},
		{
			name: "Usage acceptance infinity",
			run: func() error {
				_, err := aiUsageLocatorFromSQLC(&db.FindUsageLocatorRow{
					UserID:     mustUUID("10000000-0000-7000-8000-000000000001"),
					AcceptedAt: pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.NegativeInfinity},
				})
				return err
			},
			want: workspace.ErrGoalPersistenceInvariant,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := test.run(); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestAIUsageStateFromSQLCPreservesSettlementExposureTuple(t *testing.T) {
	t.Parallel()

	acceptedAt := time.Date(2026, time.August, 24, 1, 0, 0, 0, time.UTC)
	month := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	unfinalized, err := aiUsageStateFromSQLC(&db.LockUsageRow{
		AcceptedAt: pgtype.Timestamptz{
			Time: acceptedAt, Valid: true, InfinityModifier: pgtype.Finite,
		},
		SettlementBudgetMonthUtc: pgtype.Date{
			Time: month, Valid: true, InfinityModifier: pgtype.Finite,
		},
		SettlementReservationPresent: true,
		SettlementReservationCostUsd: "0.12500000",
	})
	if err != nil {
		t.Fatal(err)
	}
	if unfinalized.FinalizedAt != nil || !unfinalized.SettlementBudgetMonthUtc.Equal(month) ||
		unfinalized.SettlementReservationCostUSD != "0.12500000" {
		t.Fatalf("unfinalized AI Usage = %#v", unfinalized)
	}

	finalizedAt := acceptedAt.Add(time.Minute)
	finalized, err := aiUsageStateFromSQLC(&db.LockUsageRow{
		AcceptedAt: pgtype.Timestamptz{
			Time: acceptedAt, Valid: true, InfinityModifier: pgtype.Finite,
		},
		ProviderUsageFinalizedAt: pgtype.Timestamptz{
			Time: finalizedAt, Valid: true, InfinityModifier: pgtype.Finite,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if finalized.FinalizedAt == nil || !finalized.FinalizedAt.Equal(finalizedAt) ||
		!finalized.SettlementBudgetMonthUtc.IsZero() || finalized.SettlementReservationCostUSD != "" {
		t.Fatalf("finalized AI Usage = %#v", finalized)
	}
}

func TestAIUsageStateFromSQLCFailsClosedOnBrokenSettlementExposureTuple(t *testing.T) {
	t.Parallel()

	acceptedAt := pgtype.Timestamptz{
		Time:  time.Date(2026, time.August, 24, 1, 0, 0, 0, time.UTC),
		Valid: true, InfinityModifier: pgtype.Finite,
	}
	month := pgtype.Date{
		Time:  time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC),
		Valid: true, InfinityModifier: pgtype.Finite,
	}
	finalizedAt := pgtype.Timestamptz{
		Time:  time.Date(2026, time.August, 24, 1, 1, 0, 0, time.UTC),
		Valid: true, InfinityModifier: pgtype.Finite,
	}
	tests := []struct {
		name string
		row  *db.LockUsageRow
	}{
		{name: "unfinalized missing month", row: &db.LockUsageRow{
			AcceptedAt: acceptedAt, SettlementReservationPresent: true,
			SettlementReservationCostUsd: "0.12500000",
		}},
		{name: "unfinalized missing reservation", row: &db.LockUsageRow{
			AcceptedAt: acceptedAt, SettlementBudgetMonthUtc: month,
		}},
		{name: "finalized retaining month", row: &db.LockUsageRow{
			AcceptedAt: acceptedAt, ProviderUsageFinalizedAt: finalizedAt,
			SettlementBudgetMonthUtc: month,
		}},
		{name: "finalized retaining reservation", row: &db.LockUsageRow{
			AcceptedAt: acceptedAt, ProviderUsageFinalizedAt: finalizedAt,
			SettlementReservationPresent: true, SettlementReservationCostUsd: "0.12500000",
		}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := aiUsageStateFromSQLC(test.row)
			if !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
				t.Fatalf("error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
			}
		})
	}
}
