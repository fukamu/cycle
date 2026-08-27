package postgres

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestNormalizeMigrationDatabaseURLPinsPublicSchemaAndPreservesSafeQuery(t *testing.T) {
	normalized, err := normalizeMigrationDatabaseURL(
		"postgresql://user:password@db.example:6543/fukamu_cycle?sslmode=require&x-statement-timeout=5000",
	)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(normalized)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if parsed.Scheme != "postgresql" || parsed.Host != "db.example:6543" || parsed.Path != "/fukamu_cycle" ||
		query.Get("sslmode") != "require" || query.Get("x-statement-timeout") != "5000" ||
		query.Get("search_path") != "public" || query.Get("options") != "-c search_path=public" {
		t.Fatalf("normalized migration URL has unexpected structure: %#v / %#v", parsed, query)
	}

	second, err := normalizeMigrationDatabaseURL(normalized)
	if err != nil || second != normalized {
		t.Fatalf("normalization is not idempotent: %q/%v", second, err)
	}
}

func TestNormalizeMigrationDatabaseURLRejectsSchemaOverridesWithoutExposingInput(t *testing.T) {
	const canary = "MIGRATION_DATABASE_SECRET_CANARY"
	invalid := []string{
		"postgres://user:" + canary + "@db.example/fukamu_cycle?search_path=shadow",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?search_path=public&search_path=public",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?Search_Path=shadow",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?SEARCH_PATH=public",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?options=-c%20search_path%3Dshadow",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?options=-c%20search_path%3Dpublic&options=-c%20search_path%3Dpublic",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?Options=-c%20search_path%3Dpublic",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?x-migrations-table=shadow.schema_migrations",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?x-migrations-table-quoted=true",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?X-Migrations-Table=shadow.schema_migrations",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?X-MIGRATIONS-TABLE-QUOTED=true",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?sslmode=require;search_path=shadow",
		"postgres://user:" + canary + "@db.example/fukamu_cycle?sslmode=%zz",
	}
	for _, databaseURL := range invalid {
		databaseURL := databaseURL
		t.Run(url.QueryEscape(databaseURL), func(t *testing.T) {
			normalized, err := normalizeMigrationDatabaseURL(databaseURL)
			if normalized != "" || !errors.Is(err, ErrMigrationDatabaseConfiguration) {
				t.Fatalf("normalized/error = %q/%v, want fixed rejection", normalized, err)
			}
			if strings.Contains(err.Error(), canary) || strings.Contains(err.Error(), databaseURL) {
				t.Fatalf("migration configuration error exposed input: %v", err)
			}
		})
	}
}

func TestMigrationLogCollectorRecordsAppliedFile(t *testing.T) {
	collector := &migrationLogCollector{}
	collector.Printf("%v (%v)\n", "1/u fukamu_cycle_baseline", 1250*time.Microsecond)

	if len(collector.applied) != 1 {
		t.Fatalf("applied count = %d, want 1", len(collector.applied))
	}
	got := collector.applied[0]
	if got.Version != 1 || got.Direction != "up" || got.File != "000001_fukamu_cycle_baseline.up.sql" || got.Duration != 1250*time.Microsecond {
		t.Fatalf("applied migration = %+v", got)
	}
}

func TestMigrationLogCollectorIgnoresNonCompletionMessages(t *testing.T) {
	collector := &migrationLogCollector{}
	collector.Printf("error: %v", "migration failed")
	collector.Printf("%v (%v)\n", "invalid", time.Second)

	if !(MigrationResult{Applied: collector.applied}).NoChange() {
		t.Fatalf("applied migrations = %v, want none", collector.applied)
	}
}
