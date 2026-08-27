package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
	"github.com/fukamu/cycle/backend/internal/infrastructure/safelog"
)

func TestLogMigrationResultClassifiesFailureWithoutRawError(t *testing.T) {
	const errorCanary = "DATABASE_URL_GOAL_BODY_SESSION_TOKEN_CANARY"
	var output bytes.Buffer
	exitCode := logMigrationResult(safelog.NewJSON(&output), postgres.MigrationResult{
		Applied: []postgres.AppliedMigration{{
			Version: 4, Direction: "up", File: "000004_ai_generation_hash_split.up.sql", Duration: 3 * time.Millisecond,
		}},
	}, errors.New(errorCanary))
	if exitCode != 1 {
		t.Fatalf("exit code = %d, want 1", exitCode)
	}
	if strings.Contains(output.String(), errorCanary) {
		t.Fatalf("migration log leaked raw error: %s", output.String())
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("migration log lines = %d, want applied + failure: %s", len(lines), output.String())
	}
	var failure map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &failure); err != nil {
		t.Fatal(err)
	}
	if failure["operation"] != "migration_apply" || failure["error_class"] != "migration_failed" {
		t.Fatalf("migration failure classification = %v", failure)
	}
	if _, present := failure["error"]; present {
		t.Fatalf("raw error field was emitted: %v", failure)
	}
}
