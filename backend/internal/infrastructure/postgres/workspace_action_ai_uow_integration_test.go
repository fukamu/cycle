package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

const (
	actionAIUOWUserID             = "81000000-0000-7000-8000-000000000001"
	actionAIUOWGoalID             = "82000000-0000-7000-8000-000000000001"
	actionAIUOWVersionID          = "83000000-0000-7000-8000-000000000001"
	actionAIUOWCycleID            = "84000000-0000-7000-8000-000000000001"
	actionAIUOWStartOperationID   = "85000000-0000-7000-8000-000000000001"
	actionAIUOWVersionOperationID = "85000000-0000-7000-8000-000000000002"
	actionAIUOWGenerationID       = "86000000-0000-7000-8000-000000000001"
	actionAIUOWIdempotencyKey     = "87000000-0000-7000-8000-000000000001"
	actionAIUOWRequestHash        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	actionAIUOWCanonicalHash      = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	actionAIUOWReservation        = "0.25000000"
)

func TestWorkspaceStoreWithinActionAITransactionIsReadCommittedAndAtomic(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	seedActionAIUOWTarget(t, pool, now)
	store := NewWorkspaceStore(pool)

	committedAt := now.Add(time.Minute)
	if err := store.WithinActionAITransaction(ctx, func(port workspace.ActionAITx) error {
		transaction, ok := port.(*workspaceActionAITx)
		if !ok {
			t.Fatalf("Action AI transaction type = %T", port)
		}
		var isolation string
		if err := transaction.tx.QueryRow(ctx, "SHOW transaction_isolation").Scan(&isolation); err != nil {
			return err
		}
		if isolation != "read committed" {
			t.Fatalf("Action AI transaction isolation = %q", isolation)
		}
		_, err := transaction.tx.Exec(ctx, `UPDATE users SET last_active_at=$2 WHERE id=$1`,
			mustUUID(actionAIUOWUserID), committedAt)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	assertActionAIUOWUserLastActiveAt(t, pool, committedAt)

	sentinel := errors.New("rollback Action AI transaction")
	rolledBackAt := now.Add(2 * time.Minute)
	if err := store.WithinActionAITransaction(ctx, func(port workspace.ActionAITx) error {
		transaction := port.(*workspaceActionAITx)
		if _, execErr := transaction.tx.Exec(ctx, `UPDATE users SET last_active_at=$2 WHERE id=$1`,
			mustUUID(actionAIUOWUserID), rolledBackAt); execErr != nil {
			return execErr
		}
		return sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("rollback error = %v, want %v", err, sentinel)
	}
	assertActionAIUOWUserLastActiveAt(t, pool, committedAt)
}

func TestActionAITxPersistsReplayApplyAndExactSettlement(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	seedActionAIUOWTarget(t, pool, now)
	store := NewWorkspaceStore(pool)
	leaseExpiresAt := now.Add(15 * time.Minute)
	acceptActionAIUOWGeneration(t, store, leaseExpiresAt)

	if err := store.WithinActionAITransaction(ctx, func(tx workspace.ActionAITx) error {
		if err := tx.LockUser(ctx, actionAIUOWUserID); err != nil {
			return err
		}
		replay, err := tx.FindActionAIReplay(
			ctx, actionAIUOWUserID, domainai.OperationActionGenerate, actionAIUOWIdempotencyKey,
		)
		if err != nil {
			return err
		}
		if replay == nil || replay.GenerationID != actionAIUOWGenerationID ||
			replay.GoalID != actionAIUOWGoalID || replay.CycleID != actionAIUOWCycleID ||
			replay.IdempotencyRequestHash != actionAIUOWRequestHash || replay.Status != "running" ||
			replay.TargetRevision != 4 || replay.Output != nil || replay.FailureCode != "" || replay.ContextChanged ||
			replay.LeaseExpiresAt == nil || !replay.LeaseExpiresAt.Equal(leaseExpiresAt) {
			t.Fatalf("running Action replay = %#v", replay)
		}
		running, err := tx.HasRunningCycleGeneration(ctx, actionAIUOWUserID, actionAIUOWGoalID, actionAIUOWCycleID)
		if err != nil || !running {
			t.Fatalf("running Cycle generation = %t, %v", running, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	finishedAt := now.Add(2 * time.Minute)
	output := "AIが生成したAction"
	if err := store.WithinActionAITransaction(ctx, func(tx workspace.ActionAITx) error {
		if err := tx.LockUser(ctx, actionAIUOWUserID); err != nil {
			return err
		}
		target, err := tx.LockGoalWithCurrentVersion(ctx, actionAIUOWUserID, actionAIUOWGoalID)
		if err != nil {
			return err
		}
		current, err := tx.LockActionCycle(ctx, actionAIUOWUserID, actionAIUOWGoalID, actionAIUOWCycleID)
		if err != nil {
			return err
		}
		generation, err := tx.LockActionAIGeneration(ctx, workspace.ActionAIGenerationKey{
			GenerationID: actionAIUOWGenerationID,
			UserID:       actionAIUOWUserID,
			GoalID:       actionAIUOWGoalID,
			CycleID:      actionAIUOWCycleID,
			Operation:    domainai.OperationActionGenerate,
		})
		if err != nil {
			return err
		}
		if target.CurrentVersionID != actionAIUOWVersionID || current.Revisions.Content != 4 ||
			current.Revisions.Action != 1 || generation.GoalVersionID != actionAIUOWVersionID ||
			generation.TargetRevision != 4 || generation.ReservedCostUSD != actionAIUOWReservation {
			t.Fatalf("locked target/current/generation = %#v / %#v / %#v", target, current, generation)
		}

		apply := workspace.ActionAIApplyRecord{
			UserID:                  actionAIUOWUserID,
			GoalID:                  actionAIUOWGoalID,
			CycleID:                 actionAIUOWCycleID,
			GoalVersionID:           actionAIUOWVersionID,
			Action:                  output,
			ExpectedContentRevision: current.Revisions.Content,
			ExpectedActionRevision:  current.Revisions.Action,
			NewContentRevision:      current.Revisions.Content + 1,
			NewActionRevision:       current.Revisions.Action + 1,
			UpdatedAt:               finishedAt,
		}
		rows, err := tx.ApplyActionAICAS(ctx, apply)
		if err != nil || rows != 1 {
			t.Fatalf("ApplyActionAICAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.ApplyActionAICAS(ctx, apply)
		if err != nil || rows != 0 {
			t.Fatalf("stale ApplyActionAICAS rows/error = %d/%v", rows, err)
		}

		terminal := workspace.ActionAIGenerationSettlement{
			GenerationID:           actionAIUOWGenerationID,
			Operation:              domainai.OperationActionGenerate,
			ExpectedReservationUSD: generation.ReservedCostUSD,
			Status:                 "succeeded",
			Output:                 &output,
			InputTokens:            123,
			OutputTokens:           45,
			EstimatedCostUSD:       "0.12500000",
			AttemptCount:           2,
			ProviderRequestID:      "provider-request",
			ContextChanged:         false,
			AppliedAt:              &finishedAt,
			FinishedAt:             finishedAt,
		}
		rows, err = tx.TerminalizeActionAIGenerationCAS(ctx, terminal)
		if err != nil || rows != 1 {
			t.Fatalf("TerminalizeActionAIGenerationCAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.TerminalizeActionAIGenerationCAS(ctx, terminal)
		if err != nil || rows != 0 {
			t.Fatalf("repeated terminal CAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.SettleBudgetCAS(ctx, generation.BudgetMonthUtc, generation.ReservedCostUSD, "0.12500000", finishedAt)
		if err != nil || rows != 1 {
			t.Fatalf("SettleBudgetCAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.FinalizeUsageCAS(ctx, workspace.AIUsageSettlement{
			OperationID:                actionAIUOWGenerationID,
			ExpectedBudgetMonthUtc:     generation.BudgetMonthUtc,
			ExpectedReservationCostUSD: generation.ReservedCostUSD,
			Status:                     "succeeded",
			InputTokens:                123,
			OutputTokens:               45,
			EstimatedCostUSD:           "0.12500000",
			FinalizedAt:                finishedAt,
		})
		if err != nil || rows != 1 {
			t.Fatalf("FinalizeUsageCAS rows/error = %d/%v", rows, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	assertActionAIUOWSettledState(t, pool, output, finishedAt)
	if err := store.WithinActionAITransaction(ctx, func(tx workspace.ActionAITx) error {
		if err := tx.LockUser(ctx, actionAIUOWUserID); err != nil {
			return err
		}
		replay, err := tx.FindActionAIReplay(
			ctx, actionAIUOWUserID, domainai.OperationActionGenerate, actionAIUOWIdempotencyKey,
		)
		if err != nil {
			return err
		}
		if replay == nil || replay.Status != "succeeded" || replay.Output == nil || *replay.Output != output ||
			replay.LeaseExpiresAt != nil || replay.IdempotencyRequestHash != actionAIUOWRequestHash {
			t.Fatalf("terminal Action replay = %#v", replay)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestActionAITxLocksHistoricalCyclesAndApplyCASFailsClosed(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	seedActionAIUOWTarget(t, pool, now)
	const (
		completedCycleID = "84000000-0000-7000-8000-000000000002"
		canceledCycleID  = "84000000-0000-7000-8000-000000000003"
	)
	insertActionAIUOWHistoricalCycles(t, pool, completedCycleID, canceledCycleID, now)
	store := NewWorkspaceStore(pool)

	if err := store.WithinActionAITransaction(ctx, func(tx workspace.ActionAITx) error {
		if err := tx.LockUser(ctx, actionAIUOWUserID); err != nil {
			return err
		}
		if _, err := tx.LockGoalWithCurrentVersion(ctx, actionAIUOWUserID, actionAIUOWGoalID); err != nil {
			return err
		}
		for _, test := range []struct {
			cycleID string
			status  cycle.Status
		}{
			{cycleID: completedCycleID, status: cycle.StatusCompleted},
			{cycleID: canceledCycleID, status: cycle.StatusCanceled},
		} {
			current, err := tx.LockActionCycle(ctx, actionAIUOWUserID, actionAIUOWGoalID, test.cycleID)
			if err != nil {
				return err
			}
			if current.Status != test.status {
				t.Fatalf("historical Cycle %s status = %s, want %s", test.cycleID, current.Status, test.status)
			}
			rows, err := tx.ApplyActionAICAS(ctx, workspace.ActionAIApplyRecord{
				UserID: actionAIUOWUserID, GoalID: actionAIUOWGoalID, CycleID: test.cycleID,
				GoalVersionID: actionAIUOWVersionID, Action: "must not apply",
				ExpectedContentRevision: current.Revisions.Content,
				ExpectedActionRevision:  current.Revisions.Action,
				NewContentRevision:      current.Revisions.Content + 1,
				NewActionRevision:       current.Revisions.Action + 1,
				UpdatedAt:               now.Add(time.Minute),
			})
			if err != nil || rows != 0 {
				t.Fatalf("historical ApplyActionAICAS %s rows/error = %d/%v", test.status, rows, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestActionAITxRecoversExpiredLeaseWithExactExposure(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	seedActionAIUOWTarget(t, pool, now)
	store := NewWorkspaceStore(pool)
	acceptActionAIUOWGeneration(t, store, now)

	recoveredAt := now.Add(time.Minute)
	if err := store.WithinActionAITransaction(ctx, func(tx workspace.ActionAITx) error {
		if err := tx.LockUser(ctx, actionAIUOWUserID); err != nil {
			return err
		}
		if _, err := tx.LockGoalWithCurrentVersion(ctx, actionAIUOWUserID, actionAIUOWGoalID); err != nil {
			return err
		}
		if _, err := tx.LockActionCycle(ctx, actionAIUOWUserID, actionAIUOWGoalID, actionAIUOWCycleID); err != nil {
			return err
		}
		expired, err := tx.LockExpiredGenerations(ctx, actionAIUOWUserID, recoveredAt)
		if err != nil {
			return err
		}
		if len(expired) != 1 || expired[0].ID != actionAIUOWGenerationID ||
			expired[0].ReservedCostUSD != actionAIUOWReservation {
			t.Fatalf("expired generations = %#v", expired)
		}
		monthly, err := tx.SumLockedReservationsByMonth(ctx, []string{expired[0].ID})
		if err != nil {
			return err
		}
		if len(monthly) != 1 || monthly[0].AmountUSD != actionAIUOWReservation {
			t.Fatalf("monthly reservations = %#v", monthly)
		}
		rows, err := tx.ReleaseBudgetReservationCAS(ctx, monthly[0].MonthUtc, monthly[0].AmountUSD, recoveredAt)
		if err != nil || rows != 1 {
			t.Fatalf("ReleaseBudgetReservationCAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.ExpireGenerationCAS(ctx, expired[0].ID, expired[0].ReservedCostUSD, recoveredAt)
		if err != nil || rows != 1 {
			t.Fatalf("ExpireGenerationCAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.ExpireUsageCAS(ctx, expired[0].ID, expired[0].BudgetMonthUtc, expired[0].ReservedCostUSD)
		if err != nil || rows != 1 {
			t.Fatalf("ExpireUsageCAS rows/error = %d/%v", rows, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	var (
		generationStatus      string
		failureCode           string
		generationReservation string
		generationLeaseIsNull bool
		generationFinishedAt  time.Time
		usageStatus           string
		usageFinalized        bool
		usageMonth            time.Time
		usageReservation      string
		budgetReserved        string
	)
	if err := pool.QueryRow(ctx, `SELECT status,failure_code,budget_reserved_cost_usd::text,
lease_expires_at IS NULL,finished_at FROM ai_generations WHERE id=$1`, mustUUID(actionAIUOWGenerationID)).Scan(
		&generationStatus, &failureCode, &generationReservation, &generationLeaseIsNull, &generationFinishedAt,
	); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status,provider_usage_finalized_at IS NOT NULL,
settlement_budget_month_utc,settlement_reservation_cost_usd::text
FROM ai_usage_events WHERE operation_id=$1`, mustUUID(actionAIUOWGenerationID)).Scan(
		&usageStatus, &usageFinalized, &usageMonth, &usageReservation,
	); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT reserved_cost_usd::text FROM ai_budget_monthly
WHERE month_utc=$1`, actionAIUOWMonth(now)).Scan(&budgetReserved); err != nil {
		t.Fatal(err)
	}
	if generationStatus != "failed" || failureCode != "lease_expired" || generationReservation != "0.00000000" ||
		!generationLeaseIsNull || !generationFinishedAt.Equal(recoveredAt) || usageStatus != "failed" || usageFinalized ||
		!usageMonth.Equal(actionAIUOWMonth(now)) || usageReservation != actionAIUOWReservation || budgetReserved != "0.00000000" {
		t.Fatalf("lease recovery state generation=%s/%s/%s/%t/%v usage=%s/%t/%v/%s budget=%s",
			generationStatus, failureCode, generationReservation, generationLeaseIsNull, generationFinishedAt,
			usageStatus, usageFinalized, usageMonth, usageReservation, budgetReserved)
	}
}

func TestActionAITxSettlesLateUsageAfterTargetDeletionExactlyOnce(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	seedActionAIUOWTarget(t, pool, now)
	store := NewWorkspaceStore(pool)
	acceptActionAIUOWGeneration(t, store, now.Add(15*time.Minute))
	deletedAt := now.Add(time.Minute)
	deleteActionAIUOWTargetWithUnfinalizedUsage(t, pool, deletedAt)

	finalizedAt := now.Add(2 * time.Minute)
	if err := store.WithinActionAITransaction(ctx, func(tx workspace.ActionAITx) error {
		locator, err := tx.FindGenerationLocator(ctx, actionAIUOWGenerationID)
		if err != nil || locator != nil {
			t.Fatalf("deleted generation locator = %#v, %v", locator, err)
		}
		usageLocator, err := tx.FindUsageLocator(ctx, actionAIUOWGenerationID)
		if err != nil {
			return err
		}
		if usageLocator == nil || usageLocator.UserID != actionAIUOWUserID || usageLocator.FinalizedAt != nil {
			t.Fatalf("late usage locator = %#v", usageLocator)
		}
		if err = tx.LockUser(ctx, usageLocator.UserID); err != nil {
			return err
		}
		usage, err := tx.LockUsage(ctx, actionAIUOWGenerationID, usageLocator.UserID)
		if err != nil {
			return err
		}
		if usage.FinalizedAt != nil || usage.SettlementReservationCostUSD != actionAIUOWReservation ||
			!usage.SettlementBudgetMonthUtc.Equal(actionAIUOWMonth(now)) {
			t.Fatalf("locked late usage = %#v", usage)
		}
		if err = tx.EnsureBudgetMonth(ctx, usage.SettlementBudgetMonthUtc, finalizedAt); err != nil {
			return err
		}
		rows, err := tx.AddLateActualCostCAS(ctx, usage.SettlementBudgetMonthUtc, "0.03125000", finalizedAt)
		if err != nil || rows != 1 {
			t.Fatalf("AddLateActualCostCAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.FinalizeLateUsageCAS(ctx, workspace.AIUsageSettlement{
			OperationID:                actionAIUOWGenerationID,
			ExpectedBudgetMonthUtc:     usage.SettlementBudgetMonthUtc,
			ExpectedReservationCostUSD: usage.SettlementReservationCostUSD,
			Status:                     "succeeded",
			InputTokens:                20,
			OutputTokens:               10,
			EstimatedCostUSD:           "0.03125000",
			FinalizedAt:                finalizedAt,
		})
		if err != nil || rows != 1 {
			t.Fatalf("FinalizeLateUsageCAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.FinalizeLateUsageCAS(ctx, workspace.AIUsageSettlement{
			OperationID:                actionAIUOWGenerationID,
			ExpectedBudgetMonthUtc:     usage.SettlementBudgetMonthUtc,
			ExpectedReservationCostUSD: usage.SettlementReservationCostUSD,
			Status:                     "succeeded",
			InputTokens:                20,
			OutputTokens:               10,
			EstimatedCostUSD:           "0.03125000",
			FinalizedAt:                finalizedAt,
		})
		if err != nil || rows != 0 {
			t.Fatalf("repeated FinalizeLateUsageCAS rows/error = %d/%v", rows, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	var (
		generationCount  int
		goalID           *string
		usageStatus      string
		contentDeleted   bool
		inputTokens      int64
		outputTokens     int64
		cost             string
		usageFinalizedAt time.Time
		exposureCleared  bool
		budgetReserved   string
		budgetActual     string
	)
	if err := pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM ai_generations WHERE id=$1),goal_id,status,content_deleted,input_tokens,output_tokens,
estimated_cost_usd::text,provider_usage_finalized_at,
settlement_budget_month_utc IS NULL AND settlement_reservation_cost_usd IS NULL
FROM ai_usage_events WHERE operation_id=$1`, mustUUID(actionAIUOWGenerationID)).Scan(
		&generationCount, &goalID, &usageStatus, &contentDeleted, &inputTokens, &outputTokens,
		&cost, &usageFinalizedAt, &exposureCleared,
	); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT reserved_cost_usd::text,actual_cost_usd::text FROM ai_budget_monthly
WHERE month_utc=$1`, actionAIUOWMonth(now)).Scan(&budgetReserved, &budgetActual); err != nil {
		t.Fatal(err)
	}
	if generationCount != 0 || goalID != nil || usageStatus != "succeeded" || !contentDeleted ||
		inputTokens != 20 || outputTokens != 10 || cost != "0.03125000" || !usageFinalizedAt.Equal(finalizedAt) ||
		!exposureCleared || budgetReserved != "0.00000000" || budgetActual != "0.03125000" {
		t.Fatalf("late settlement generation=%d goal=%v usage=%s/%t/%d/%d/%s/%v/%t budget=%s/%s",
			generationCount, goalID, usageStatus, contentDeleted, inputTokens, outputTokens, cost, usageFinalizedAt,
			exposureCleared, budgetReserved, budgetActual)
	}
}

func TestActionAITxStaleUsageLocatorConvergesAfterConcurrentFinalization(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	seedActionAIUOWTarget(t, pool, now)
	store := NewWorkspaceStore(pool)
	acceptActionAIUOWGeneration(t, store, now.Add(15*time.Minute))
	deleteActionAIUOWTargetWithUnfinalizedUsage(t, pool, now.Add(time.Minute))

	finalizedAt := now.Add(2 * time.Minute)
	if err := store.WithinActionAITransaction(ctx, func(staleTx workspace.ActionAITx) error {
		locator, err := staleTx.FindUsageLocator(ctx, actionAIUOWGenerationID)
		if err != nil {
			return err
		}
		if locator == nil || locator.FinalizedAt != nil {
			t.Fatalf("stale usage locator = %#v", locator)
		}

		if err = store.WithinActionAITransaction(ctx, func(winnerTx workspace.ActionAITx) error {
			if lockErr := winnerTx.LockUser(ctx, locator.UserID); lockErr != nil {
				return lockErr
			}
			usage, lockErr := winnerTx.LockUsage(ctx, actionAIUOWGenerationID, locator.UserID)
			if lockErr != nil {
				return lockErr
			}
			if usage.FinalizedAt != nil || usage.SettlementReservationCostUSD != actionAIUOWReservation ||
				!usage.SettlementBudgetMonthUtc.Equal(actionAIUOWMonth(now)) {
				t.Fatalf("winner locked usage = %#v", usage)
			}
			if ensureErr := winnerTx.EnsureBudgetMonth(ctx, usage.SettlementBudgetMonthUtc, finalizedAt); ensureErr != nil {
				return ensureErr
			}
			rows, addErr := winnerTx.AddLateActualCostCAS(
				ctx, usage.SettlementBudgetMonthUtc, "0.03125000", finalizedAt,
			)
			if addErr != nil || rows != 1 {
				t.Fatalf("winner AddLateActualCostCAS rows/error = %d/%v", rows, addErr)
			}
			rows, finalizeErr := winnerTx.FinalizeLateUsageCAS(ctx, workspace.AIUsageSettlement{
				OperationID:                actionAIUOWGenerationID,
				ExpectedBudgetMonthUtc:     usage.SettlementBudgetMonthUtc,
				ExpectedReservationCostUSD: usage.SettlementReservationCostUSD,
				Status:                     "succeeded",
				InputTokens:                20,
				OutputTokens:               10,
				EstimatedCostUSD:           "0.03125000",
				FinalizedAt:                finalizedAt,
			})
			if finalizeErr != nil || rows != 1 {
				t.Fatalf("winner FinalizeLateUsageCAS rows/error = %d/%v", rows, finalizeErr)
			}
			return nil
		}); err != nil {
			return err
		}

		if err = staleTx.LockUser(ctx, locator.UserID); err != nil {
			return err
		}
		usage, err := staleTx.LockUsage(ctx, actionAIUOWGenerationID, locator.UserID)
		if err != nil {
			return err
		}
		if usage.FinalizedAt == nil || !usage.FinalizedAt.Equal(finalizedAt) ||
			!usage.SettlementBudgetMonthUtc.IsZero() || usage.SettlementReservationCostUSD != "" {
			t.Fatalf("stale transaction locked finalized usage = %#v", usage)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	var budgetActual string
	if err := pool.QueryRow(ctx, `SELECT actual_cost_usd::text FROM ai_budget_monthly
WHERE month_utc=$1`, actionAIUOWMonth(now)).Scan(&budgetActual); err != nil {
		t.Fatal(err)
	}
	if budgetActual != "0.03125000" {
		t.Fatalf("actual cost after stale callback convergence = %s", budgetActual)
	}
}

func seedActionAIUOWTarget(t *testing.T, pool *pgxpool.Pool, now time.Time) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, mustUUID(actionAIUOWUserID), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,revision,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,1,$3,$3)`, mustUUID(actionAIUOWGoalID), mustUUID(actionAIUOWUserID), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'Action AI test goal',$4,$5)`, mustUUID(actionAIUOWVersionID), mustUUID(actionAIUOWUserID),
		mustUUID(actionAIUOWGoalID), mustUUID(actionAIUOWVersionOperationID), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,plan,do_text,check_text,action,
 content_revision,plan_revision,do_revision,check_revision,action_revision,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,'P','D','C','manual Action',4,1,1,1,1,$6,'start-hash',$5,$5)`,
		mustUUID(actionAIUOWCycleID), mustUUID(actionAIUOWUserID), mustUUID(actionAIUOWGoalID),
		mustUUID(actionAIUOWVersionID), now, mustUUID(actionAIUOWStartOperationID)); err != nil {
		t.Fatal(err)
	}
}

func acceptActionAIUOWGeneration(t *testing.T, store *WorkspaceStore, leaseExpiresAt time.Time) {
	t.Helper()
	ctx := context.Background()
	now := integrationNow()
	month := actionAIUOWMonth(now)
	if err := store.WithinActionAITransaction(ctx, func(tx workspace.ActionAITx) error {
		if err := tx.LockUser(ctx, actionAIUOWUserID); err != nil {
			return err
		}
		if _, err := tx.LockGoalWithCurrentVersion(ctx, actionAIUOWUserID, actionAIUOWGoalID); err != nil {
			return err
		}
		current, err := tx.LockActionCycle(ctx, actionAIUOWUserID, actionAIUOWGoalID, actionAIUOWCycleID)
		if err != nil {
			return err
		}
		if current.Status != cycle.StatusActive || current.Revisions.Content != 4 {
			t.Fatalf("seeded current Cycle = %#v", current)
		}
		if err = tx.EnsureBudgetMonth(ctx, month, now); err != nil {
			return err
		}
		if _, err = tx.LockBudgetMonth(ctx, month); err != nil {
			return err
		}
		rows, err := tx.ReserveBudgetCAS(ctx, month, actionAIUOWReservation, now)
		if err != nil || rows != 1 {
			t.Fatalf("ReserveBudgetCAS rows/error = %d/%v", rows, err)
		}
		rows, err = tx.InsertActionAIGeneration(ctx, workspace.ActionAIGenerationRecord{
			ID:                         actionAIUOWGenerationID,
			UserID:                     actionAIUOWUserID,
			Operation:                  domainai.OperationActionGenerate,
			GoalID:                     actionAIUOWGoalID,
			GoalVersionID:              actionAIUOWVersionID,
			CycleID:                    actionAIUOWCycleID,
			TargetRevision:             current.Revisions.Content,
			IdempotencyKey:             actionAIUOWIdempotencyKey,
			IdempotencyRequestHash:     actionAIUOWRequestHash,
			CanonicalProviderInputHash: actionAIUOWCanonicalHash,
			Provider:                   "test-provider",
			Model:                      "test-model",
			PromptVersion:              "action-generate-v1",
			BudgetMonthUtc:             month,
			ReservedCostUSD:            actionAIUOWReservation,
			LeaseExpiresAt:             leaseExpiresAt,
			StartedAt:                  now,
			ContextCycleIDs:            []string{},
		})
		if err != nil || rows != 1 {
			t.Fatalf("InsertActionAIGeneration rows/error = %d/%v", rows, err)
		}
		rows, err = tx.InsertAcceptedUsage(ctx, workspace.AIUsageRecord{
			OperationID:                  actionAIUOWGenerationID,
			UserID:                       actionAIUOWUserID,
			GoalID:                       actionAIUOWGoalID,
			Operation:                    domainai.OperationActionGenerate,
			Provider:                     "test-provider",
			Model:                        "test-model",
			PromptVersion:                "action-generate-v1",
			AcceptedAt:                   now,
			QuotaRetainUntil:             workspace.AIUsageQuotaRetainUntil(now),
			SettlementBudgetMonthUtc:     month,
			SettlementReservationCostUSD: actionAIUOWReservation,
		})
		if err != nil || rows != 1 {
			t.Fatalf("InsertAcceptedUsage rows/error = %d/%v", rows, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func insertActionAIUOWHistoricalCycles(
	t *testing.T,
	pool *pgxpool.Pool,
	completedCycleID string,
	canceledCycleID string,
	now time.Time,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,completed_at,
 plan,do_text,check_text,action,content_revision,plan_revision,do_revision,check_revision,action_revision,
 start_operation_id,start_request_hash,completion_operation_id,completion_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,2,'completed',$5,$6,'P','D','C','A',4,1,1,1,1,$7,'completed-start',$8,'completed-finish',$5,$6)`,
		mustUUID(completedCycleID), mustUUID(actionAIUOWUserID), mustUUID(actionAIUOWGoalID), mustUUID(actionAIUOWVersionID),
		now.Add(-4*time.Hour), now.Add(-3*time.Hour), mustUUID("85000000-0000-7000-8000-000000000003"),
		mustUUID("85000000-0000-7000-8000-000000000004")); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,canceled_at,cancellation_reason,
 plan,do_text,check_text,action,content_revision,plan_revision,do_revision,check_revision,action_revision,
 start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,3,'canceled',$5,$6,'goal_ended','P','D','C','A',4,1,1,1,1,$7,'canceled-start',$5,$6)`,
		mustUUID(canceledCycleID), mustUUID(actionAIUOWUserID), mustUUID(actionAIUOWGoalID), mustUUID(actionAIUOWVersionID),
		now.Add(-2*time.Hour), now.Add(-time.Hour), mustUUID("85000000-0000-7000-8000-000000000005")); err != nil {
		t.Fatal(err)
	}
}

func deleteActionAIUOWTargetWithUnfinalizedUsage(t *testing.T, pool *pgxpool.Pool, now time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(ctx, tx)
	if _, err = tx.Exec(ctx, `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2::numeric,updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2::numeric`, actionAIUOWMonth(integrationNow()), actionAIUOWReservation, now); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='goal_deleted',
budget_reserved_cost_usd=0,lease_expires_at=NULL,finished_at=$2
WHERE id=$1 AND status='running' AND budget_reserved_cost_usd=$3::numeric`,
		mustUUID(actionAIUOWGenerationID), now, actionAIUOWReservation); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_usage_events
SET goal_id=NULL,status='failed',content_deleted=true
WHERE operation_id=$1 AND status='accepted' AND provider_usage_finalized_at IS NULL`,
		mustUUID(actionAIUOWGenerationID)); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM goals WHERE id=$1 AND user_id=$2`,
		mustUUID(actionAIUOWGoalID), mustUUID(actionAIUOWUserID)); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func assertActionAIUOWSettledState(t *testing.T, pool *pgxpool.Pool, output string, finishedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	var (
		action          string
		contentRevision int64
		actionRevision  int64
		lastAIRevision  int64
		modified        bool
		updatedAt       time.Time
	)
	if err := pool.QueryRow(ctx, `SELECT action,content_revision,action_revision,
action_last_ai_applied_content_revision,action_user_modified_after_ai,updated_at
FROM pdca_cycles WHERE id=$1`, mustUUID(actionAIUOWCycleID)).Scan(
		&action, &contentRevision, &actionRevision, &lastAIRevision, &modified, &updatedAt,
	); err != nil {
		t.Fatal(err)
	}
	var (
		aliasInputHash     string
		requestHash        string
		canonicalHash      string
		generationStatus   string
		generationOutput   string
		generationReserved string
		generationCost     string
		contextChanged     bool
		appliedAt          time.Time
		leaseCleared       bool
	)
	if err := pool.QueryRow(ctx, `SELECT input_hash,idempotency_request_hash,canonical_provider_input_hash,
status,output,budget_reserved_cost_usd::text,
estimated_cost_usd::text,context_changed,applied_at,lease_expires_at IS NULL
FROM ai_generations WHERE id=$1`, mustUUID(actionAIUOWGenerationID)).Scan(
		&aliasInputHash, &requestHash, &canonicalHash, &generationStatus, &generationOutput, &generationReserved,
		&generationCost, &contextChanged, &appliedAt, &leaseCleared,
	); err != nil {
		t.Fatal(err)
	}
	var (
		usageStatus    string
		usageCost      string
		usageFinalized time.Time
		exposureClear  bool
		budgetReserved string
		budgetActual   string
	)
	if err := pool.QueryRow(ctx, `SELECT status,estimated_cost_usd::text,provider_usage_finalized_at,
settlement_budget_month_utc IS NULL AND settlement_reservation_cost_usd IS NULL
FROM ai_usage_events WHERE operation_id=$1`, mustUUID(actionAIUOWGenerationID)).Scan(
		&usageStatus, &usageCost, &usageFinalized, &exposureClear,
	); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT reserved_cost_usd::text,actual_cost_usd::text FROM ai_budget_monthly
WHERE month_utc=$1`, actionAIUOWMonth(integrationNow())).Scan(&budgetReserved, &budgetActual); err != nil {
		t.Fatal(err)
	}
	if action != output || contentRevision != 5 || actionRevision != 2 || lastAIRevision != 5 || modified ||
		!updatedAt.Equal(finishedAt) || aliasInputHash != actionAIUOWRequestHash ||
		requestHash != actionAIUOWRequestHash || canonicalHash != actionAIUOWCanonicalHash || generationStatus != "succeeded" ||
		generationOutput != output || generationReserved != "0.00000000" || generationCost != "0.12500000" ||
		contextChanged || !appliedAt.Equal(finishedAt) || !leaseCleared || usageStatus != "succeeded" ||
		usageCost != "0.12500000" || !usageFinalized.Equal(finishedAt) || !exposureClear ||
		budgetReserved != "0.00000000" || budgetActual != "0.12500000" {
		t.Fatalf("settled state Cycle=%q/%d/%d/%d/%t/%v Hashes=%s/%s/%s Generation=%s/%s/%s/%s/%t/%v/%t Usage=%s/%s/%v/%t Budget=%s/%s",
			action, contentRevision, actionRevision, lastAIRevision, modified, updatedAt,
			aliasInputHash, requestHash, canonicalHash,
			generationStatus, generationOutput, generationReserved, generationCost, contextChanged, appliedAt,
			leaseCleared, usageStatus, usageCost, usageFinalized, exposureClear, budgetReserved, budgetActual)
	}
}

func assertActionAIUOWUserLastActiveAt(t *testing.T, pool *pgxpool.Pool, expected time.Time) {
	t.Helper()
	var actual time.Time
	if err := pool.QueryRow(context.Background(), `SELECT last_active_at FROM users WHERE id=$1`,
		mustUUID(actionAIUOWUserID)).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if !actual.Equal(expected) {
		t.Fatalf("last_active_at = %v, want %v", actual, expected)
	}
}

func actionAIUOWMonth(now time.Time) time.Time {
	return time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
}
