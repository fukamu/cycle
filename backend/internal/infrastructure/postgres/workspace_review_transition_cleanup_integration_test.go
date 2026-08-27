package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestReviewTransitionTerminateReviewAllowsAlreadyCleanedFinalizedUsage(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	ctx := context.Background()
	now := integrationNow()
	const (
		userID        = "10000000-0000-7000-8000-000000000001"
		reviewDraftID = "61000000-0000-7000-8000-000000000351"
		cleanedID     = "83000000-0000-7000-8000-000000000351"
		survivingID   = "83000000-0000-7000-8000-000000000352"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, store, userID, fixture, 2, reviewDraftID,
		"71000000-0000-7000-8000-000000000351", now)

	finalizedAt := now.Add(-time.Hour)
	type usageFixture struct {
		generationID string
		idempotency  string
		acceptedAt   time.Time
	}
	usages := []usageFixture{
		{
			generationID: cleanedID,
			idempotency:  "82000000-0000-7000-8000-000000000351",
			acceptedAt:   now.Add(-workspace.AIUsageRetentionDuration - time.Minute),
		},
		{
			generationID: survivingID,
			idempotency:  "82000000-0000-7000-8000-000000000352",
			acceptedAt:   now.Add(-workspace.AIUsageRetentionDuration + time.Second),
		},
	}
	for _, usage := range usages {
		month := time.Date(usage.acceptedAt.UTC().Year(), usage.acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
		if _, err := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,goal_id,goal_version_id,target_revision,idempotency_key,input_hash,
source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,$4,$5,0,$6,$7,'cleaned usage retention','fake','test','goal-v2',$8,0,
'provider_error',$9,$9)`, usage.generationID, userID, reviewDraftID, fixture.goalID, fixture.versionID,
			usage.idempotency, integrationAIRequestHash, month, usage.acceptedAt); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,
provider_usage_finalized_at,quota_retain_until)
VALUES($1,$2,$3,'goal_refine','failed','fake','test','goal-v2',$4,$5,$6)`,
			usage.generationID, userID, fixture.goalID, usage.acceptedAt, finalizedAt,
			workspace.AIUsageQuotaRetainUntil(usage.acceptedAt)); err != nil {
			t.Fatal(err)
		}
	}
	if command, err := pool.Exec(ctx, `DELETE FROM ai_usage_events
WHERE operation_id=$1 AND quota_retain_until<=$2 AND provider_usage_finalized_at IS NOT NULL`,
		cleanedID, now); err != nil {
		t.Fatal(err)
	} else if command.RowsAffected() != 1 {
		t.Fatalf("cleanup affected %d Usage rows, want 1", command.RowsAffected())
	}

	input := workspace.TerminateInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID: "72000000-0000-7000-8000-000000000351", Outcome: goal.StatusEnded,
		ExpectedGoalRevision: review.Goal.Revision, ExpectedState: goal.StatusGoalReview,
		Now: now,
	}
	terminated, err := executeTerminateGoalUseCase(store, ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if terminated.Replayed || terminated.Goal.Status != goal.StatusEnded ||
		terminated.Goal.Revision != review.Goal.Revision+1 || terminated.CanceledCycle != nil {
		t.Fatalf("Review termination result = %#v", terminated)
	}

	var goalStatus, terminalOperationID string
	var draftCount, generationCount, cleanedUsageCount, survivingUsageCount int
	var survivingGoalCleared, survivingContentDeleted bool
	if err = pool.QueryRow(ctx, `SELECT
g.status::text,g.terminal_operation_id::text,
(SELECT count(*) FROM goal_drafts WHERE id=$3),
(SELECT count(*) FROM ai_generations WHERE source_goal_draft_id=$3),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$4),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$5),
(SELECT goal_id IS NULL FROM ai_usage_events WHERE operation_id=$5),
(SELECT content_deleted FROM ai_usage_events WHERE operation_id=$5)
FROM goals g WHERE g.user_id=$1 AND g.id=$2`,
		userID, fixture.goalID, reviewDraftID, cleanedID, survivingID).Scan(
		&goalStatus, &terminalOperationID, &draftCount, &generationCount,
		&cleanedUsageCount, &survivingUsageCount, &survivingGoalCleared, &survivingContentDeleted); err != nil {
		t.Fatal(err)
	}
	if goalStatus != string(goal.StatusEnded) || terminalOperationID != input.OperationID ||
		draftCount != 0 || generationCount != 0 || cleanedUsageCount != 0 ||
		survivingUsageCount != 1 || !survivingGoalCleared || !survivingContentDeleted {
		t.Fatalf("cleaned-Usage termination state = status %s terminalOp %s Draft/Generation/cleaned/surviving %d/%d/%d/%d surviving cleared/redacted %t/%t",
			goalStatus, terminalOperationID, draftCount, generationCount, cleanedUsageCount,
			survivingUsageCount, survivingGoalCleared, survivingContentDeleted)
	}
}
