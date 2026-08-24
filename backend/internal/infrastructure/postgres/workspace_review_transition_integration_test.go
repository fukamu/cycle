package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type continueReviewIntegrationCall struct {
	result workspace.ContinueReviewResult
	err    error
}

func TestReviewTransitionContinueDoubleTapAndReplay(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, store, userID, fixture, 2,
		"61000000-0000-7000-8000-000000000101",
		"71000000-0000-7000-8000-000000000101", now)
	input := workspace.ContinueReviewInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID:          "72000000-0000-7000-8000-000000000101",
		ExpectedGoalRevision: review.Goal.Revision, ExpectedDraftRevision: review.ReviewDraft.Revision,
		CycleID: "41000000-0000-7000-8000-000000000101", Now: now.Add(3 * time.Minute),
	}

	barrier := newContinueContentionBarrier(isContinueGoalLockQuery)
	store, tracedPool := newContinueContentionStore(t, pool, barrier)
	defer tracedPool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.releaseInitialLookups()
		barrier.releaseLeaderQuery()
		cancel()
	}()
	calls := make(chan continueReviewIntegrationCall, 2)
	for range 2 {
		attemptCtx := context.WithValue(ctx, continueContentionContextKey{}, &continueContentionAttempt{})
		go func() {
			result, err := executeContinueReviewUseCase(store, attemptCtx, input)
			calls <- continueReviewIntegrationCall{result: result, err: err}
		}()
	}
	waitForContinueContention(t, ctx, pool, barrier)
	fresh, replayed := 0, 0
	for range 2 {
		call := <-calls
		if call.err != nil {
			t.Fatalf("double-tap Continue error = %v", call.err)
		}
		if call.result.Goal.ID != fixture.goalID || call.result.Cycle.ID != input.CycleID {
			t.Fatalf("double-tap Continue result = %#v", call.result)
		}
		if call.result.Replayed {
			replayed++
		} else {
			fresh++
		}
	}
	if fresh != 1 || replayed != 1 {
		t.Fatalf("double-tap fresh/replayed = %d/%d, want 1/1", fresh, replayed)
	}

	replay, err := executeContinueReviewUseCase(store, context.Background(), input)
	if err != nil || !replay.Replayed || replay.Cycle.ID != input.CycleID {
		t.Fatalf("Continue replay = %#v, error = %v", replay, err)
	}
	different := input
	different.ExpectedDraftRevision++
	if _, err = executeContinueReviewUseCase(store, context.Background(), different); !errors.Is(err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("Continue different-hash error = %v, want %v", err, workspace.ErrIdempotencyKeyReused)
	}
	var cycleCount, reviewDraftCount int
	if err = pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND start_operation_id=$2),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND goal_id=$3 AND draft_type='review')`,
		userID, input.OperationID, fixture.goalID).Scan(&cycleCount, &reviewDraftCount); err != nil {
		t.Fatal(err)
	}
	if cycleCount != 1 || reviewDraftCount != 0 {
		t.Fatalf("Continue persisted Cycle/Review Draft counts = %d/%d, want 1/0", cycleCount, reviewDraftCount)
	}
}

func TestReviewTransitionContinueSameOperationDifferentGoalsClassifiesClaim(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixtures := progressingGoalFixtures()
	first := prepareReviewTransitionReview(t, store, userID, fixtures[0], 2,
		"61000000-0000-7000-8000-000000000201",
		"71000000-0000-7000-8000-000000000201", now)
	second := prepareReviewTransitionReview(t, store, userID, fixtures[1], 2,
		"61000000-0000-7000-8000-000000000202",
		"71000000-0000-7000-8000-000000000202", now.Add(time.Minute))
	const operationID = "72000000-0000-7000-8000-000000000201"
	inputs := []workspace.ContinueReviewInput{
		{UserID: userID, GoalID: fixtures[0].goalID, OperationID: operationID,
			ExpectedGoalRevision: first.Goal.Revision, ExpectedDraftRevision: first.ReviewDraft.Revision,
			CycleID: "41000000-0000-7000-8000-000000000201", Now: now.Add(4 * time.Minute)},
		{UserID: userID, GoalID: fixtures[1].goalID, OperationID: operationID,
			ExpectedGoalRevision: second.Goal.Revision, ExpectedDraftRevision: second.ReviewDraft.Revision,
			CycleID: "41000000-0000-7000-8000-000000000202", Now: now.Add(4 * time.Minute)},
	}
	barrier := newContinueContentionBarrier(isContinueClaimQuery)
	store, tracedPool := newContinueContentionStore(t, pool, barrier)
	defer tracedPool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.releaseInitialLookups()
		barrier.releaseLeaderQuery()
		cancel()
	}()
	calls := make(chan continueReviewIntegrationCall, 2)
	for _, input := range inputs {
		input := input
		attemptCtx := context.WithValue(ctx, continueContentionContextKey{}, &continueContentionAttempt{})
		go func() {
			result, err := executeContinueReviewUseCase(store, attemptCtx, input)
			calls <- continueReviewIntegrationCall{result: result, err: err}
		}()
	}
	waitForContinueContention(t, ctx, pool, barrier)
	successes, reused := 0, 0
	for range 2 {
		call := <-calls
		switch {
		case call.err == nil:
			successes++
		case errors.Is(call.err, workspace.ErrIdempotencyKeyReused):
			reused++
		default:
			t.Fatalf("different-Goal Continue error = %v", call.err)
		}
	}
	if successes != 1 || reused != 1 {
		t.Fatalf("different-Goal Continue success/reused = %d/%d, want 1/1", successes, reused)
	}
	var operationCycles, activeGoals, reviewGoals int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND start_operation_id=$2),
(SELECT count(*) FROM goals WHERE user_id=$1 AND status='active_cycle'),
(SELECT count(*) FROM goals WHERE user_id=$1 AND status='goal_review')`,
		userID, operationID).Scan(&operationCycles, &activeGoals, &reviewGoals); err != nil {
		t.Fatal(err)
	}
	if operationCycles != 1 || activeGoals != 1 || reviewGoals != 1 {
		t.Fatalf("different-Goal operation/active/review counts = %d/%d/%d, want 1/1/1",
			operationCycles, activeGoals, reviewGoals)
	}
}

func TestReviewTransitionTerminatesReviewWithExactUsageRetention(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	ctx := context.Background()
	now := integrationNow()
	const (
		userID        = "10000000-0000-7000-8000-000000000001"
		reviewDraftID = "61000000-0000-7000-8000-000000000301"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, store, userID, fixture, 2, reviewDraftID,
		"71000000-0000-7000-8000-000000000301", now)
	finalizedAt := now.Add(-time.Hour)
	type usageFixture struct {
		generationID string
		idempotency  string
		acceptedAt   time.Time
		finalizedAt  *time.Time
	}
	usages := []usageFixture{
		{"83000000-0000-7000-8000-000000000301", "82000000-0000-7000-8000-000000000301", now.Add(-workspace.AIUsageRetentionDuration + time.Second), &finalizedAt},
		{"83000000-0000-7000-8000-000000000302", "82000000-0000-7000-8000-000000000302", now.Add(-workspace.AIUsageRetentionDuration), &finalizedAt},
		{"83000000-0000-7000-8000-000000000303", "82000000-0000-7000-8000-000000000303", now.Add(-workspace.AIUsageRetentionDuration - time.Second), nil},
	}
	for _, usage := range usages {
		month := time.Date(usage.acceptedAt.UTC().Year(), usage.acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
		if _, err := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,goal_id,goal_version_id,target_revision,idempotency_key,input_hash,
source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,$4,$5,0,$6,$7,'review retention','fake','test','goal-v2',$8,0,
'provider_error',$9,$9)`, usage.generationID, userID, reviewDraftID, fixture.goalID, fixture.versionID,
			usage.idempotency, "hash-"+usage.generationID, month, usage.acceptedAt); err != nil {
			t.Fatal(err)
		}
		if usage.finalizedAt == nil {
			if _, err := pool.Exec(ctx, `UPDATE ai_generations SET status='running',failure_code=NULL,
lease_expires_at=$2,finished_at=NULL WHERE id=$1`, usage.generationID, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,
provider_usage_finalized_at,quota_retain_until)
VALUES($1,$2,$3,'goal_refine','failed','fake','test','goal-v2',$4,$5,$6)`,
			usage.generationID, userID, fixture.goalID, usage.acceptedAt, usage.finalizedAt,
			workspace.AIUsageQuotaRetainUntil(usage.acceptedAt)); err != nil {
			t.Fatal(err)
		}
		if usage.finalizedAt == nil {
			if _, err := pool.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='provider_error',
lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, usage.generationID, now); err != nil {
				t.Fatal(err)
			}
		}
	}

	input := workspace.TerminateInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID: "72000000-0000-7000-8000-000000000301", Outcome: goal.StatusEnded,
		ExpectedGoalRevision: review.Goal.Revision, ExpectedState: goal.StatusGoalReview,
		Now: now,
	}
	terminated, err := executeTerminateGoalUseCase(store, ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if terminated.Replayed || terminated.Goal.Status != goal.StatusEnded || terminated.CanceledCycle != nil ||
		terminated.Goal.CurrentVersion.ID != fixture.versionID ||
		terminated.Goal.CurrentVersion.VersionNumber != 1 {
		t.Fatalf("Review termination result = %#v", terminated)
	}
	replay, err := executeTerminateGoalUseCase(store, ctx, input)
	if err != nil || !replay.Replayed || replay.CanceledCycle != nil {
		t.Fatalf("Review termination replay = %#v, error = %v", replay, err)
	}

	var draftCount, generationCount, cycleCount, versionCount int
	if err = pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM goal_drafts WHERE id=$1),
(SELECT count(*) FROM ai_generations WHERE source_goal_draft_id=$1),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$2 AND goal_id=$3),
(SELECT count(*) FROM goal_versions WHERE user_id=$2 AND goal_id=$3)`,
		reviewDraftID, userID, fixture.goalID).Scan(
		&draftCount, &generationCount, &cycleCount, &versionCount); err != nil {
		t.Fatal(err)
	}
	if draftCount != 0 || generationCount != 0 || cycleCount != 1 || versionCount != 1 {
		t.Fatalf("post-termination Draft/generations/Cycles/Versions = %d/%d/%d/%d, want 0/0/1/1",
			draftCount, generationCount, cycleCount, versionCount)
	}
	rows, err := pool.Query(ctx, `SELECT operation_id,goal_id IS NULL,content_deleted
FROM ai_usage_events WHERE user_id=$1 ORDER BY operation_id`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	retained := []string{}
	for rows.Next() {
		var operationID string
		var goalCleared, contentDeleted bool
		if err = rows.Scan(&operationID, &goalCleared, &contentDeleted); err != nil {
			t.Fatal(err)
		}
		if !goalCleared || !contentDeleted {
			t.Fatalf("retained Usage %s clear/redacted = %t/%t", operationID, goalCleared, contentDeleted)
		}
		retained = append(retained, operationID)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{usages[0].generationID, usages[2].generationID}
	if len(retained) != len(want) || retained[0] != want[0] || retained[1] != want[1] {
		t.Fatalf("retained Usage IDs = %v, want %v", retained, want)
	}
	var settlementMonth time.Time
	var settlementReservation string
	var stillUnfinalized bool
	if err = pool.QueryRow(ctx, `SELECT settlement_budget_month_utc,
settlement_reservation_cost_usd::text,provider_usage_finalized_at IS NULL
FROM ai_usage_events WHERE operation_id=$1`, usages[2].generationID).Scan(
		&settlementMonth, &settlementReservation, &stillUnfinalized); err != nil {
		t.Fatal(err)
	}
	wantMonth := time.Date(usages[2].acceptedAt.UTC().Year(), usages[2].acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	if !settlementMonth.Equal(wantMonth) || settlementReservation != "0.00000000" || !stillUnfinalized {
		t.Fatalf("unfinalized retained Usage settlement = %s/%s/unfinalized=%t, want %s/0.00000000/true",
			settlementMonth, settlementReservation, stillUnfinalized, wantMonth)
	}
}

func prepareReviewTransitionReview(
	t *testing.T,
	store *WorkspaceStore,
	userID string,
	fixture progressingGoalFixture,
	maxProgressing int,
	reviewDraftID string,
	completeOperationID string,
	now time.Time,
) workspace.CompleteCycleResult {
	t.Helper()
	started := startProgressingGoal(t, store, userID, fixture, maxProgressing, now)
	for _, frame := range []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		if _, err := executeCycleSaveUseCase(store, context.Background(), workspace.SaveFrameInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			Frame: frame, Content: string(frame), ExpectedFrameRevision: 0, Now: now.Add(time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	completed, err := executeCycleCompleteUseCase(store, context.Background(), workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID, ReviewDraftID: reviewDraftID,
		OperationID: completeOperationID, ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		Now: now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	return completed
}
