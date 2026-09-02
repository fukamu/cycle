// Package safelog owns the only production structured-log output boundary.
// It deliberately drops messages, groups, unknown fields, and values whose
// shape is not appropriate for their Source-of-Truth field.
package safelog

import (
	"context"
	"encoding/hex"
	"io"
	"log"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"sync/atomic"
)

var (
	canonicalUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	stableTokenPattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,127}$`)
	migrationFilePattern = regexp.MustCompile(`^[0-9]{6}_[a-z0-9_]+\.(up|down)\.sql$`)
)

var allowedHTTPRoutes = map[string]struct{}{
	"unmatched": {}, "/*": {}, "/healthz": {}, "/readyz": {},
	"/api/v1/session/anonymous": {}, "/api/v1/session": {}, "/api/v1/home": {},
	"/api/v1/goal-drafts": {}, "/api/v1/goal-drafts/{draftId}": {},
	"/api/v1/goal-drafts/{draftId}/refinements":                      {},
	"/api/v1/goal-drafts/{draftId}/refinements/{generationId}/adopt": {},
	"/api/v1/goal-drafts/{draftId}/start":                            {},
	"/api/v1/goals":                                                  {}, "/api/v1/goals/{goalId}": {},
	"/api/v1/goals/{goalId}/termination": {}, "/api/v1/goals/{goalId}/review": {},
	"/api/v1/goals/{goalId}/review/refinements":                      {},
	"/api/v1/goals/{goalId}/review/refinements/{generationId}/adopt": {},
	"/api/v1/goals/{goalId}/review/continue":                         {}, "/api/v1/goals/{goalId}/cycles": {},
	"/api/v1/goals/{goalId}/cycles/{cycleId}":                  {},
	"/api/v1/goals/{goalId}/cycles/{cycleId}/frames/{frame}":   {},
	"/api/v1/goals/{goalId}/cycles/{cycleId}/actions/generate": {},
	"/api/v1/goals/{goalId}/cycles/{cycleId}/actions/refine":   {},
	"/api/v1/goals/{goalId}/cycles/{cycleId}/complete":         {},
	"/api/v1/auth/google/upgrade":                              {}, "/api/v1/auth/google/login": {}, "/api/v1/account": {},
}

var allowedFields = map[string]struct{}{
	"request_id": {}, "trace_id": {}, "route_template": {}, "method": {},
	"status_code": {}, "latency_ms": {}, "error_class": {}, "error_code": {},
	"failure_count": {}, "operation": {}, "goal_state_from": {}, "goal_state_to": {},
	"cycle_state_from": {}, "cycle_state_to": {}, "ai_generation_id": {},
	"ai_operation_type": {}, "ai_model": {}, "prompt_version": {}, "input_tokens": {},
	"output_tokens": {}, "estimated_cost_usd": {}, "provider_latency_ms": {},
	"context_cycle_count": {}, "context_changed": {}, "migration_version": {},
	"migration_direction": {}, "migration_file": {}, "migration_duration_ms": {},
	"migration_applied_count": {}, "migration_no_change": {},
	"cleanup_mode": {}, "cleanup_resource": {}, "cleanup_candidate_count": {},
	"cleanup_deleted_count": {}, "cleanup_batch_count": {},
}

// NewJSON returns a logger that emits only the exact fields allowed by
// docs/design.md section 42.2. The free-form record message is never emitted.
func NewJSON(destination io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(destination, &slog.HandlerOptions{
		ReplaceAttr: replaceAttribute,
	}))
}

func replaceAttribute(groups []string, attribute slog.Attr) slog.Attr {
	if len(groups) != 0 {
		return slog.Attr{}
	}
	switch attribute.Key {
	case slog.TimeKey:
		if attribute.Value.Kind() != slog.KindTime {
			return slog.Attr{}
		}
		attribute.Key = "timestamp"
		return attribute
	case slog.LevelKey:
		attribute.Value = attribute.Value.Resolve()
		if attribute.Value.Kind() != slog.KindAny {
			return slog.Attr{}
		}
		if _, ok := attribute.Value.Any().(slog.Level); !ok {
			return slog.Attr{}
		}
		attribute.Key = "severity"
		return attribute
	case slog.MessageKey, slog.SourceKey, "timestamp", "severity":
		return slog.Attr{}
	}
	if _, allowed := allowedFields[attribute.Key]; !allowed {
		return slog.Attr{}
	}
	attribute.Value = attribute.Value.Resolve()
	if !safeValue(attribute.Key, attribute.Value) {
		return slog.Attr{}
	}
	return attribute
}

func safeValue(key string, value slog.Value) bool {
	switch key {
	case "request_id", "ai_generation_id":
		return value.Kind() == slog.KindString && canonicalUUIDPattern.MatchString(value.String())
	case "trace_id":
		return value.Kind() == slog.KindString && validTraceID(value.String())
	case "route_template":
		if value.Kind() != slog.KindString {
			return false
		}
		_, allowed := allowedHTTPRoutes[value.String()]
		return allowed
	case "method":
		if value.Kind() != slog.KindString {
			return false
		}
		switch value.String() {
		case "CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE", "OTHER":
			return true
		default:
			return false
		}
	case "migration_direction":
		return value.Kind() == slog.KindString && (value.String() == "up" || value.String() == "down")
	case "cleanup_mode":
		return value.Kind() == slog.KindString && (value.String() == "dry_run" || value.String() == "execute")
	case "cleanup_resource":
		return value.Kind() == slog.KindString && (value.String() == "ai_usage_events" ||
			value.String() == "abuse_rate_buckets" || value.String() == "anonymous_rate_limit_guards")
	case "migration_file":
		return value.Kind() == slog.KindString && migrationFilePattern.MatchString(value.String())
	case "error_class", "error_code", "operation", "goal_state_from", "goal_state_to",
		"cycle_state_from", "cycle_state_to", "ai_operation_type", "ai_model", "prompt_version":
		return value.Kind() == slog.KindString && stableTokenPattern.MatchString(value.String())
	case "status_code":
		status, ok := integerValue(value)
		return ok && status >= 100 && status <= 599
	case "failure_count", "input_tokens", "output_tokens", "context_cycle_count",
		"migration_version", "migration_applied_count", "cleanup_candidate_count",
		"cleanup_deleted_count", "cleanup_batch_count":
		count, ok := integerValue(value)
		return ok && count >= 0
	case "latency_ms", "provider_latency_ms", "migration_duration_ms", "estimated_cost_usd":
		number, ok := numberValue(value)
		return ok && number >= 0 && !math.IsInf(number, 0) && !math.IsNaN(number)
	case "context_changed", "migration_no_change":
		return value.Kind() == slog.KindBool
	default:
		return false
	}
}

func validTraceID(value string) bool {
	if len(value) != 32 || value != strings.ToLower(value) {
		return false
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return false
	}
	for _, item := range decoded {
		if item != 0 {
			return true
		}
	}
	return false
}

func integerValue(value slog.Value) (int64, bool) {
	switch value.Kind() {
	case slog.KindInt64:
		return value.Int64(), true
	case slog.KindUint64:
		if value.Uint64() > math.MaxInt64 {
			return 0, false
		}
		return int64(value.Uint64()), true
	default:
		return 0, false
	}
}

func numberValue(value slog.Value) (float64, bool) {
	if integer, ok := integerValue(value); ok {
		return float64(integer), true
	}
	if value.Kind() != slog.KindFloat64 {
		return 0, false
	}
	return value.Float64(), true
}

// NewHTTPServerErrorLog converts net/http's free-form diagnostics (including
// panic values, raw remote addresses, and stacks) to a bounded fixed event.
func NewHTTPServerErrorLog(logger *slog.Logger) *log.Logger {
	return log.New(&httpServerErrorWriter{logger: logger}, "", 0)
}

type httpServerErrorWriter struct {
	logger *slog.Logger
	count  atomic.Uint64
}

func (writer *httpServerErrorWriter) Write(input []byte) (int, error) {
	count := writer.count.Add(1)
	if writer.logger != nil && (count == 1 || count&(count-1) == 0) {
		writer.logger.LogAttrs(context.Background(), slog.LevelError, "",
			slog.String("operation", "http_server_diagnostic"),
			slog.String("error_class", "http_server_internal_error"),
			slog.Uint64("failure_count", count),
		)
	}
	return len(input), nil
}
