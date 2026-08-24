package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateIsTransactionalAndIdempotent(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	directory := filepath.Join("..", "..", "..", "migrations")
	hashDown, err := os.ReadFile(filepath.Join(directory, "000004_ai_generation_hash_split.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	executeMigrationScript(t, pool, hashDown)
	exposureDown, err := os.ReadFile(filepath.Join(directory, "000003_ai_usage_settlement_exposure.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	executeMigrationScript(t, pool, exposureDown)
	retentionDown, err := os.ReadFile(filepath.Join(directory, "000002_ai_usage_retention_margin.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	executeMigrationScript(t, pool, retentionDown)
	down, err := os.ReadFile(filepath.Join(directory, "000001_fukamu_cycle_baseline.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	executeMigrationScript(t, pool, down)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS schema_migrations`)
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	result, err := Migrate(databaseURL, directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Applied) != 4 {
		t.Fatalf("applied migrations = %v, want 4", result.Applied)
	}
	baseline, retention, exposure, hashSplit := result.Applied[0], result.Applied[1], result.Applied[2], result.Applied[3]
	if baseline.Version != 1 || baseline.Direction != "up" || baseline.File != "000001_fukamu_cycle_baseline.up.sql" ||
		retention.Version != 2 || retention.Direction != "up" || retention.File != "000002_ai_usage_retention_margin.up.sql" ||
		exposure.Version != 3 || exposure.Direction != "up" || exposure.File != "000003_ai_usage_settlement_exposure.up.sql" ||
		hashSplit.Version != 4 || hashSplit.Direction != "up" || hashSplit.File != "000004_ai_generation_hash_split.up.sql" {
		t.Fatalf("applied migrations = %+v", result.Applied)
	}
	result, err = Migrate(databaseURL, directory)
	if err != nil {
		t.Fatalf("second migration: %v", err)
	}
	if !result.NoChange() {
		t.Fatalf("second migration applied = %v, want no change", result.Applied)
	}
	var version, users int
	_ = pool.QueryRow(context.Background(), `SELECT version FROM schema_migrations`).Scan(&version)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&users)
	if version != 4 || users != 0 {
		t.Fatalf("version/users = %d/%d", version, users)
	}
	assertTightContentConstraints(t, pool)
	assertUUIDv7Constraints(t, pool)

	_, err = pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES('10000000-0000-7000-8000-000000000001',now(),now(),now())`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(context.Background(), `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES('20000000-0000-7000-8000-000000000001','10000000-0000-7000-8000-000000000001','creation',$1,now(),now())`, strings.Repeat("界", 81))
	if err == nil {
		t.Fatal("oversize goal draft unexpectedly succeeded")
	}
}

func TestAIUsageRetentionMigrationBackfillsAndClampsOldWriters(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	directory := filepath.Join("..", "..", "..", "migrations")
	up, err := os.ReadFile(filepath.Join(directory, "000002_ai_usage_retention_margin.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile(filepath.Join(directory, "000002_ai_usage_retention_margin.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	installed := true
	t.Cleanup(func() {
		if !installed {
			executeMigrationScript(t, pool, up)
		}
	})
	executeMigrationScript(t, pool, down)
	installed = false

	ctx := context.Background()
	acceptedAt := time.Date(2026, time.August, 24, 0, 0, 0, 0, time.UTC)
	const userID = "10000000-0000-7000-8000-000000000002"
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, acceptedAt); err != nil {
		t.Fatal(err)
	}
	insertUsage := func(operationID string, retainUntil time.Time) {
		t.Helper()
		if _, insertErr := pool.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,provider_usage_finalized_at,quota_retain_until)
VALUES($1,$2,'goal_refine','succeeded','fake','test','goal-v2',$3,$3,$4)`,
			operationID, userID, acceptedAt, retainUntil); insertErr != nil {
			t.Fatal(insertErr)
		}
	}
	readDeadline := func(operationID string) time.Time {
		t.Helper()
		var deadline time.Time
		if queryErr := pool.QueryRow(ctx, `SELECT quota_retain_until FROM ai_usage_events WHERE operation_id=$1`, operationID).Scan(&deadline); queryErr != nil {
			t.Fatal(queryErr)
		}
		return deadline
	}
	const legacyID = "30000000-0000-7000-8000-000000000011"
	insertUsage(legacyID, acceptedAt.Add(24*time.Hour))

	executeMigrationScript(t, pool, up)
	installed = true
	wantDeadline := acceptedAt.Add(24*time.Hour + 15*time.Minute)
	if got := readDeadline(legacyID); !got.Equal(wantDeadline) {
		t.Fatalf("backfilled deadline = %s, want %s", got, wantDeadline)
	}

	const oldWriterID = "30000000-0000-7000-8000-000000000012"
	insertUsage(oldWriterID, acceptedAt.Add(24*time.Hour))
	if got := readDeadline(oldWriterID); !got.Equal(wantDeadline) {
		t.Fatalf("old-writer deadline = %s, want trigger normalization %s", got, wantDeadline)
	}
	const longerID = "30000000-0000-7000-8000-000000000013"
	insertUsage(longerID, acceptedAt.Add(26*time.Hour))
	if got := readDeadline(longerID); !got.Equal(wantDeadline) {
		t.Fatalf("longer deadline = %s, want trigger normalization %s", got, wantDeadline)
	}

	executeMigrationScript(t, pool, down)
	installed = false
	if got := readDeadline(oldWriterID); !got.Equal(wantDeadline) {
		t.Fatalf("down changed retained data to %s, want %s", got, wantDeadline)
	}
	const afterDownID = "30000000-0000-7000-8000-000000000014"
	wantLegacy := acceptedAt.Add(24 * time.Hour)
	insertUsage(afterDownID, wantLegacy)
	if got := readDeadline(afterDownID); !got.Equal(wantLegacy) {
		t.Fatalf("down left clamp active: deadline = %s, want %s", got, wantLegacy)
	}
	executeMigrationScript(t, pool, up)
	installed = true
}

func TestAIUsageSettlementExposureMigrationBackfillsLegacyRowsAndGuardsOldAccountDelete(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	directory := filepath.Join("..", "..", "..", "migrations")
	up, err := os.ReadFile(filepath.Join(directory, "000003_ai_usage_settlement_exposure.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile(filepath.Join(directory, "000003_ai_usage_settlement_exposure.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	installed := true
	t.Cleanup(func() {
		if !installed {
			_, _ = pool.Exec(context.Background(), `DELETE FROM users`)
			executeMigrationScript(t, pool, up)
		}
	})
	executeMigrationScript(t, pool, down)
	installed = false

	ctx := context.Background()
	acceptedAt := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	month := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	const (
		userID       = "10000000-0000-7000-8000-000000000031"
		draftID      = "20000000-0000-7000-8000-000000000031"
		legacyID     = "30000000-0000-7000-8000-000000000031"
		legacyKey    = "40000000-0000-7000-8000-000000000031"
		finalizedID  = "30000000-0000-7000-8000-000000000032"
		oldWriterID  = "30000000-0000-7000-8000-000000000033"
		oldWriterKey = "40000000-0000-7000-8000-000000000033"
	)
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, acceptedAt); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','migration exposure',$3,$3)`, draftID, userID, acceptedAt); err != nil {
		t.Fatal(err)
	}
	insertRunningGeneration := func(operationID, key string) {
		t.Helper()
		if _, insertErr := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
 provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'goal_refine','running',$3,0,$4,$5,'migration exposure','fake','test','goal-v2',$6,0.12345678,$7,$8)`,
			operationID, userID, draftID, key, strings.Repeat("31", 32), month,
			acceptedAt.Add(time.Hour), acceptedAt); insertErr != nil {
			t.Fatal(insertErr)
		}
	}
	insertLegacyUsage := func(operationID string) {
		t.Helper()
		if _, insertErr := pool.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES($1,$2,'goal_refine','accepted','fake','test','goal-v2',$3,$4)`,
			operationID, userID, acceptedAt, acceptedAt.Add(24*time.Hour)); insertErr != nil {
			t.Fatal(insertErr)
		}
	}
	insertRunningGeneration(legacyID, legacyKey)
	insertLegacyUsage(legacyID)
	if _, err = pool.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,provider_usage_finalized_at,quota_retain_until)
VALUES($1,$2,'goal_refine','succeeded','fake','test','goal-v2',$3,$3,$4)`,
		finalizedID, userID, acceptedAt, acceptedAt.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	executeMigrationScript(t, pool, up)
	installed = true
	var gotMonth time.Time
	var gotReservation string
	if err = pool.QueryRow(ctx, `SELECT settlement_budget_month_utc,settlement_reservation_cost_usd::text
FROM ai_usage_events WHERE operation_id=$1`, legacyID).Scan(&gotMonth, &gotReservation); err != nil {
		t.Fatal(err)
	}
	if !gotMonth.Equal(month) || gotReservation != "0.12345678" {
		t.Fatalf("backfilled exposure = %s/%s, want %s/0.12345678", gotMonth, gotReservation, month)
	}
	var finalizedMetadataCleared, constraintValidated bool
	if err = pool.QueryRow(ctx, `SELECT
(SELECT settlement_budget_month_utc IS NULL AND settlement_reservation_cost_usd IS NULL
 FROM ai_usage_events WHERE operation_id=$1),
(SELECT convalidated FROM pg_constraint WHERE conname='ai_usage_events_settlement_exposure')`, finalizedID).Scan(
		&finalizedMetadataCleared, &constraintValidated); err != nil {
		t.Fatal(err)
	}
	if !finalizedMetadataCleared || !constraintValidated {
		t.Fatalf("finalized metadata cleared/constraint validated = %t/%t", finalizedMetadataCleared, constraintValidated)
	}
	if _, err = pool.Exec(ctx, `UPDATE ai_generations SET status='failed',budget_reserved_cost_usd=0,
failure_code='provider_error',lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, legacyID, acceptedAt); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE ai_usage_events SET status='failed',provider_usage_finalized_at=$2 WHERE operation_id=$1`, legacyID, acceptedAt); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT settlement_budget_month_utc IS NULL AND settlement_reservation_cost_usd IS NULL
FROM ai_usage_events WHERE operation_id=$1`, legacyID).Scan(&finalizedMetadataCleared); err != nil || !finalizedMetadataCleared {
		t.Fatalf("legacy finalizer metadata clear = %t, error %v", finalizedMetadataCleared, err)
	}

	insertRunningGeneration(oldWriterID, oldWriterKey)
	insertLegacyUsage(oldWriterID)
	if err = pool.QueryRow(ctx, `SELECT settlement_budget_month_utc,settlement_reservation_cost_usd::text
FROM ai_usage_events WHERE operation_id=$1`, oldWriterID).Scan(&gotMonth, &gotReservation); err != nil {
		t.Fatal(err)
	}
	if !gotMonth.Equal(month) || gotReservation != "0.12345678" {
		t.Fatalf("old writer exposure = %s/%s", gotMonth, gotReservation)
	}
	_, mutationErr := pool.Exec(ctx, `UPDATE ai_usage_events SET settlement_reservation_cost_usd=0.2 WHERE operation_id=$1`, oldWriterID)
	assertPostgresSQLState(t, mutationErr, "23514")
	if _, err = pool.Exec(ctx, `UPDATE ai_generations SET status='failed',budget_reserved_cost_usd=0,
failure_code='lease_expired',lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, oldWriterID, acceptedAt); err != nil {
		t.Fatal(err)
	}
	_, mutationErr = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	assertPostgresSQLState(t, mutationErr, "23514")

	executeMigrationScript(t, pool, down)
	installed = false
	if _, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	executeMigrationScript(t, pool, up)
	installed = true
}

func TestAIUsageSettlementExposureMigrationRejectsUnrecoverableRowsAtomically(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	directory := filepath.Join("..", "..", "..", "migrations")
	up, err := os.ReadFile(filepath.Join(directory, "000003_ai_usage_settlement_exposure.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile(filepath.Join(directory, "000003_ai_usage_settlement_exposure.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	installed := true
	t.Cleanup(func() {
		if !installed {
			_, _ = pool.Exec(context.Background(), `DELETE FROM users`)
			executeMigrationScript(t, pool, up)
		}
	})
	executeMigrationScript(t, pool, down)
	installed = false
	ctx := context.Background()
	now := time.Date(2026, time.August, 24, 12, 0, 0, 0, time.UTC)
	const userID = "10000000-0000-7000-8000-000000000041"
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO ai_usage_events
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES('30000000-0000-7000-8000-000000000041',$1,'goal_refine','failed','fake','test','goal-v2',$2,$3)`,
		userID, now, now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	executeMigrationScriptExpectSQLState(t, pool, up, "23514")
	var columns int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
WHERE table_schema='public' AND table_name='ai_usage_events'
  AND column_name IN ('settlement_budget_month_utc','settlement_reservation_cost_usd')`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 0 {
		t.Fatalf("settlement columns after failed migration = %d, want 0", columns)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	executeMigrationScript(t, pool, up)
	installed = true
}

func TestAIGenerationHashSplitMigrationBackfillsAndSupportsRollingWriters(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	directory := filepath.Join("..", "..", "..", "migrations")
	up, err := os.ReadFile(filepath.Join(directory, "000004_ai_generation_hash_split.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile(filepath.Join(directory, "000004_ai_generation_hash_split.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	installed := true
	t.Cleanup(func() {
		if !installed {
			_, _ = pool.Exec(context.Background(), `DELETE FROM users`)
			executeMigrationScript(t, pool, up)
		}
	})
	executeMigrationScript(t, pool, down)
	installed = false

	ctx := context.Background()
	now := time.Date(2026, time.August, 24, 13, 0, 0, 0, time.UTC)
	const (
		userID               = "10000000-0000-7000-8000-000000000051"
		draftID              = "20000000-0000-7000-8000-000000000051"
		legacyID             = "30000000-0000-7000-8000-000000000051"
		legacyKey            = "40000000-0000-7000-8000-000000000051"
		oldWriterID          = "30000000-0000-7000-8000-000000000052"
		oldWriterKey         = "40000000-0000-7000-8000-000000000052"
		newWriterID          = "30000000-0000-7000-8000-000000000053"
		newWriterKey         = "40000000-0000-7000-8000-000000000053"
		mismatchID           = "30000000-0000-7000-8000-000000000054"
		mismatchKey          = "40000000-0000-7000-8000-000000000054"
		missingCanonicalID   = "30000000-0000-7000-8000-000000000055"
		missingCanonicalKey  = "40000000-0000-7000-8000-000000000055"
		legacyRequestHash    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		oldWriterRequestHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		newWriterRequestHash = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
		canonicalInputHash   = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
		changedHash          = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	)
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','hash split migration',$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}
	insertLegacyWriter := func(generationID, idempotencyKey, requestHash string) {
		t.Helper()
		if _, insertErr := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
 provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,0,$4,$5,'hash split migration','fake','test','goal-v2',$6,0,
       'legacy_failure',$7,$7)`, generationID, userID, draftID, idempotencyKey, requestHash, now, now); insertErr != nil {
			t.Fatal(insertErr)
		}
	}
	insertLegacyWriter(legacyID, legacyKey, legacyRequestHash)

	executeMigrationScript(t, pool, up)
	installed = true
	assertAIGenerationHashes(t, pool, legacyID, legacyRequestHash, legacyRequestHash, "", true)

	insertLegacyWriter(oldWriterID, oldWriterKey, oldWriterRequestHash)
	assertAIGenerationHashes(t, pool, oldWriterID, oldWriterRequestHash, oldWriterRequestHash, "", true)

	if _, err = pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,
 idempotency_request_hash,canonical_provider_input_hash,source_text,provider,model,prompt_version,
 budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,0,$4,$5,$6,'hash split migration','fake','test','goal-v2',$7,0,
       'new_writer_failure',$8,$8)`, newWriterID, userID, draftID, newWriterKey,
		newWriterRequestHash, canonicalInputHash, now, now); err != nil {
		t.Fatal(err)
	}
	assertAIGenerationHashes(t, pool, newWriterID, newWriterRequestHash, newWriterRequestHash, canonicalInputHash, false)

	_, mutationErr := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,
 idempotency_request_hash,canonical_provider_input_hash,source_text,provider,model,prompt_version,
 budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,0,$4,$5,$6,$7,'hash split migration','fake','test','goal-v2',$8,0,
       'mismatch_failure',$9,$9)`, mismatchID, userID, draftID, mismatchKey,
		legacyRequestHash, newWriterRequestHash, canonicalInputHash, now, now)
	assertPostgresSQLState(t, mutationErr, "23514")

	_, mutationErr = pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,
 idempotency_request_hash,source_text,provider,model,prompt_version,budget_month_utc,
 budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,0,$4,$5,'hash split migration','fake','test','goal-v2',$6,0,
       'missing_canonical_failure',$7,$7)`, missingCanonicalID, userID, draftID, missingCanonicalKey,
		changedHash, now, now)
	assertPostgresSQLState(t, mutationErr, "23514")

	invalidSequence := 0
	for _, field := range []string{"idempotency_request_hash", "canonical_provider_input_hash"} {
		for _, invalid := range invalidAIGenerationHashes() {
			field, invalid := field, invalid
			t.Run("rejects invalid new writer "+field+" "+invalid.name, func(t *testing.T) {
				invalidSequence++
				generationID := fmt.Sprintf("30000000-0000-7000-8000-%012x", 0x100+invalidSequence)
				idempotencyKey := fmt.Sprintf("40000000-0000-7000-8000-%012x", 0x100+invalidSequence)
				requestHash, canonicalHash := newWriterRequestHash, canonicalInputHash
				if field == "idempotency_request_hash" {
					requestHash = invalid.value
				} else {
					canonicalHash = invalid.value
				}
				_, insertErr := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,
 idempotency_request_hash,canonical_provider_input_hash,source_text,provider,model,prompt_version,
 budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,0,$4,$5,$6,'hash split migration','fake','test','goal-v2',$7,0,
       'invalid_hash_failure',$8,$8)`, generationID, userID, draftID, idempotencyKey,
					requestHash, canonicalHash, now, now)
				assertPostgresSQLState(t, insertErr, "23514")

				var rows int
				if countErr := pool.QueryRow(ctx, `SELECT count(*) FROM ai_generations WHERE id=$1`, generationID).Scan(&rows); countErr != nil {
					t.Fatal(countErr)
				}
				if rows != 0 {
					t.Fatalf("invalid new writer insert left %d Generation rows", rows)
				}
			})
		}
	}

	for _, column := range []string{"input_hash", "idempotency_request_hash", "canonical_provider_input_hash"} {
		_, mutationErr = pool.Exec(ctx, `UPDATE ai_generations SET `+column+`=$2 WHERE id=$1`, newWriterID, changedHash)
		assertPostgresSQLState(t, mutationErr, "23514")
	}
	assertAIGenerationHashes(t, pool, newWriterID, newWriterRequestHash, newWriterRequestHash, canonicalInputHash, false)

	executeMigrationScript(t, pool, down)
	installed = false
	var rollbackAlias string
	if err = pool.QueryRow(ctx, `SELECT input_hash FROM ai_generations WHERE id=$1`, newWriterID).Scan(&rollbackAlias); err != nil {
		t.Fatal(err)
	}
	if rollbackAlias != newWriterRequestHash {
		t.Fatalf("rollback alias = %q, want request hash %q", rollbackAlias, newWriterRequestHash)
	}
	assertAIGenerationHashSplitObjects(t, pool, false)

	executeMigrationScript(t, pool, up)
	installed = true
	assertAIGenerationHashSplitObjects(t, pool, true)
	assertAIGenerationHashes(t, pool, newWriterID, newWriterRequestHash, newWriterRequestHash, "", true)
}

func TestAIGenerationHashSplitMigrationRejectsInvalidLegacyHashesAtomically(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	directory := filepath.Join("..", "..", "..", "migrations")
	up, err := os.ReadFile(filepath.Join(directory, "000004_ai_generation_hash_split.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile(filepath.Join(directory, "000004_ai_generation_hash_split.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	installed := true
	t.Cleanup(func() {
		if !installed {
			_, _ = pool.Exec(context.Background(), `DELETE FROM users`)
			executeMigrationScript(t, pool, up)
		}
	})
	executeMigrationScript(t, pool, down)
	installed = false

	ctx := context.Background()
	now := time.Date(2026, time.August, 24, 14, 0, 0, 0, time.UTC)
	const (
		userID       = "10000000-0000-7000-8000-000000000061"
		draftID      = "20000000-0000-7000-8000-000000000061"
		generationID = "30000000-0000-7000-8000-000000000061"
		key          = "40000000-0000-7000-8000-000000000061"
	)
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES($1,$2,'creation','invalid legacy hash',$3,$3)`, draftID, userID, now); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range invalidAIGenerationHashes() {
		invalid := invalid
		t.Run(invalid.name, func(t *testing.T) {
			if _, insertErr := pool.Exec(ctx, `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
 provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,failure_code,started_at,finished_at)
VALUES($1,$2,'goal_refine','failed',$3,0,$4,$5,'invalid legacy hash','fake','test','goal-v2',$6,0,
       'legacy_failure',$7,$7)`, generationID, userID, draftID, key, invalid.value, now, now); insertErr != nil {
				t.Fatal(insertErr)
			}

			executeMigrationScriptExpectSQLState(t, pool, up, "23514")
			assertAIGenerationHashSplitObjects(t, pool, false)
			var unchanged string
			if queryErr := pool.QueryRow(ctx, `SELECT input_hash FROM ai_generations WHERE id=$1`, generationID).Scan(&unchanged); queryErr != nil {
				t.Fatal(queryErr)
			}
			if unchanged != invalid.value {
				t.Fatalf("failed migration changed legacy input_hash to %q, want %q", unchanged, invalid.value)
			}

			if _, deleteErr := pool.Exec(ctx, `DELETE FROM ai_generations WHERE id=$1`, generationID); deleteErr != nil {
				t.Fatal(deleteErr)
			}
		})
	}
	executeMigrationScript(t, pool, up)
	installed = true
	assertAIGenerationHashSplitObjects(t, pool, true)
}

func assertAIGenerationHashes(
	t *testing.T,
	pool *pgxpool.Pool,
	generationID string,
	wantAlias string,
	wantRequest string,
	wantCanonical string,
	wantCanonicalNull bool,
) {
	t.Helper()
	var alias, request, canonical string
	var canonicalNull bool
	if err := pool.QueryRow(context.Background(), `SELECT input_hash,idempotency_request_hash,
COALESCE(canonical_provider_input_hash,''),canonical_provider_input_hash IS NULL
FROM ai_generations WHERE id=$1`, generationID).Scan(&alias, &request, &canonical, &canonicalNull); err != nil {
		t.Fatal(err)
	}
	if alias != wantAlias || request != wantRequest || canonical != wantCanonical || canonicalNull != wantCanonicalNull {
		t.Fatalf("generation %s hashes = alias %q/request %q/canonical %q/null %t, want %q/%q/%q/%t",
			generationID, alias, request, canonical, canonicalNull,
			wantAlias, wantRequest, wantCanonical, wantCanonicalNull)
	}
}

func assertAIGenerationHashSplitObjects(t *testing.T, pool *pgxpool.Pool, installed bool) {
	t.Helper()
	var columns int
	var requestNotNull, canonicalNotNull, constraintValidated, trigger, function bool
	var constraintDefinition string
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='ai_generations'
   AND column_name IN ('idempotency_request_hash','canonical_provider_input_hash')),
COALESCE((SELECT attnotnull FROM pg_attribute
          WHERE attrelid='public.ai_generations'::regclass AND attname='idempotency_request_hash'),FALSE),
COALESCE((SELECT attnotnull FROM pg_attribute
          WHERE attrelid='public.ai_generations'::regclass AND attname='canonical_provider_input_hash'),FALSE),
COALESCE((SELECT convalidated FROM pg_constraint WHERE conname='ai_generations_hash_split'),FALSE),
COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='ai_generations_hash_split'),''),
EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_ai_generation_hash_split' AND NOT tgisinternal),
EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fukamu_cycle_apply_ai_generation_hash_split')`).Scan(
		&columns, &requestNotNull, &canonicalNotNull, &constraintValidated, &constraintDefinition,
		&trigger, &function); err != nil {
		t.Fatal(err)
	}
	wantColumns := 0
	if installed {
		wantColumns = 2
	}
	if columns != wantColumns || requestNotNull != installed || canonicalNotNull ||
		constraintValidated != installed || trigger != installed || function != installed {
		t.Fatalf("hash split objects = columns %d/request not null %t/canonical not null %t/constraint valid %t/trigger %t/function %t, want installed %t",
			columns, requestNotNull, canonicalNotNull, constraintValidated, trigger, function, installed)
	}
	if installed {
		normalized := strings.ToLower(strings.Join(strings.Fields(constraintDefinition), " "))
		for _, column := range []string{"input_hash", "idempotency_request_hash", "canonical_provider_input_hash"} {
			fragment := column + " ~ '^[0-9a-f]{64}$'"
			if !strings.Contains(normalized, fragment) {
				t.Fatalf("hash split CHECK = %q, missing %q", constraintDefinition, fragment)
			}
		}
	}
}

type invalidAIGenerationHash struct {
	name  string
	value string
}

func invalidAIGenerationHashes() []invalidAIGenerationHash {
	return []invalidAIGenerationHash{
		{name: "empty", value: ""},
		{name: "63 characters", value: strings.Repeat("a", 63)},
		{name: "65 characters", value: strings.Repeat("a", 65)},
		{name: "uppercase", value: strings.Repeat("A", 64)},
		{name: "non-hex", value: strings.Repeat("a", 63) + "g"},
	}
}

func assertUUIDv7Constraints(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_constraint WHERE conname LIKE '%\_uuid\_v7' ESCAPE '\'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 17 {
		t.Fatalf("UUID v7 constraint count = %d, want 17", count)
	}
	var validArray, rejectsV4Array, rejectsNullElement bool
	if err := pool.QueryRow(context.Background(), `SELECT
    fukamu_cycle_uuid_array_is_v7(ARRAY['0198c20b-7b95-7000-8000-000000000001']::uuid[]),
    NOT fukamu_cycle_uuid_array_is_v7(ARRAY['123e4567-e89b-42d3-a456-426614174000']::uuid[]),
    NOT fukamu_cycle_uuid_array_is_v7(ARRAY[NULL]::uuid[])`).Scan(&validArray, &rejectsV4Array, &rejectsNullElement); err != nil {
		t.Fatal(err)
	}
	if !validArray || !rejectsV4Array || !rejectsNullElement {
		t.Fatalf("UUID v7 array validation = valid:%t v4:%t null:%t", validArray, rejectsV4Array, rejectsNullElement)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES('123e4567-e89b-42d3-a456-426614174000',now(),now(),now())`); err == nil {
		t.Fatal("UUID v4 insert unexpectedly succeeded")
	}
}

func assertTightContentConstraints(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	expected := map[string][]string{
		"goal_versions_body_max_80":              {"char_length(body)", "<= 80"},
		"goal_drafts_body_max_80":                {"char_length(body)", "<= 80"},
		"pdca_cycles_plan_max_200":               {"char_length(plan)", "<= 200"},
		"pdca_cycles_do_max_200":                 {"char_length(do_text)", "<= 200"},
		"pdca_cycles_check_max_200":              {"char_length(check_text)", "<= 200"},
		"pdca_cycles_action_max_200":             {"char_length(action)", "<= 200"},
		"ai_generations_source_text_tight_limit": {"char_length(source_text) <= 80", "char_length(source_text) <= 200"},
		"ai_generations_output_tight_limit":      {"char_length(output) <= 80", "char_length(output) <= 200"},
	}
	names := make([]string, 0, len(expected))
	for name := range expected {
		names = append(names, name)
	}
	rows, err := pool.Query(context.Background(), `SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conname = ANY($1)`, names)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	found := 0
	for rows.Next() {
		var name, definition string
		if err := rows.Scan(&name, &definition); err != nil {
			t.Fatal(err)
		}
		found++
		for _, fragment := range expected[name] {
			if !strings.Contains(definition, fragment) {
				t.Fatalf("constraint %s = %s, missing %q", name, definition, fragment)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if found != len(expected) {
		t.Fatalf("tight content constraints found = %d, want %d", found, len(expected))
	}
}

func executeMigrationScript(t *testing.T, pool *pgxpool.Pool, script []byte) {
	t.Helper()
	connection, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	results, execErr := connection.Conn().PgConn().Exec(context.Background(), string(script)).ReadAll()
	connection.Release()
	if execErr != nil {
		t.Fatal(execErr)
	}
	for _, result := range results {
		if result.Err != nil {
			t.Fatal(result.Err)
		}
	}
}

func executeMigrationScriptExpectSQLState(t *testing.T, pool *pgxpool.Pool, script []byte, wantCode string) {
	t.Helper()
	ctx := context.Background()
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	results, execErr := connection.Conn().PgConn().Exec(ctx, string(script)).ReadAll()
	if execErr == nil {
		for _, result := range results {
			if result.Err != nil {
				execErr = result.Err
				break
			}
		}
	}
	_, rollbackErr := connection.Exec(ctx, `ROLLBACK`)
	connection.Release()
	assertPostgresSQLState(t, execErr, wantCode)
	if rollbackErr != nil {
		t.Fatalf("rollback failed migration: %v", rollbackErr)
	}
}

func assertPostgresSQLState(t *testing.T, err error, wantCode string) {
	t.Helper()
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != wantCode {
		t.Fatalf("PostgreSQL error = %v, want SQLSTATE %s", err, wantCode)
	}
}
