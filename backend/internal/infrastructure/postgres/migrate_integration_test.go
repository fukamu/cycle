package postgres

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateIsTransactionalAndIdempotent(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	directory := filepath.Join("..", "..", "..", "migrations")
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
	if len(result.Applied) != 2 {
		t.Fatalf("applied migrations = %v, want 2", result.Applied)
	}
	baseline, retention := result.Applied[0], result.Applied[1]
	if baseline.Version != 1 || baseline.Direction != "up" || baseline.File != "000001_fukamu_cycle_baseline.up.sql" ||
		retention.Version != 2 || retention.Direction != "up" || retention.File != "000002_ai_usage_retention_margin.up.sql" {
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
	if version != 2 || users != 0 {
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
(operation_id,user_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES($1,$2,'goal_refine','accepted','fake','test','goal-v2',$3,$4)`,
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
