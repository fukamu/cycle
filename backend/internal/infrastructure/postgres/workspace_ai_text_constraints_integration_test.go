package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAIGenerationTextConstraintsUseUnicodeCodePointLimits(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()

	const (
		userID             = "10000000-0000-7000-8000-000000000099"
		draftID            = "11000000-0000-7000-8000-000000000099"
		goalID             = "21000000-0000-7000-8000-000000000099"
		versionID          = "31000000-0000-7000-8000-000000000099"
		cycleID            = "41000000-0000-7000-8000-000000000099"
		startOperationID   = "51000000-0000-7000-8000-000000000099"
		goalGenerationID   = "81000000-0000-7000-8000-000000000001"
		goalIdempotencyKey = "82000000-0000-7000-8000-000000000001"
		actionGenerationID = "83000000-0000-7000-8000-000000000001"
		actionIdempotency  = "84000000-0000-7000-8000-000000000001"
	)

	statements := []struct {
		query string
		args  []any
	}{
		{
			`INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`,
			[]any{userID, now},
		},
		{
			`INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','AI goal source',$3,$3)`,
			[]any{draftID, userID, now},
		},
		{
			`INSERT INTO goals(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,$3,$3)`,
			[]any{goalID, userID, now},
		},
		{
			`INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'AI action goal',$4,$5)`,
			[]any{versionID, userID, goalID, startOperationID, now},
		},
		{
			`INSERT INTO pdca_cycles(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,
start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,$6,'m7-ai-text-constraints',$5,$5)`,
			[]any{cycleID, userID, goalID, versionID, now, startOperationID},
		},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(context.Background(), statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	goalAtLimit := strings.Repeat("🌱", 80)
	goalOverLimit := goalAtLimit + "🌱"
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,
source_text,output,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,started_at,finished_at)
VALUES($1,$2,'goal_refine','succeeded',$3,0,$4,'m7-goal-refine',$5,$5,
'fake','test','goal-refine-v1',$6,0,$7,$7)`,
		goalGenerationID, userID, draftID, goalIdempotencyKey, goalAtLimit, now.Format("2006-01-02"), now); err != nil {
		t.Fatalf("insert goal_refine at 80 code points: %v", err)
	}
	assertAIGenerationTextLengths(t, pool, goalGenerationID, 80, 80)

	_, err := pool.Exec(context.Background(), `UPDATE ai_generations SET source_text=$2 WHERE id=$1`, goalGenerationID, goalOverLimit)
	assertAIGenerationTextCheck(t, err, "ai_generations_source_text_tight_limit")
	_, err = pool.Exec(context.Background(), `UPDATE ai_generations SET output=$2 WHERE id=$1`, goalGenerationID, goalOverLimit)
	assertAIGenerationTextCheck(t, err, "ai_generations_output_tight_limit")
	assertAIGenerationTextLengths(t, pool, goalGenerationID, 80, 80)

	actionAtLimit := strings.Repeat("🌱", 200)
	actionOverLimit := actionAtLimit + "🌱"
	if _, err = pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,goal_id,goal_version_id,cycle_id,target_revision,idempotency_key,input_hash,
source_text,output,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,applied_at,started_at,finished_at)
VALUES($1,$2,'action_refine','succeeded',$3,$4,$5,0,$6,'m7-action-refine',$7,$7,
'fake','test','action-refine-v1',$8,0,$9,$9,$9)`,
		actionGenerationID, userID, goalID, versionID, cycleID, actionIdempotency,
		actionAtLimit, now.Format("2006-01-02"), now); err != nil {
		t.Fatalf("insert action_refine at 200 code points: %v", err)
	}
	assertAIGenerationTextLengths(t, pool, actionGenerationID, 200, 200)

	_, err = pool.Exec(context.Background(), `UPDATE ai_generations SET source_text=$2 WHERE id=$1`, actionGenerationID, actionOverLimit)
	assertAIGenerationTextCheck(t, err, "ai_generations_source_text_tight_limit")
	_, err = pool.Exec(context.Background(), `UPDATE ai_generations SET output=$2 WHERE id=$1`, actionGenerationID, actionOverLimit)
	assertAIGenerationTextCheck(t, err, "ai_generations_output_tight_limit")
	assertAIGenerationTextLengths(t, pool, actionGenerationID, 200, 200)
}

func assertAIGenerationTextLengths(t *testing.T, pool *pgxpool.Pool, generationID string, wantSource, wantOutput int) {
	t.Helper()
	var sourceLength, outputLength int
	if err := pool.QueryRow(context.Background(), `SELECT char_length(source_text),char_length(output)
FROM ai_generations WHERE id=$1`, generationID).Scan(&sourceLength, &outputLength); err != nil {
		t.Fatal(err)
	}
	if sourceLength != wantSource || outputLength != wantOutput {
		t.Fatalf("AI generation source/output lengths = %d/%d, want %d/%d", sourceLength, outputLength, wantSource, wantOutput)
	}
}

func assertAIGenerationTextCheck(t *testing.T, err error, constraint string) {
	t.Helper()
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23514" || postgresError.ConstraintName != constraint {
		t.Fatalf("constraint error = %v, want 23514 %s", err, constraint)
	}
}
