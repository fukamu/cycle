package postgres

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateIsTransactionalAndIdempotent(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS schema_migrations`)
	directory := filepath.Join("..", "..", "..", "migrations")
	down := filepath.Join(directory, "000001_pdcai_baseline.down.sql")
	script, err := os.ReadFile(down)
	if err != nil {
		t.Fatal(err)
	}
	executeMigrationScript(t, pool, script)

	baselineDirectory := t.TempDir()
	for _, name := range []string{"000001_pdcai_baseline.up.sql", "000001_pdcai_baseline.down.sql"} {
		contents, readErr := os.ReadFile(filepath.Join(directory, name))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if writeErr := os.WriteFile(filepath.Join(baselineDirectory, name), contents, 0o600); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if err := Migrate(databaseURL, baselineDirectory); err != nil {
		t.Fatal(err)
	}
	legacyBody := strings.Repeat("界", 81)
	_, err = pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES('10000000-0000-4000-8000-000000000001',now(),now(),now())`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(context.Background(), `INSERT INTO goal_drafts(id,user_id,draft_type,body,created_at,updated_at)
VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','creation',$1,now(),now())`, legacyBody)
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(databaseURL, directory); err == nil || !strings.Contains(err.Error(), "content exceeds the new goal") {
		t.Fatalf("oversize legacy migration error = %v", err)
	}
	var preserved string
	if err := pool.QueryRow(context.Background(), `SELECT body FROM goal_drafts WHERE id='20000000-0000-4000-8000-000000000001'`).Scan(&preserved); err != nil {
		t.Fatal(err)
	}
	if preserved != legacyBody {
		t.Fatalf("legacy content was changed: length = %d", len([]rune(preserved)))
	}

	executeMigrationScript(t, pool, script)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS schema_migrations`)
	if err := Migrate(databaseURL, directory); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(databaseURL, directory); err != nil {
		t.Fatalf("second migration: %v", err)
	}
	var version, users int
	_ = pool.QueryRow(context.Background(), `SELECT version FROM schema_migrations`).Scan(&version)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&users)
	if version != 2 || users != 0 {
		t.Fatalf("version/users = %d/%d", version, users)
	}
	assertTightContentConstraints(t, pool)
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
