package postgres

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRetentionCleanupIndexMigrationIsAdditiveAndReversible(t *testing.T) {
	pool := integrationPool(t)
	directory := filepath.Join("..", "..", "..", "migrations")
	up, err := os.ReadFile(filepath.Join(directory, "000005_retention_cleanup_index.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile(filepath.Join(directory, "000005_retention_cleanup_index.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	installed := true
	t.Cleanup(func() {
		if !installed {
			executeMigrationScript(t, pool, up)
		}
	})

	assertRetentionCleanupIndexes(t, pool, true)
	executeMigrationScript(t, pool, down)
	installed = false
	assertRetentionCleanupIndexes(t, pool, false)
	executeMigrationScript(t, pool, up)
	installed = true
	assertRetentionCleanupIndexes(t, pool, true)
}

func TestRetentionCleanupIndexMigrationTargetsOnlyPublicSchema(t *testing.T) {
	pool := integrationPool(t)
	directory := filepath.Join("..", "..", "..", "migrations")
	up, err := os.ReadFile(filepath.Join(directory, "000005_retention_cleanup_index.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile(filepath.Join(directory, "000005_retention_cleanup_index.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	publicInstalled := true
	t.Cleanup(func() {
		if !publicInstalled {
			executeMigrationScript(t, pool, up)
		}
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS cleanup_migration_shadow CASCADE")
	})

	executeMigrationScript(t, pool, down)
	publicInstalled = false
	_, err = pool.Exec(t.Context(), `DROP SCHEMA IF EXISTS cleanup_migration_shadow CASCADE;
CREATE SCHEMA cleanup_migration_shadow;
CREATE TABLE cleanup_migration_shadow.ai_usage_events (
    operation_id uuid PRIMARY KEY,
    content_deleted boolean NOT NULL,
    quota_retain_until timestamptz NOT NULL,
    provider_usage_finalized_at timestamptz
);
CREATE TABLE cleanup_migration_shadow.abuse_rate_buckets (
    scope text NOT NULL,
    key_hash bytea NOT NULL,
    window_start timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (scope, key_hash, window_start)
);
CREATE INDEX idx_ai_usage_retention_cleanup
    ON cleanup_migration_shadow.ai_usage_events(quota_retain_until, operation_id)
    WHERE content_deleted = TRUE AND provider_usage_finalized_at IS NOT NULL;
CREATE INDEX idx_abuse_bucket_retention_cleanup
    ON cleanup_migration_shadow.abuse_rate_buckets(expires_at, scope, key_hash, window_start)`)
	if err != nil {
		t.Fatal(err)
	}

	config, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	config.MinConns = 0
	config.ConnConfig.RuntimeParams["search_path"] = "cleanup_migration_shadow,public"
	shadowPool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer shadowPool.Close()
	var currentSchema string
	if err = shadowPool.QueryRow(t.Context(), "SELECT current_schema()").Scan(&currentSchema); err != nil {
		t.Fatal(err)
	}
	if currentSchema != "cleanup_migration_shadow" {
		t.Fatalf("migration pool current_schema = %q, want cleanup_migration_shadow", currentSchema)
	}

	executeMigrationScript(t, shadowPool, up)
	publicInstalled = true
	assertRetentionCleanupIndexes(t, pool, true)
	assertShadowRetentionCleanupIndexes(t, pool)

	executeMigrationScript(t, shadowPool, down)
	publicInstalled = false
	assertRetentionCleanupIndexes(t, pool, false)
	assertShadowRetentionCleanupIndexes(t, pool)

	executeMigrationScript(t, shadowPool, up)
	publicInstalled = true
	assertRetentionCleanupIndexes(t, pool, true)
	assertShadowRetentionCleanupIndexes(t, pool)
}

func assertShadowRetentionCleanupIndexes(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*)
FROM pg_indexes
WHERE schemaname='cleanup_migration_shadow'
  AND indexname IN ('idx_ai_usage_retention_cleanup','idx_abuse_bucket_retention_cleanup')`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("shadow cleanup indexes = %d, want 2", count)
	}
}

func assertRetentionCleanupIndexes(t *testing.T, pool *pgxpool.Pool, installed bool) {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT indexname,indexdef
FROM pg_indexes
WHERE schemaname='public'
  AND indexname IN ('idx_ai_usage_retention_cleanup','idx_abuse_bucket_retention_cleanup')
ORDER BY indexname`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	definitions := map[string]string{}
	for rows.Next() {
		var name, definition string
		if err = rows.Scan(&name, &definition); err != nil {
			t.Fatal(err)
		}
		definitions[name] = strings.ToLower(strings.Join(strings.Fields(definition), " "))
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !installed {
		if len(definitions) != 0 {
			t.Fatalf("cleanup indexes remain after down: %v", definitions)
		}
		return
	}
	if len(definitions) != 2 {
		t.Fatalf("cleanup indexes = %v, want both", definitions)
	}
	ai := definitions["idx_ai_usage_retention_cleanup"]
	for _, fragment := range []string{
		"(quota_retain_until, operation_id)",
		"where ((content_deleted = true) and (provider_usage_finalized_at is not null))",
	} {
		if !strings.Contains(ai, fragment) {
			t.Errorf("AI cleanup index %q is missing %q", ai, fragment)
		}
	}
	abuse := definitions["idx_abuse_bucket_retention_cleanup"]
	if !strings.Contains(abuse, "(expires_at, scope, key_hash, window_start)") || strings.Contains(abuse, " where ") {
		t.Errorf("abuse cleanup index = %q", abuse)
	}
}
