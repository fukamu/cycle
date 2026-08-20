package postgres

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

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
	t.Cleanup(pool.Close)
	return pool
}

func resetDatabase(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `TRUNCATE TABLE
abuse_rate_buckets,goal_delete_receipts,ai_generations,ai_usage_events,goal_drafts,pdca_cycles,
goal_versions,goals,ai_budget_monthly,sessions,auth_identities,anonymous_bootstraps,users CASCADE`)
	if err != nil {
		t.Fatal(err)
	}
}

func integrationNow() time.Time {
	return time.Date(2026, time.August, 19, 0, 0, 0, 0, time.UTC)
}
