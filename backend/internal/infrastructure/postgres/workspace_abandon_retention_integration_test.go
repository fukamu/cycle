package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

func TestAbandonDraftAppliesRetentionDeadlineAndPreservesLateSettlement(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	ctx := context.Background()
	now := integrationNow()
	const (
		userID  = "10000000-0000-7000-8000-000000000001"
		draftID = "20000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO goal_drafts(id,user_id,draft_type,body,revision,created_at,updated_at)
VALUES($1,$2,'creation','保持境界を検証する目標',3,$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}
	finalizedAt := now.Add(-time.Hour)
	type usageFixture struct {
		generationID  string
		idempotencyID string
		acceptedAt    time.Time
		finalizedAt   *time.Time
	}
	fixtures := []usageFixture{
		{"30000000-0000-7000-8000-000000000001", "40000000-0000-7000-8000-000000000001", now.Add(-workspace.AIUsageRetentionDuration + time.Second), &finalizedAt},
		{"30000000-0000-7000-8000-000000000002", "40000000-0000-7000-8000-000000000002", now.Add(-workspace.AIUsageRetentionDuration), &finalizedAt},
		{"30000000-0000-7000-8000-000000000003", "40000000-0000-7000-8000-000000000003", now.Add(-workspace.AIUsageRetentionDuration - time.Second), &finalizedAt},
		{"30000000-0000-7000-8000-000000000004", "40000000-0000-7000-8000-000000000004", now.Add(-workspace.AIUsageRetentionDuration - time.Minute), nil},
	}
	for _, fixture := range fixtures {
		budgetMonth := time.Date(fixture.acceptedAt.UTC().Year(), fixture.acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
		if _, err := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,3,$4,$5,'保持境界を検証する目標','fake','test','goal-v2',$6,0,'provider_error',$7,$7)`,
			fixture.generationID, userID, draftID, fixture.idempotencyID, integrationAIRequestHash,
			budgetMonth, fixture.acceptedAt); err != nil {
			t.Fatal(err)
		}
		if fixture.finalizedAt == nil {
			if _, err := pool.Exec(ctx, `UPDATE ai_generations SET status='running',failure_code=NULL,
lease_expires_at=$2,finished_at=NULL WHERE id=$1`, fixture.generationID, now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,provider_usage_finalized_at,quota_retain_until)
VALUES($1,$2,'goal_refine','failed','fake','test','goal-v2',$3,$4,$5)`,
			fixture.generationID, userID, fixture.acceptedAt, fixture.finalizedAt,
			workspace.AIUsageQuotaRetainUntil(fixture.acceptedAt)); err != nil {
			t.Fatal(err)
		}
		if fixture.finalizedAt == nil {
			if _, err := pool.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='provider_error',
lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, fixture.generationID, now); err != nil {
				t.Fatal(err)
			}
		}
	}

	settings := aiConcurrencySettings()
	store := NewWorkspaceStore(pool)
	if err := executeGoalDraftAbandonUseCase(store, ctx, userID, draftID, now); err != nil {
		t.Fatal(err)
	}
	var draftCount, generationCount int
	if err := pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM goal_drafts WHERE id=$1),
(SELECT count(*) FROM ai_generations WHERE source_goal_draft_id=$1)`, draftID).Scan(&draftCount, &generationCount); err != nil {
		t.Fatal(err)
	}
	if draftCount != 0 || generationCount != 0 {
		t.Fatalf("remaining Draft/generations = %d/%d", draftCount, generationCount)
	}
	rows, err := pool.Query(ctx, `SELECT operation_id,content_deleted FROM ai_usage_events WHERE user_id=$1 ORDER BY operation_id`, userID)
	if err != nil {
		t.Fatal(err)
	}
	retained := []string{}
	for rows.Next() {
		var operationID string
		var contentDeleted bool
		if err = rows.Scan(&operationID, &contentDeleted); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if !contentDeleted {
			rows.Close()
			t.Fatalf("retained usage %s was not content-redacted", operationID)
		}
		retained = append(retained, operationID)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	wantRetained := []string{fixtures[0].generationID, fixtures[3].generationID}
	if len(retained) != len(wantRetained) || retained[0] != wantRetained[0] || retained[1] != wantRetained[1] {
		t.Fatalf("retained usage IDs = %v, want %v", retained, wantRetained)
	}

	lateResult := workspace.AIExecutionResult{
		Usage: workspace.AIUsage{InputTokens: 7, OutputTokens: 11, CostUSD: 0.025}, Attempts: 1,
	}
	lateSnapshot := workspace.AISnapshot{GenerationID: fixtures[3].generationID}
	for attempt := 0; attempt < 2; attempt++ {
		if _, finishErr := executeGoalRefineFinishUseCaseWithSettings(store, ctx, lateSnapshot, lateResult, nil, now.Add(time.Duration(attempt+1)*time.Minute), settings); !errors.Is(finishErr, workspace.ErrNotFound) {
			t.Fatalf("late callback %d error = %v, want not found after settlement", attempt+1, finishErr)
		}
	}
	var status string
	var inputTokens, outputTokens int64
	var cost, actualCost float64
	var usageFinalized bool
	month := time.Date(fixtures[3].acceptedAt.UTC().Year(), fixtures[3].acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	if err := pool.QueryRow(ctx, `SELECT
(SELECT status FROM ai_usage_events WHERE operation_id=$1),
(SELECT input_tokens FROM ai_usage_events WHERE operation_id=$1),
(SELECT output_tokens FROM ai_usage_events WHERE operation_id=$1),
(SELECT estimated_cost_usd FROM ai_usage_events WHERE operation_id=$1),
(SELECT provider_usage_finalized_at IS NOT NULL FROM ai_usage_events WHERE operation_id=$1),
(SELECT actual_cost_usd FROM ai_budget_monthly WHERE month_utc=$2)`, fixtures[3].generationID, month).Scan(
		&status, &inputTokens, &outputTokens, &cost, &usageFinalized, &actualCost); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || inputTokens != lateResult.Usage.InputTokens || outputTokens != lateResult.Usage.OutputTokens ||
		!usageFinalized || !approximatelyEqual(cost, lateResult.Usage.CostUSD) || !approximatelyEqual(actualCost, lateResult.Usage.CostUSD) {
		t.Fatalf("late settlement = %s %d/%d cost %.8f finalized=%t actual=%.8f",
			status, inputTokens, outputTokens, cost, usageFinalized, actualCost)
	}
}

func TestActionAIStoresSharedQuotaRetentionDeadline(t *testing.T) {
	tests := []struct {
		name          string
		operation     string
		action        string
		generationID  string
		idempotencyID string
	}{
		{"generate", "action_generate", "", "83000000-0000-7000-8000-000000000011", "82000000-0000-7000-8000-000000000011"},
		{"refine", "action_refine", "既存の行動", "83000000-0000-7000-8000-000000000012", "82000000-0000-7000-8000-000000000012"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := integrationPool(t)
			resetDatabase(t, pool)
			ctx := context.Background()
			now := integrationNow()
			const userID = "10000000-0000-7000-8000-000000000001"
			insertAIConcurrencyUser(t, pool, userID, now)
			settings := aiConcurrencySettings()
			store := NewWorkspaceStore(pool)
			fixture := progressingGoalFixtures()[0]
			startProgressingGoal(t, store, userID, fixture, 2, now)
			if _, err := pool.Exec(ctx, `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',action=$2,
content_revision=4,plan_revision=1,do_revision=1,check_revision=1,action_revision=CASE WHEN $2='' THEN 0 ELSE 1 END
WHERE id=$1`, fixture.cycleID, test.action); err != nil {
				t.Fatal(err)
			}
			acceptedAt := now.Add(time.Minute)
			var err error
			if test.operation == "action_generate" {
				_, err = executeActionGenerateBeginUseCaseWithSettings(store, ctx, workspace.ActionGenerateInput{
					UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
					ExpectedContentRevision: 4, IdempotencyKey: test.idempotencyID,
					GenerationID: test.generationID, Now: acceptedAt,
				}, passthroughAIContext, settings)
			} else {
				_, err = executeActionRefineBeginUseCaseWithSettings(store, ctx, workspace.ActionRefineInput{
					UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
					ExpectedContentRevision: 4, IdempotencyKey: test.idempotencyID,
					GenerationID: test.generationID, Now: acceptedAt,
				}, passthroughAIContext, settings)
			}
			if err != nil {
				t.Fatal(err)
			}
			var storedAcceptedAt, retainUntil, settlementMonth time.Time
			var settlementReservation string
			if err := pool.QueryRow(ctx, `SELECT accepted_at,quota_retain_until,settlement_budget_month_utc,
settlement_reservation_cost_usd::text FROM ai_usage_events WHERE operation_id=$1`,
				test.generationID).Scan(&storedAcceptedAt, &retainUntil, &settlementMonth, &settlementReservation); err != nil {
				t.Fatal(err)
			}
			wantMonth := time.Date(acceptedAt.UTC().Year(), acceptedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
			if !storedAcceptedAt.Equal(acceptedAt) || !retainUntil.Equal(workspace.AIUsageQuotaRetainUntil(acceptedAt)) ||
				!settlementMonth.Equal(wantMonth) || settlementReservation != "0.01000000" {
				t.Fatalf("accepted/retain/exposure = %s/%s/%s/%s, want %s/%s/%s/0.01000000", storedAcceptedAt,
					retainUntil, settlementMonth, settlementReservation, acceptedAt,
					workspace.AIUsageQuotaRetainUntil(acceptedAt), wantMonth)
			}
		})
	}
}
