package postgres

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateIsTransactionalAndIdempotent(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS schema_migrations`)
	down := filepath.Join("..", "..", "..", "migrations", "000001_init.down.sql")
	script, err := os.ReadFile(down)
	if err != nil {
		t.Fatal(err)
	}
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
	directory := filepath.Join("..", "..", "..", "migrations")
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if err := Migrate(databaseURL, directory); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(databaseURL, directory); err != nil {
		t.Fatalf("second migration: %v", err)
	}
	var version, users int
	_ = pool.QueryRow(context.Background(), `SELECT version FROM schema_migrations`).Scan(&version)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&users)
	if version != 1 || users != 0 {
		t.Fatalf("version/users = %d/%d", version, users)
	}
}
