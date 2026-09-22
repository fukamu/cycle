package postgres

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/infrastructure/contentcrypto"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

func TestContentEncryptionLegacyBackfillStrictAndFailClosed(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID        = "10000000-0000-7000-8000-000000000071"
		draftID       = "11000000-0000-7000-8000-000000000071"
		goalID        = "21000000-0000-7000-8000-000000000071"
		versionID     = "31000000-0000-7000-8000-000000000071"
		cycleID       = "41000000-0000-7000-8000-000000000071"
		operationID   = "51000000-0000-7000-8000-000000000071"
		generationID  = "81000000-0000-7000-8000-000000000071"
		legacyAIID    = "81000000-0000-7000-8000-000000000072"
		idempotency   = "82000000-0000-7000-8000-000000000071"
		legacyAIKey   = "82000000-0000-7000-8000-000000000072"
		jobID         = "91000000-0000-7000-8000-000000000071"
		requestHash   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		canonicalHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	)

	seed := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, []any{userID, now}},
		{`INSERT INTO goal_drafts(id,user_id,draft_type,body,revision,created_at,updated_at)
VALUES($1,$2,'creation','legacy draft',3,$3,$3)`, []any{draftID, userID, now}},
		{`INSERT INTO goal_draft_success_signals(goal_draft_id,success_signal) VALUES($1,'legacy draft signal')`, []any{draftID}},
		{`INSERT INTO goals(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,$3,$3)`, []any{goalID, userID, now}},
		{`INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'legacy goal',$4,$5)`, []any{versionID, userID, goalID, operationID, now}},
		{`INSERT INTO goal_version_success_signals(goal_version_id,success_signal) VALUES($1,'legacy goal signal')`, []any{versionID}},
		{`INSERT INTO pdca_cycles(id,user_id,goal_id,goal_version_id,sequence_number,status,plan,do_text,check_text,action,
plan_revision,do_revision,check_revision,action_revision,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active','P','D','C','A',2,3,4,5,$5,$6,'content-encryption-test',$5,$5)`,
			[]any{cycleID, userID, goalID, versionID, now, operationID}},
		{`INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,
idempotency_request_hash,canonical_provider_input_hash,source_text,output,provider,model,prompt_version,
budget_month_utc,budget_reserved_cost_usd,attempt_count,context_changed,started_at,finished_at)
VALUES($1,$2,'goal_refine','succeeded',$3,3,$4,$5,$5,$6,'legacy source','legacy output',
'fake','test','goal-refine-v1',$7,0,1,true,$8,$8)`,
			[]any{generationID, userID, draftID, idempotency, requestHash, canonicalHash, now.Format("2006-01-02"), now}},
		{`INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,
source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,3,$4,$5,'legacy source without canonical hash',
'fake','test','goal-refine-v1',$6,0,'legacy_failure',$7,$7)`,
			[]any{legacyAIID, userID, draftID, legacyAIKey, requestHash, now.Format("2006-01-02"), now}},
	}
	for _, statement := range seed {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	kms, err := contentcrypto.NewFixtureKMS(
		"fixture/projects/local/locations/local/keyRings/cycle/cryptoKeys/content/cryptoKeyVersions/1",
		[]byte("0123456789abcdef0123456789abcdef"),
	)
	if err != nil {
		t.Fatal(err)
	}
	service := contentcrypto.NewService(NewContentKeyRepository(pool), kms)
	t.Cleanup(service.Close)
	operator := NewContentEncryptionOperator(pool, service)

	state, err := operator.State(ctx)
	if err != nil || state.Mode != contentModeLegacy || state.LegacyRows != 7 || state.Generation != 0 {
		t.Fatalf("initial encryption state = %#v, error = %v", state, err)
	}
	if err = operator.ActivateWrites(ctx, now); err != nil {
		t.Fatal(err)
	}
	store := NewEncryptedWorkspaceStore(pool, service)
	if _, err = executeCycleSaveUseCase(store, ctx, workspace.SaveFrameInput{
		UserID: userID, GoalID: goalID, CycleID: cycleID,
		Frame: cycle.FramePlan, Content: "activated encrypted plan", ExpectedFrameRevision: 2,
	}, now); err != nil {
		t.Fatalf("first post-activation Cycle write: %v", err)
	}
	var promotedFormat string
	var promotedFields int
	if err = pool.QueryRow(ctx, `SELECT content_storage_format,
((plan_ciphertext IS NOT NULL)::int + (do_text_ciphertext IS NOT NULL)::int +
 (check_text_ciphertext IS NOT NULL)::int + (action_ciphertext IS NOT NULL)::int)
FROM pdca_cycles WHERE id=$1`, cycleID).Scan(&promotedFormat, &promotedFields); err != nil {
		t.Fatal(err)
	}
	if promotedFormat != contentStorageV1 || promotedFields != 4 {
		t.Fatalf("post-activation Cycle promotion = %s/%d fields", promotedFormat, promotedFields)
	}
	_, staleWriterErr := pool.Exec(ctx, `UPDATE goal_drafts SET body='stale plaintext' WHERE id=$1`, draftID)
	assertPostgresSQLState(t, staleWriterErr, "23514")

	directory := filepath.Join("..", "..", "..", "migrations")
	down, err := os.ReadFile(filepath.Join(directory, "000010_user_content_encryption_expand.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	executeMigrationScriptExpectSQLState(t, pool, down, "23514")

	if err = operator.StartJob(ctx, jobID, "backfill", "encrypt_legacy_rows", now); err != nil {
		t.Fatal(err)
	}
	var processed, conflicts int64
	for attempts := 0; attempts < 20; attempts++ {
		batch, batchErr := operator.BackfillBatch(ctx, 2)
		if batchErr != nil {
			t.Fatal(batchErr)
		}
		processed += batch.Processed
		conflicts += batch.Conflicts
		if err = operator.RecordJobProgress(
			ctx, jobID, "encrypt_legacy_rows", batch.Processed, batch.Conflicts, 0, now,
		); err != nil {
			t.Fatal(err)
		}
		if batch.Processed == 0 && batch.Conflicts == 0 {
			break
		}
	}
	if processed != 6 || conflicts != 0 {
		t.Fatalf("backfill processed/conflicts = %d/%d, want 6/0", processed, conflicts)
	}
	if err = operator.FinishJob(ctx, jobID, "completed", "completed", now); err != nil {
		t.Fatal(err)
	}
	var jobStatus string
	var jobProcessed, jobConflicts, jobFailures int64
	if err = pool.QueryRow(ctx, `SELECT status,processed_count,conflict_count,failure_count
FROM content_encryption_jobs WHERE id=$1`, jobID).Scan(
		&jobStatus, &jobProcessed, &jobConflicts, &jobFailures,
	); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "completed" || jobProcessed != 6 || jobConflicts != 0 || jobFailures != 0 {
		t.Fatalf("backfill job status/counts = %s/%d/%d/%d", jobStatus, jobProcessed, jobConflicts, jobFailures)
	}
	storageInventory, keyInventory, jobInventory, err := operator.Inventory(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(storageInventory) != 6 || len(keyInventory) != 1 || len(jobInventory) != 1 {
		t.Fatalf("inventory storage/keys/jobs = %d/%d/%d, want 6/1/1",
			len(storageInventory), len(keyInventory), len(jobInventory))
	}
	for _, item := range storageInventory {
		wantRows := int64(1)
		if item.Resource == "ai_generations" {
			wantRows = 2
		}
		if item.Format != "encrypted-v1" || item.Rows != wantRows {
			t.Fatalf("storage inventory item = %#v", item)
		}
	}
	if keyInventory[0].Version != 1 || !keyInventory[0].WriteKey || keyInventory[0].Keys != 1 ||
		jobInventory[0].Status != "completed" || jobInventory[0].Processed != 6 {
		t.Fatalf("key/job inventory = %#v / %#v", keyInventory[0], jobInventory[0])
	}
	state, err = operator.State(ctx)
	if err != nil || state.Mode != contentModeEncrypting || state.LegacyRows != 0 || state.Generation != 1 {
		t.Fatalf("backfilled encryption state = %#v, error = %v", state, err)
	}
	verified, err := operator.Verify(ctx, 3)
	if err != nil || verified != 12 {
		t.Fatalf("verified encrypted fields = %d, error = %v, want 12", verified, err)
	}
	assertContentEncryptionPlaintextRemoved(t, pool, draftID, versionID, cycleID, generationID)
	var legacyAIFormat string
	var legacyAIHash *string
	var legacyAIHashCiphertext []byte
	var legacyAISourceCiphertext []byte
	if err = pool.QueryRow(ctx, `SELECT content_storage_format,canonical_provider_input_hash,
canonical_provider_input_hash_ciphertext,source_text_ciphertext
FROM ai_generations WHERE id=$1`, legacyAIID).Scan(
		&legacyAIFormat, &legacyAIHash, &legacyAIHashCiphertext, &legacyAISourceCiphertext,
	); err != nil {
		t.Fatal(err)
	}
	if legacyAIFormat != contentStorageV1 || legacyAIHash != nil || legacyAIHashCiphertext != nil || len(legacyAISourceCiphertext) < 16 {
		t.Fatal("legacy AI generation canonical hash absence was not preserved during encryption")
	}

	legacyDraft, err := store.GetDraft(ctx, userID, draftID)
	if err != nil || legacyDraft.Body != "legacy draft" || legacyDraft.SuccessSignal == nil || *legacyDraft.SuccessSignal != "legacy draft signal" {
		t.Fatalf("backfilled draft = %#v, error = %v", legacyDraft, err)
	}
	if err = operator.EnableStrict(ctx, now); err != nil {
		t.Fatal(err)
	}
	state, err = operator.State(ctx)
	if err != nil || state.Mode != contentModeStrict || state.Generation != 2 {
		t.Fatalf("strict encryption state = %#v, error = %v", state, err)
	}

	strictDraft, err := executeGoalDraftSaveUseCase(
		store, ctx, userID, draftID, "strict encrypted draft", legacyDraft.Revision, now,
	)
	if err != nil {
		t.Fatal(err)
	}
	readStrictDraft, err := store.GetDraft(ctx, userID, draftID)
	if err != nil || readStrictDraft.Body != strictDraft.Body {
		t.Fatalf("strict draft = %#v, error = %v", readStrictDraft, err)
	}
	var planBefore, checkBefore, actionBefore []byte
	if err = pool.QueryRow(ctx, `SELECT plan_ciphertext,check_text_ciphertext,action_ciphertext
FROM pdca_cycles WHERE id=$1`, cycleID).Scan(&planBefore, &checkBefore, &actionBefore); err != nil {
		t.Fatal(err)
	}
	if _, err = executeCycleSaveUseCase(store, ctx, workspace.SaveFrameInput{
		UserID: userID, GoalID: goalID, CycleID: cycleID,
		Frame: cycle.FrameDo, Content: "strict encrypted do", ExpectedFrameRevision: 3,
	}, now); err != nil {
		t.Fatalf("strict single-field Cycle write: %v", err)
	}
	var planAfter, checkAfter, actionAfter []byte
	if err = pool.QueryRow(ctx, `SELECT plan_ciphertext,check_text_ciphertext,action_ciphertext
FROM pdca_cycles WHERE id=$1`, cycleID).Scan(&planAfter, &checkAfter, &actionAfter); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(planBefore, planAfter) || !bytes.Equal(checkBefore, checkAfter) || !bytes.Equal(actionBefore, actionAfter) {
		t.Fatal("single-field Cycle write changed unrelated ciphertext")
	}
	var plaintext *string
	var ciphertext []byte
	if err = pool.QueryRow(ctx, `SELECT body,body_ciphertext FROM goal_drafts WHERE id=$1`, draftID).Scan(&plaintext, &ciphertext); err != nil {
		t.Fatal(err)
	}
	if plaintext != nil || len(ciphertext) < 16 {
		t.Fatalf("strict storage plaintext/ciphertext = %v/%d", plaintext, len(ciphertext))
	}

	service.Close()
	if _, err = pool.Exec(ctx, `UPDATE user_content_deks
SET wrapped_dek=set_byte(wrapped_dek,0,(get_byte(wrapped_dek,0)+1)%256)
WHERE user_id=$1 AND is_write_key=TRUE`, userID); err != nil {
		t.Fatal(err)
	}
	corruptService := contentcrypto.NewService(NewContentKeyRepository(pool), kms)
	t.Cleanup(corruptService.Close)
	if _, err = NewEncryptedWorkspaceStore(pool, corruptService).GetDraft(ctx, userID, draftID); !errors.Is(err, contentcrypto.ErrIntegrity) {
		t.Fatalf("tampered wrapped key read error = %v, want integrity failure", err)
	}

	if _, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	var keyRows, nonceRows int64
	if err = pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM user_content_deks WHERE user_id=$1),
(SELECT count(*) FROM user_content_nonce_reservations WHERE user_id=$1)`, userID).Scan(&keyRows, &nonceRows); err != nil {
		t.Fatal(err)
	}
	if keyRows != 0 || nonceRows != 0 {
		t.Fatalf("deleted User key/nonce rows = %d/%d, want 0/0", keyRows, nonceRows)
	}
}

func TestContentEncryptionActivationWaitsForLegacyWriterAndRechecksRunningAI(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID       = "10000000-0000-7000-8000-000000000073"
		draftID      = "11000000-0000-7000-8000-000000000073"
		generationID = "81000000-0000-7000-8000-000000000073"
		idempotency  = "82000000-0000-7000-8000-000000000073"
		requestHash  = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','activation fence',$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}

	writerTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(ctx, writerTx)
	var writerPID uint32
	if err = writerTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&writerPID); err != nil {
		t.Fatal(err)
	}
	if _, err = writerTx.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,
source_text,provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'goal_refine','running',$3,0,$4,$5,'activation fence','fake','test','goal-refine-v1',$6,0,$7,$7)`,
		generationID, userID, draftID, idempotency, requestHash, now.Format("2006-01-02"), now); err != nil {
		t.Fatal(err)
	}

	activationTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(ctx, activationTx)
	var activationPID uint32
	if err = activationTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&activationPID); err != nil {
		t.Fatal(err)
	}
	lockResult := make(chan error, 1)
	go func() {
		_, lockErr := db.New(activationTx).LockContentEncryptionControl(ctx)
		lockResult <- lockErr
	}()
	if err = waitForBlockedBackend(ctx, pool, activationPID, writerPID); err != nil {
		t.Fatalf("activation did not wait for legacy writer: %v", err)
	}
	if err = writerTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-lockResult; err != nil {
		t.Fatal(err)
	}
	if err = activationTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	operator := NewContentEncryptionOperator(pool, nil)
	if err = operator.ActivateWrites(ctx, now); !errors.Is(err, contentcrypto.ErrKeyringInvariant) {
		t.Fatalf("activation with newly committed running AI error = %v", err)
	}
	state, err := operator.State(ctx)
	if err != nil || state.Mode != contentModeLegacy || state.RunningAI != 1 {
		t.Fatalf("activation fence state = %#v, error = %v", state, err)
	}
}

func assertContentEncryptionPlaintextRemoved(
	t *testing.T,
	pool *pgxpool.Pool,
	draftID, versionID, cycleID, generationID string,
) {
	t.Helper()
	var draft, draftSignal, version, versionSignal, currentCycle, generation bool
	err := pool.QueryRow(context.Background(), `SELECT
(SELECT body IS NULL AND body_ciphertext IS NOT NULL FROM goal_drafts WHERE id=$1),
(SELECT success_signal IS NULL AND success_signal_ciphertext IS NOT NULL FROM goal_draft_success_signals WHERE goal_draft_id=$1),
(SELECT body IS NULL AND body_ciphertext IS NOT NULL FROM goal_versions WHERE id=$2),
(SELECT success_signal IS NULL AND success_signal_ciphertext IS NOT NULL FROM goal_version_success_signals WHERE goal_version_id=$2),
(SELECT plan IS NULL AND do_text IS NULL AND check_text IS NULL AND action IS NULL
        AND plan_ciphertext IS NOT NULL AND do_text_ciphertext IS NOT NULL
        AND check_text_ciphertext IS NOT NULL AND action_ciphertext IS NOT NULL
 FROM pdca_cycles WHERE id=$3),
(SELECT source_text IS NULL AND output IS NULL AND canonical_provider_input_hash IS NULL
        AND source_text_ciphertext IS NOT NULL AND output_ciphertext IS NOT NULL
        AND canonical_provider_input_hash_ciphertext IS NOT NULL
 FROM ai_generations WHERE id=$4)`, draftID, versionID, cycleID, generationID).
		Scan(&draft, &draftSignal, &version, &versionSignal, &currentCycle, &generation)
	if err != nil {
		t.Fatal(err)
	}
	if !draft || !draftSignal || !version || !versionSignal || !currentCycle || !generation {
		t.Fatalf("plaintext removal draft/signal/version/signal/cycle/ai = %t/%t/%t/%t/%t/%t",
			draft, draftSignal, version, versionSignal, currentCycle, generation)
	}
}
