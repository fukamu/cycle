package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestWorkspaceReplanPersistsAtomicTupleAndReplaysOwnerScopedReceipt(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)

	now := integrationNow()
	const (
		userID        = "10000000-0000-7000-8000-000000000001"
		otherUserID   = "10000000-0000-7000-8000-000000000002"
		successorID   = "41000000-0000-7000-8000-000000000007"
		operationID   = "61000000-0000-7000-8000-000000000001"
		progressLimit = 2
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	insertAIConcurrencyUser(t, pool, otherUserID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, progressLimit, now)
	replannedAt := now.Add(time.Minute)
	useCases := newCycleApplicationTestUseCases(store, replannedAt, successorID)
	if _, err := useCases.SaveFrame(t.Context(), workspace.SaveFrameInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		Frame: cycle.FramePlan, Content: "次の実験前に前提を見直す", ExpectedFrameRevision: 0,
	}); err != nil {
		t.Fatal(err)
	}
	reviewDate, err := cycle.ParseReviewDate("2026-09-30")
	if err != nil {
		t.Fatal(err)
	}
	scheduled, err := useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ReviewDate: &reviewDate, ExpectedReviewScheduleRevision: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	source := scheduled.Cycle
	input := workspace.ReplanCycleInput{
		UserID:                         userID,
		GoalID:                         fixture.goalID,
		CycleID:                        fixture.cycleID,
		OperationID:                    operationID,
		ExpectedGoalRevision:           started.Goal.Revision,
		ExpectedContentRevision:        source.ContentRevision,
		ExpectedReviewScheduleRevision: source.ReviewScheduleRevision,
		Confirmed:                      true,
	}

	result, err := useCases.ReplanCycle(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	assertFreshReplanResult(t, result, started, source, fixture, successorID, replannedAt)
	assertFreshReplanDatabaseTuple(t, pool, userID, started, source, fixture, successorID, replannedAt)

	receipt := findReplanReceipt(t, store, userID, operationID)
	if receipt == nil || receipt.GoalID != fixture.goalID || receipt.CycleID != successorID ||
		receipt.ReplannedCycleID != fixture.cycleID || receipt.RequestHash == "" ||
		receipt.ReplannedCancellationReason == nil ||
		*receipt.ReplannedCancellationReason != cycle.CancellationReplanned {
		t.Fatalf("Replan receipt = %#v, want exact successor/source provenance", receipt)
	}
	if foreign := findReplanReceipt(t, store, otherUserID, operationID); foreign != nil {
		t.Fatalf("foreign owner Replan receipt = %#v, want nil", foreign)
	}

	replayed, err := useCases.ReplanCycle(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed.Replayed || replayed.CanceledCycle.ID != fixture.cycleID ||
		replayed.Cycle.ID != successorID || replayed.Goal.ID != fixture.goalID ||
		replayed.Goal.Revision != result.Goal.Revision {
		t.Fatalf("Replan replay = %#v, want original committed tuple", replayed)
	}
	assertFreshReplanDatabaseTuple(t, pool, userID, started, source, fixture, successorID, replannedAt)

	if _, err = useCases.SaveFrame(t.Context(), workspace.SaveFrameInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: successorID,
		Frame: cycle.FramePlan, Content: "再計画後に保存したPlan", ExpectedFrameRevision: 0,
	}); err != nil {
		t.Fatal(err)
	}
	successorReviewDate, err := cycle.ParseReviewDate("2026-10-01")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = useCases.ChangeReviewSchedule(t.Context(), workspace.ChangeReviewScheduleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: successorID,
		ReviewDate: &successorReviewDate, ExpectedReviewScheduleRevision: 0,
	}); err != nil {
		t.Fatal(err)
	}
	replayedAfterProgress, err := useCases.ReplanCycle(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !replayedAfterProgress.Replayed || replayedAfterProgress.Cycle.ID != successorID ||
		replayedAfterProgress.Cycle.Plan != "再計画後に保存したPlan" ||
		replayedAfterProgress.Cycle.ContentRevision != 1 || replayedAfterProgress.Cycle.ReviewDate == nil ||
		*replayedAfterProgress.Cycle.ReviewDate != successorReviewDate ||
		replayedAfterProgress.Cycle.ReviewScheduleRevision != 1 ||
		replayedAfterProgress.Goal.CurrentWork == nil ||
		replayedAfterProgress.Goal.CurrentWork.CycleID != successorID {
		t.Fatalf("Replan replay after successor progress = %#v, want current successor state", replayedAfterProgress)
	}
}

func TestWorkspaceReplanRollsBackPriorWritesWhenGoalCASLoses(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)

	now := integrationNow()
	const (
		userID      = "10000000-0000-7000-8000-000000000001"
		successorID = "41000000-0000-7000-8000-000000000007"
		operationID = "61000000-0000-7000-8000-000000000001"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, 2, now)
	mismatchUOW := &replanGoalCASMismatchUOW{store: store}
	useCases := workspace.NewCycleUseCases(
		store,
		mismatchUOW,
		cycleApplicationTestClock{now: now.Add(time.Minute)},
		&cycleApplicationTestIDs{items: []string{successorID}},
		workspace.CycleUseCaseSettings{CursorSigningKey: []byte("replan-rollback-test-cursor-key")},
	)

	_, err := useCases.ReplanCycle(t.Context(), workspace.ReplanCycleInput{
		UserID:                         userID,
		GoalID:                         fixture.goalID,
		CycleID:                        fixture.cycleID,
		OperationID:                    operationID,
		ExpectedGoalRevision:           started.Goal.Revision,
		ExpectedContentRevision:        started.Cycle.ContentRevision,
		ExpectedReviewScheduleRevision: started.Cycle.ReviewScheduleRevision,
		Confirmed:                      true,
	})
	if !errors.Is(err, workspace.ErrCyclePersistenceInvariant) || !mismatchUOW.casCalled {
		t.Fatalf("Replan Goal CAS loss error/called = %v/%t, want persistence invariant after real CAS", err, mismatchUOW.casCalled)
	}
	assertReplanDatabaseRolledBack(t, pool, userID, started, fixture, operationID)
	if receipt := findReplanReceipt(t, store, userID, operationID); receipt != nil {
		t.Fatalf("rolled-back Replan receipt = %#v, want nil", receipt)
	}
}

type replanGoalCASMismatchUOW struct {
	store     *WorkspaceStore
	casCalled bool
}

func (uow *replanGoalCASMismatchUOW) WithinCycleTransaction(
	ctx context.Context,
	operation func(workspace.CycleTx) error,
) error {
	return uow.store.WithinCycleTransaction(ctx, func(transaction workspace.CycleTx) error {
		return operation(&replanGoalCASMismatchTx{CycleTx: transaction, owner: uow})
	})
}

type replanGoalCASMismatchTx struct {
	workspace.CycleTx
	owner *replanGoalCASMismatchUOW
}

func (transaction *replanGoalCASMismatchTx) ReplanGoalCAS(
	ctx context.Context,
	replanned goal.Goal,
	expectedRevision int64,
) (int64, error) {
	transaction.owner.casCalled = true
	replanned.CurrentVersionNumber++
	return transaction.CycleTx.ReplanGoalCAS(ctx, replanned, expectedRevision)
}

func findReplanReceipt(
	t *testing.T,
	store *WorkspaceStore,
	userID, operationID string,
) *workspace.ReplanCycleReceipt {
	t.Helper()
	var receipt *workspace.ReplanCycleReceipt
	if err := store.WithinCycleTransaction(t.Context(), func(transaction workspace.CycleTx) error {
		var err error
		receipt, err = transaction.FindReplanCycleReceipt(t.Context(), userID, operationID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return receipt
}

func assertFreshReplanResult(
	t *testing.T,
	result workspace.ReplanCycleResult,
	started workspace.StartGoalResult,
	source workspace.CycleView,
	fixture progressingGoalFixture,
	successorID string,
	replannedAt time.Time,
) {
	t.Helper()
	if result.Replayed || result.CanceledCycle.ID != fixture.cycleID ||
		result.CanceledCycle.Status != cycle.StatusCanceled || result.CanceledCycle.CanceledAt == nil ||
		!result.CanceledCycle.CanceledAt.Equal(replannedAt) || result.CanceledCycle.CancellationReason == nil ||
		*result.CanceledCycle.CancellationReason != cycle.CancellationReplanned ||
		result.CanceledCycle.Plan != source.Plan || result.CanceledCycle.ContentRevision != source.ContentRevision ||
		result.CanceledCycle.FrameRevisions != source.FrameRevisions ||
		result.CanceledCycle.ReviewDate == nil || source.ReviewDate == nil ||
		*result.CanceledCycle.ReviewDate != *source.ReviewDate ||
		result.CanceledCycle.ReviewScheduleRevision != source.ReviewScheduleRevision ||
		result.Cycle.ID != successorID || result.Cycle.Status != cycle.StatusActive ||
		result.Cycle.SequenceNumber != started.Cycle.SequenceNumber+1 ||
		result.Cycle.GoalVersion.ID != started.Cycle.GoalVersion.ID || result.Cycle.ContentRevision != 0 ||
		result.Cycle.FrameRevisions != (workspace.FrameRevisions{}) || result.Cycle.Plan != "" || result.Cycle.Do != "" ||
		result.Cycle.Check != "" || result.Cycle.Action != "" || result.Cycle.ReviewDate != nil ||
		result.Cycle.ReviewScheduleRevision != 0 || result.Goal.ID != fixture.goalID ||
		result.Goal.Status != goal.StatusActiveCycle || result.Goal.Revision != started.Goal.Revision+1 ||
		result.Goal.NextCycleSequenceNumber != started.Goal.NextCycleSequenceNumber+1 || result.Goal.CurrentWork == nil ||
		result.Goal.CurrentWork.Kind != "active_cycle" || result.Goal.CurrentWork.CycleID != successorID {
		t.Fatalf("fresh Replan result = %#v, want one canceled source and one empty active successor", result)
	}
}

func assertFreshReplanDatabaseTuple(
	t *testing.T,
	pool *pgxpool.Pool,
	userID string,
	started workspace.StartGoalResult,
	source workspace.CycleView,
	fixture progressingGoalFixture,
	successorID string,
	replannedAt time.Time,
) {
	t.Helper()
	var totalCycles, matchingSource, matchingSuccessor, activeCycles int64
	if err := pool.QueryRow(t.Context(), `SELECT
    count(*),
    count(*) FILTER (WHERE id=$3 AND sequence_number=$5 AND status='canceled'
        AND canceled_at=$7 AND cancellation_reason='replanned'),
    count(*) FILTER (WHERE id=$4 AND sequence_number=$6 AND status='active'
        AND goal_version_id=$8 AND started_at=$7 AND completed_at IS NULL AND canceled_at IS NULL
        AND cancellation_reason IS NULL AND plan='' AND do_text='' AND check_text='' AND action=''
        AND content_revision=0 AND plan_revision=0 AND do_revision=0 AND check_revision=0 AND action_revision=0),
    count(*) FILTER (WHERE status='active')
FROM public.pdca_cycles
WHERE user_id=$1 AND goal_id=$2`,
		userID,
		fixture.goalID,
		fixture.cycleID,
		successorID,
		started.Cycle.SequenceNumber,
		started.Cycle.SequenceNumber+1,
		replannedAt,
		started.Cycle.GoalVersion.ID,
	).Scan(&totalCycles, &matchingSource, &matchingSuccessor, &activeCycles); err != nil {
		t.Fatal(err)
	}
	if totalCycles != 2 || matchingSource != 1 || matchingSuccessor != 1 || activeCycles != 1 {
		t.Fatalf("Replan DB Cycle tuple total/source/successor/active = %d/%d/%d/%d, want 2/1/1/1",
			totalCycles, matchingSource, matchingSuccessor, activeCycles)
	}

	var status string
	var currentVersion, nextSequence int32
	var revision int64
	if err := pool.QueryRow(t.Context(), `SELECT status,current_version_number,next_cycle_sequence_number,revision
FROM public.goals WHERE user_id=$1 AND id=$2`,
		userID, fixture.goalID,
	).Scan(&status, &currentVersion, &nextSequence, &revision); err != nil {
		t.Fatal(err)
	}
	if status != string(goal.StatusActiveCycle) || currentVersion != started.Goal.CurrentVersion.VersionNumber ||
		nextSequence != started.Goal.NextCycleSequenceNumber+1 || revision != started.Goal.Revision+1 {
		t.Fatalf("Replan DB Goal = %s/v%d/next%d/rev%d, want active unchanged Version and advanced counters",
			status, currentVersion, nextSequence, revision)
	}

	var successorScheduleRows int64
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM public.pdca_cycle_review_schedules WHERE cycle_id=$1`,
		successorID,
	).Scan(&successorScheduleRows); err != nil {
		t.Fatal(err)
	}
	if successorScheduleRows != 0 {
		t.Fatalf("successor review schedule rows = %d, want 0", successorScheduleRows)
	}
	var sourceReviewDate pgtype.Date
	var sourceReviewRevision int64
	if err := pool.QueryRow(t.Context(), `SELECT review_date,review_schedule_revision
FROM public.pdca_cycle_review_schedules WHERE cycle_id=$1`, fixture.cycleID,
	).Scan(&sourceReviewDate, &sourceReviewRevision); err != nil {
		t.Fatal(err)
	}
	if source.ReviewDate == nil || !sourceReviewDate.Valid ||
		sourceReviewDate.Time.Format("2006-01-02") != string(*source.ReviewDate) ||
		sourceReviewRevision != source.ReviewScheduleRevision {
		t.Fatalf("source review schedule = %#v/rev%d, want %v/rev%d",
			sourceReviewDate, sourceReviewRevision, source.ReviewDate, source.ReviewScheduleRevision)
	}
}

func assertReplanDatabaseRolledBack(
	t *testing.T,
	pool *pgxpool.Pool,
	userID string,
	started workspace.StartGoalResult,
	fixture progressingGoalFixture,
	operationID string,
) {
	t.Helper()
	var status string
	var canceledAt pgtype.Timestamptz
	var reason *string
	var totalCycles, operationCycles int64
	if err := pool.QueryRow(t.Context(), `SELECT
    source.status,source.canceled_at,source.cancellation_reason,
    (SELECT count(*) FROM public.pdca_cycles WHERE user_id=$1 AND goal_id=$2),
    (SELECT count(*) FROM public.pdca_cycles WHERE user_id=$1 AND start_operation_id=$4)
FROM public.pdca_cycles AS source
WHERE source.user_id=$1 AND source.goal_id=$2 AND source.id=$3`,
		userID,
		fixture.goalID,
		fixture.cycleID,
		operationID,
	).Scan(&status, &canceledAt, &reason, &totalCycles, &operationCycles); err != nil {
		t.Fatal(err)
	}
	if status != string(cycle.StatusActive) || canceledAt.Valid || reason != nil || totalCycles != 1 || operationCycles != 0 {
		t.Fatalf("rolled-back Cycle status/canceled/reason/total/receipt = %s/%#v/%v/%d/%d",
			status, canceledAt, reason, totalCycles, operationCycles)
	}

	var goalStatus string
	var nextSequence int32
	var revision int64
	if err := pool.QueryRow(t.Context(), `SELECT status,next_cycle_sequence_number,revision
FROM public.goals WHERE user_id=$1 AND id=$2`,
		userID, fixture.goalID,
	).Scan(&goalStatus, &nextSequence, &revision); err != nil {
		t.Fatal(err)
	}
	if goalStatus != string(goal.StatusActiveCycle) || nextSequence != started.Goal.NextCycleSequenceNumber ||
		revision != started.Goal.Revision {
		t.Fatalf("rolled-back Goal = %s/next%d/rev%d, want original", goalStatus, nextSequence, revision)
	}
}
