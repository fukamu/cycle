package postgres

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const integrationAIRequestHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set; use only a disposable PostgreSQL database")
	}
	if _, err := Migrate(databaseURL, filepath.Join("..", "..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	var contentEncryptionHead bool
	if err = pool.QueryRow(context.Background(), `SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='goal_version_success_signals'
    AND column_name='content_storage_format'
)`).Scan(&contentEncryptionHead); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	if !contentEncryptionHead {
		up, readErr := os.ReadFile(filepath.Join("..", "..", "..", "migrations", "000010_user_content_encryption_expand.up.sql"))
		if readErr != nil {
			pool.Close()
			t.Fatal(readErr)
		}
		executeMigrationScript(t, pool, up)
	}
	t.Cleanup(pool.Close)
	return pool
}

func resetDatabase(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `TRUNCATE TABLE
launch_allowed_users,anonymous_rate_limit_guards,abuse_rate_buckets,goal_delete_receipts,ai_generations,ai_usage_events,goal_drafts,pdca_cycle_review_schedules,pdca_cycles,
goal_versions,goals,ai_budget_monthly,sessions,auth_identities,anonymous_bootstraps,users,content_encryption_jobs CASCADE;
UPDATE content_encryption_control SET mode='legacy',generation=0,updated_at=now() WHERE singleton=TRUE;
UPDATE launch_config SET public_access_enabled=FALSE,updated_at=now() WHERE singleton=TRUE`)
	if err != nil {
		t.Fatal(err)
	}
}

func integrationNow() time.Time {
	return time.Date(2026, time.August, 19, 0, 0, 0, 0, time.UTC)
}
