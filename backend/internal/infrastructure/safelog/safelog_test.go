package safelog

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"math"
	"slices"
	"strings"
	"testing"
)

func TestJSONLoggerEmitsOnlySourceOfTruthFields(t *testing.T) {
	var output bytes.Buffer
	logger := NewJSON(&output)
	logger.LogAttrs(t.Context(), slog.LevelInfo, "GOAL BODY CANARY",
		slog.String("request_id", "0198c20b-7b95-7000-8000-000000000001"),
		slog.String("trace_id", "11111111111111111111111111111111"),
		slog.String("route_template", "/api/v1/goals/{goalId}"),
		slog.String("method", "GET"),
		slog.Int("status_code", 200),
		slog.Int64("latency_ms", 12),
		slog.String("error_class", "request_failed"),
		slog.String("error_code", "REQUEST_FAILED"),
		slog.Uint64("failure_count", 2),
		slog.String("operation", "http_request"),
		slog.String("goal_state_from", "active_cycle"),
		slog.String("goal_state_to", "goal_review"),
		slog.String("cycle_state_from", "active"),
		slog.String("cycle_state_to", "completed"),
		slog.String("ai_generation_id", "0198c20b-7b95-7000-8000-000000000002"),
		slog.String("ai_operation_type", "goal_refine"),
		slog.String("ai_model", "gpt-5.6-luna"),
		slog.String("prompt_version", "goal-refine-v2"),
		slog.Int64("input_tokens", 100),
		slog.Int64("output_tokens", 20),
		slog.Float64("estimated_cost_usd", 0.002),
		slog.Int64("provider_latency_ms", 300),
		slog.Int("context_cycle_count", 3),
		slog.Bool("context_changed", true),
		slog.Uint64("migration_version", 4),
		slog.String("migration_direction", "up"),
		slog.String("migration_file", "000004_ai_generation_hash_split.up.sql"),
		slog.Float64("migration_duration_ms", 4.5),
		slog.Int("migration_applied_count", 1),
		slog.Bool("migration_no_change", false),
		slog.String("cleanup_mode", "execute"),
		slog.String("cleanup_resource", "ai_usage_events"),
		slog.Int64("cleanup_candidate_count", 4),
		slog.Int64("cleanup_deleted_count", 4),
		slog.Int64("cleanup_batch_count", 2),
		slog.String("database_url", "postgres://secret@database/private"),
		slog.String("raw_ip", "203.0.113.10"),
		slog.Group("nested", slog.String("operation", "SESSION_TOKEN_CANARY")),
	)

	record := decodeRecord(t, output.String())
	want := map[string]struct{}{"timestamp": {}, "severity": {}}
	for field := range allowedFields {
		want[field] = struct{}{}
	}
	if len(record) != len(want) {
		t.Fatalf("log fields = %v, want exactly %v", sortedKeys(record), sortedKeys(want))
	}
	for field := range record {
		if _, allowed := want[field]; !allowed {
			t.Errorf("unexpected log field %q", field)
		}
	}
	for _, canary := range []string{"GOAL BODY CANARY", "postgres://", "secret@database", "203.0.113.10", "SESSION_TOKEN_CANARY", `"msg"`, `"time"`, `"level"`} {
		if strings.Contains(output.String(), canary) {
			t.Errorf("log leaked forbidden canary %q: %s", canary, output.String())
		}
	}
}

func TestJSONLoggerRejectsMalformedAllowedFieldValues(t *testing.T) {
	var output bytes.Buffer
	NewJSON(&output).LogAttrs(t.Context(), slog.LevelInfo, "OPENAI_KEY_CANARY",
		slog.String(slog.TimeKey, "TIME_BODY_CANARY"),
		slog.String(slog.LevelKey, "LEVEL_SECRET_CANARY"),
		slog.String("request_id", "0198c20b-7b95-4000-8000-000000000001"),
		slog.String("ai_generation_id", "0198C20B-7B95-7000-8000-000000000002"),
		slog.String("trace_id", strings.Repeat("0", 32)),
		slog.String("route_template", "/api/v1/goals/0198c20b-7b95-7000-8000-000000000001"),
		slog.String("method", "PRIVATE@example.com"),
		slog.Int("status_code", 999),
		slog.Int64("latency_ms", -1),
		slog.String("error_class", "private value with spaces"),
		slog.String("migration_file", "../../private.sql"),
		slog.Float64("estimated_cost_usd", math.Inf(1)),
		slog.String("migration_no_change", "SESSION_TOKEN_CANARY"),
		slog.String("cleanup_mode", "GOAL_BODY_CANARY"),
		slog.String("cleanup_resource", "private_table"),
		slog.Int64("cleanup_candidate_count", -1),
	)
	record := decodeRecord(t, output.String())
	if len(record) != 2 || record["timestamp"] == nil || record["severity"] == nil {
		t.Fatalf("invalid values were not fail-closed: %v", record)
	}
	for _, canary := range []string{"OPENAI_KEY_CANARY", "TIME_BODY_CANARY", "LEVEL_SECRET_CANARY", "0198c20b-7b95-4000-8000-000000000001", "0198C20B", "/api/v1/goals/0198c20b-7b95-7000-8000-000000000001", "SESSION_TOKEN_CANARY", "../../private.sql"} {
		if strings.Contains(output.String(), canary) {
			t.Errorf("log leaked malformed value %q: %s", canary, output.String())
		}
	}
}

func TestRouteTemplateUsesClosedChiCatalog(t *testing.T) {
	for route := range allowedHTTPRoutes {
		var output bytes.Buffer
		NewJSON(&output).LogAttrs(t.Context(), slog.LevelInfo, "", slog.String("route_template", route))
		if got := decodeRecord(t, output.String())["route_template"]; got != route {
			t.Errorf("allowed route %q emitted as %#v", route, got)
		}
	}
	var output bytes.Buffer
	const resourcePath = "/api/v1/goals/0198c20b-7b95-7000-8000-000000000099"
	NewJSON(&output).LogAttrs(t.Context(), slog.LevelInfo, "", slog.String("route_template", resourcePath))
	if got := decodeRecord(t, output.String())["route_template"]; got != nil || strings.Contains(output.String(), resourcePath) {
		t.Fatalf("resource path passed route-template allowlist: %s", output.String())
	}
}

func TestHTTPServerErrorLogDropsPanicRemoteAddressAndStack(t *testing.T) {
	var output bytes.Buffer
	errorLog := NewHTTPServerErrorLog(NewJSON(&output))
	const diagnostic = "http: panic serving 203.0.113.10:54321: GOAL_BODY_CANARY\ngoroutine stack SESSION_TOKEN_CANARY"
	for call := 1; call <= 4; call++ {
		if written, err := errorLog.Writer().Write([]byte(diagnostic)); err != nil || written != len(diagnostic) {
			t.Fatalf("write %d = %d/%v", call, written, err)
		}
	}
	logs := strings.TrimSpace(output.String())
	lines := strings.Split(logs, "\n")
	if len(lines) != 3 {
		t.Fatalf("power-of-two bounded diagnostics = %d, want 3: %s", len(lines), logs)
	}
	for _, line := range lines {
		record := decodeRecord(t, line)
		if record["operation"] != "http_server_diagnostic" || record["error_class"] != "http_server_internal_error" {
			t.Fatalf("unsafe HTTP diagnostic = %v", record)
		}
	}
	for _, canary := range []string{"203.0.113.10", "GOAL_BODY_CANARY", "goroutine", "SESSION_TOKEN_CANARY"} {
		if strings.Contains(logs, canary) {
			t.Errorf("HTTP diagnostic leaked %q: %s", canary, logs)
		}
	}
}

func decodeRecord(t *testing.T, line string) map[string]any {
	t.Helper()
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &record); err != nil {
		t.Fatalf("decode log %q: %v", line, err)
	}
	return record
}

func sortedKeys[V any](values map[string]V) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	slices.Sort(result)
	return result
}
