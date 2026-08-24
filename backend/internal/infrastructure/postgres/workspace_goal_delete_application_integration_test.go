package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoalDeleteApplicationPartitionsUsageAtExactRetentionDeadline(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID             = "10000000-0000-7000-8000-000000000001"
		retainedUsageID    = "88000000-0000-7000-8000-000000000001"
		expiredUsageID     = "88000000-0000-7000-8000-000000000002"
		unfinalizedUsageID = "88000000-0000-7000-8000-000000000003"
		deleteKey          = "89000000-0000-7000-8000-000000000001"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool, aiConcurrencySettings())
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, 2, now.Add(-48*time.Hour))

	insertFinalizedGoalDeleteUsage(t, pool, retainedUsageID, userID, fixture.goalID,
		now.Add(-workspace.AIUsageRetentionDuration+time.Second), now.Add(-time.Minute))
	insertFinalizedGoalDeleteUsage(t, pool, expiredUsageID, userID, fixture.goalID,
		now.Add(-workspace.AIUsageRetentionDuration), now.Add(-time.Minute))
	insertUnfinalizedGoalDeleteUsage(t, pool, unfinalizedUsageID, userID, fixture, now)

	if err := executeGoalDeleteUseCase(
		store, context.Background(), userID, fixture.goalID, true, started.Goal.Revision, deleteKey, now,
	); err != nil {
		t.Fatalf("DeleteGoal: %v", err)
	}

	var goalCount, expiredCount, receiptCount int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM goals WHERE id=$1 AND user_id=$2),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$3),
(SELECT count(*) FROM goal_delete_receipts WHERE user_id=$2 AND idempotency_key=$4)`,
		fixture.goalID, userID, expiredUsageID, deleteKey,
	).Scan(&goalCount, &expiredCount, &receiptCount); err != nil {
		t.Fatal(err)
	}
	if goalCount != 0 || expiredCount != 0 || receiptCount != 1 {
		t.Fatalf("Goal/expired Usage/receipt counts = %d/%d/%d, want 0/0/1", goalCount, expiredCount, receiptCount)
	}

	assertRedactedGoalDeleteUsage(t, pool, retainedUsageID, true)
	assertRedactedGoalDeleteUsage(t, pool, unfinalizedUsageID, false)
}

func insertFinalizedGoalDeleteUsage(
	t *testing.T,
	pool *pgxpool.Pool,
	operationID, userID, goalID string,
	acceptedAt, finalizedAt time.Time,
) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,
accepted_at,provider_usage_finalized_at,quota_retain_until)
VALUES($1,$2,$3,'action_generate','succeeded','fake','test','action-generate-v1',$4,$5,$6)`,
		operationID, userID, goalID, acceptedAt, finalizedAt, workspace.AIUsageQuotaRetainUntil(acceptedAt),
	); err != nil {
		t.Fatal(err)
	}
}

func insertUnfinalizedGoalDeleteUsage(
	t *testing.T,
	pool *pgxpool.Pool,
	operationID, userID string,
	fixture progressingGoalFixture,
	now time.Time,
) {
	t.Helper()
	settings := aiConcurrencySettings()
	month := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,goal_id,goal_version_id,cycle_id,target_revision,
idempotency_key,input_hash,source_text,provider,model,prompt_version,budget_month_utc,
budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'action_generate','running',NULL,$3,$4,$5,0,$6,$7,NULL,$8,$9,$10,$11,0,$12,$13)`,
		operationID, userID, fixture.goalID, fixture.versionID, fixture.cycleID,
		"8a000000-0000-7000-8000-000000000001", "goal-delete-unfinalized-usage",
		settings.Provider, settings.Model, settings.GeneratePromptVersion, month, now.Add(time.Minute), now,
	); err != nil {
		t.Fatal(err)
	}
	acceptedAt := now.Add(-workspace.AIUsageRetentionDuration)
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES($1,$2,$3,'action_generate','accepted',$4,$5,$6,$7,$8)`,
		operationID, userID, fixture.goalID, settings.Provider, settings.Model, settings.GeneratePromptVersion,
		acceptedAt, workspace.AIUsageQuotaRetainUntil(acceptedAt),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_generations
SET status='failed',failure_code='lease_expired',lease_expires_at=NULL,finished_at=$2
WHERE id=$1`, operationID, now.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_usage_events SET status='failed' WHERE operation_id=$1`, operationID); err != nil {
		t.Fatal(err)
	}
}

func assertRedactedGoalDeleteUsage(t *testing.T, pool *pgxpool.Pool, operationID string, finalized bool) {
	t.Helper()
	var (
		goalID                    *string
		status                    string
		contentDeleted            bool
		providerUsageFinalized    bool
		settlementMetadataPresent bool
	)
	if err := pool.QueryRow(context.Background(), `SELECT goal_id::text,status,content_deleted,
provider_usage_finalized_at IS NOT NULL,
settlement_budget_month_utc IS NOT NULL AND settlement_reservation_cost_usd IS NOT NULL
FROM ai_usage_events WHERE operation_id=$1`, operationID).Scan(
		&goalID, &status, &contentDeleted, &providerUsageFinalized, &settlementMetadataPresent,
	); err != nil {
		t.Fatal(err)
	}
	expectedStatus := "failed"
	if finalized {
		expectedStatus = "succeeded"
	}
	if goalID != nil || status != expectedStatus || !contentDeleted || providerUsageFinalized != finalized ||
		settlementMetadataPresent == finalized {
		t.Fatalf("redacted Usage %s = goal %v, status %s, deleted %t, finalized %t, metadata %t",
			operationID, goalID, status, contentDeleted, providerUsageFinalized, settlementMetadataPresent)
	}
}
