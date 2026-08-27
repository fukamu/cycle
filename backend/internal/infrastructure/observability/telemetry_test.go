package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestMetricsExposeCompleteServerSideSoTContract(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
	})
	metrics, err := NewMetrics(provider, nil, []float64{0.5, 0.8})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	metrics.ObserveHTTP(ctx, "/api/v1/goals/{goalId}/cycles/{cycleId}", 200, 10*time.Millisecond)
	metrics.ObserveAutosave(ctx, "creation_draft", "conflict", 5*time.Millisecond)
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricGoalCreationDraftCreated})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricGoalStarted})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricGoalReviewOpened})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event: workspace.WorkspaceMetricGoalReviewContinued, VersionChanged: true,
	})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event: workspace.WorkspaceMetricGoalTerminal, Outcome: goal.StatusEnded, SourceState: goal.StatusGoalReview,
	})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event: workspace.WorkspaceMetricGoalDeleted, SourceState: goal.StatusEnded, Result: "success",
	})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricGoalVersionCreated})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricProgressingGoalLimitRejected})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricProgressingGoalLimitInvariantViolation})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricCycleStarted})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricCycleCompleted})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event: workspace.WorkspaceMetricCycleCanceled, CancellationReason: cycle.CancellationGoalEnded,
	})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event:     workspace.WorkspaceMetricAIProviderAttempt,
		Operation: domainai.OperationActionGenerate, Result: "success",
	})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event: workspace.WorkspaceMetricAICostSettlement, SettlementPath: "normal", Result: "success",
	})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event: workspace.WorkspaceMetricAISuggestionAdopted, SuggestionSource: "creation",
	})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricAIQuotaRejected})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{Event: workspace.WorkspaceMetricAIBudgetRejected})
	metrics.ObserveWorkspace(ctx, workspace.WorkspaceObservation{
		Event: workspace.WorkspaceMetricRateLimitRejected, Scope: "ai",
	})
	metrics.RateLimitRejected(ctx, "goal_start")
	metrics.AIUnattributedCost(ctx, 0.125)
	metrics.AIContextIsolationViolation(ctx)
	metrics.AccountUpgrade(ctx, "success")
	metrics.GoogleLogin(ctx, "success")
	metrics.AccountDelete(ctx, "success")
	metrics.AnonymousCreate(ctx, "idempotent")
	metrics.TurnstileVerification(ctx, "success")
	metrics.ErrorCode(ctx, "VALIDATION_ERROR")
	metrics.ErrorCode(ctx, "RATE_LIMIT_EXCEEDED")
	metrics.ObserveAIGeneration(ctx, AIObservation{
		GenerationID: "00000000-0000-7000-8000-000000000001",
		Operation:    string(domainai.OperationActionGenerate),
		Result:       "success", Model: "gpt-5.6-luna", PromptVersion: "action-generate-v1",
		Usage: AIUsage{InputTokens: 10, OutputTokens: 5}, EstimatedCostUSD: 0.01,
		ContextCycleCount: 2, CurrentTruncated: true, ContextChanged: true,
		BudgetUsageRatio: 0.5, ProviderDuration: 7 * time.Millisecond, Duration: 20 * time.Millisecond,
	})

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &collected); err != nil {
		t.Fatal(err)
	}
	measurements := make(map[string]metricdata.Metrics)
	for _, scope := range collected.ScopeMetrics {
		if scope.Scope.Name != metricScopeName {
			t.Errorf("metric scope = %q, want %q", scope.Scope.Name, metricScopeName)
		}
		for _, measurement := range scope.Metrics {
			sanitized, ok := sanitizeMetric(measurement)
			if !ok || sanitized.Name != measurement.Name {
				t.Errorf("metric %q was silently dropped or renamed by the export sanitizer", measurement.Name)
				continue
			}
			measurements[sanitized.Name] = sanitized
		}
	}

	contract := map[string]metricContractExpectation{
		"http_requests_total":                              {labels: []string{"route", "status_class"}},
		"http_request_duration_ms":                         {unit: "ms", labels: []string{"route"}},
		"autosave_total":                                   {labels: []string{"resource_type", "result"}},
		"autosave_duration_ms":                             {unit: "ms", labels: []string{"resource_type"}},
		"revision_conflict_total":                          {labels: []string{"resource_type"}},
		"goal_creation_draft_created_total":                {},
		"goal_started_total":                               {},
		"goal_review_opened_total":                         {},
		"goal_review_continued_total":                      {labels: []string{"version_changed"}},
		"goal_terminal_total":                              {labels: []string{"outcome", "source_state"}},
		"goal_deleted_total":                               {labels: []string{"source_state", "result"}},
		"goal_version_created_total":                       {},
		"progressing_goal_limit_rejected_total":            {},
		"progressing_goal_limit_invariant_violation_total": {},
		"cycle_started_total":                              {},
		"cycle_completed_total":                            {},
		"cycle_canceled_total":                             {labels: []string{"reason"}},
		"ai_generation_total":                              {labels: []string{"operation_type", "result", "model", "prompt_version"}},
		"ai_generation_duration_ms":                        {unit: "ms", labels: []string{"operation_type", "model"}},
		"ai_provider_attempt_total":                        {labels: []string{"operation_type", "result"}},
		"ai_input_tokens_total":                            {unit: "{token}", labels: []string{"model"}},
		"ai_output_tokens_total":                           {unit: "{token}", labels: []string{"model"}},
		"ai_estimated_cost_usd_total":                      {unit: "USD", labels: []string{"model"}},
		"ai_unattributed_cost_usd_total":                   {unit: "USD"},
		"ai_cost_settlement_total":                         {labels: []string{"path", "result"}},
		"ai_context_cycle_count":                           {unit: "{cycle}", labels: []string{"operation_type"}},
		"ai_context_current_truncated_total":               {labels: []string{"operation_type"}},
		"ai_context_changed_total":                         {labels: []string{"operation_type"}},
		"ai_suggestion_adopted_total":                      {labels: []string{"source_type"}},
		"ai_context_isolation_violation_total":             {},
		"ai_quota_rejected_total":                          {},
		"ai_budget_rejected_total":                         {},
		"anonymous_create_total":                           {labels: []string{"result"}},
		"account_upgrade_total":                            {labels: []string{"result"}},
		"google_login_total":                               {labels: []string{"result"}},
		"account_delete_total":                             {labels: []string{"result"}},
		"rate_limit_rejected_total":                        {labels: []string{"scope"}},
		"turnstile_verification_total":                     {labels: []string{"result"}},
		"error_code_total":                                 {labels: []string{"code"}},
	}
	if len(contract) != 39 {
		t.Fatalf("active server-side metric contract contains %d metrics, want 39", len(contract))
	}
	for name, expectation := range contract {
		measurement, ok := measurements[name]
		if !ok {
			t.Errorf("required metric %q was not collected", name)
			continue
		}
		assertMetricContract(t, measurement, expectation)
	}
	if _, ok := measurements["draft_recovery_total"]; ok {
		t.Error("owner-gated browser draft_recovery_total must not be defined by the Backend")
	}
	assertMetricLabel(t, measurements["ai_generation_total"], "operation_type", "action_generate")
	assertMetricHasNoLabel(t, measurements["ai_generation_total"], "type")
	assertMetricLabel(t, measurements["ai_suggestion_adopted_total"], "source_type", "creation")
	assertMetricLabel(t, measurements["goal_review_continued_total"], "version_changed", "true")
	assertMetricLabel(t, measurements["rate_limit_rejected_total"], "scope", "ai")
	assertMetricLabel(t, measurements["rate_limit_rejected_total"], "scope", "goal_start")
	assertMetricLabel(t, measurements["error_code_total"], "code", "RATE_LIMIT_EXCEEDED")
}

func TestMetricLogUsesOnlySafeCorrelationAndProviderDuration(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = meterProvider.Shutdown(context.Background()) })
	metrics, err := NewMetrics(meterProvider, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	traceProvider := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = traceProvider.Shutdown(context.Background()) })
	ctx, span := traceProvider.Tracer("test").Start(context.Background(), "test")
	ctx = ports.WithRequestCorrelation(ctx, "00000000-0000-7000-8000-000000000010")
	ctx = ports.WithAIGenerationCorrelation(
		ctx,
		"00000000-0000-7000-8000-000000000011",
		"action_generate",
	)
	metrics.ObserveAIGeneration(ctx, AIObservation{
		Operation: "action_generate", Result: "success", Model: "gpt-5.6-luna",
		PromptVersion: "action-generate-v1", ProviderDuration: 7 * time.Millisecond,
		Duration: 70 * time.Millisecond,
	})
	span.End()

	var record map[string]any
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{
		"request_id":          "00000000-0000-7000-8000-000000000010",
		"ai_generation_id":    "00000000-0000-7000-8000-000000000011",
		"ai_operation_type":   "action_generate",
		"provider_latency_ms": float64(7),
	} {
		if got := record[key]; got != want {
			t.Errorf("log %s = %#v, want %#v", key, got, want)
		}
	}
	if traceID, _ := record["trace_id"].(string); traceID == "" {
		t.Error("metric log is missing trace_id")
	}
	for _, forbidden := range []string{"result", "current_truncated", "threshold", "usage_ratio", "scope", "generation_type"} {
		if _, exists := record[forbidden]; exists {
			t.Errorf("metric log retained forbidden field %q", forbidden)
		}
	}
}

type metricContractExpectation struct {
	unit   string
	labels []string
}

func assertMetricContract(t *testing.T, measurement metricdata.Metrics, expectation metricContractExpectation) {
	t.Helper()
	if measurement.Unit != expectation.unit {
		t.Errorf("metric %q unit = %q, want %q", measurement.Name, measurement.Unit, expectation.unit)
	}
	sets := metricAttributeSets(measurement)
	if len(sets) == 0 {
		t.Errorf("metric %q has no exported data points", measurement.Name)
		return
	}
	for _, set := range sets {
		if set.Len() != len(expectation.labels) {
			t.Errorf("metric %q label keys = %#v, want exactly %#v", measurement.Name, set.ToSlice(), expectation.labels)
			continue
		}
		for _, key := range expectation.labels {
			if _, ok := set.Value(attribute.Key(key)); !ok {
				t.Errorf("metric %q is missing label key %q from %#v", measurement.Name, key, set.ToSlice())
			}
		}
	}
}

func assertMetricLabel(t *testing.T, measurement metricdata.Metrics, key, want string) {
	t.Helper()
	for _, set := range metricAttributeSets(measurement) {
		if value, ok := set.Value(attribute.Key(key)); ok && value.AsString() == want {
			return
		}
	}
	t.Errorf("metric %q has no %s=%q label", measurement.Name, key, want)
}

func assertMetricHasNoLabel(t *testing.T, measurement metricdata.Metrics, key string) {
	t.Helper()
	for _, set := range metricAttributeSets(measurement) {
		if _, ok := set.Value(attribute.Key(key)); ok {
			t.Errorf("metric %q retained forbidden label %q", measurement.Name, key)
		}
	}
}

func metricAttributeSets(measurement metricdata.Metrics) []attribute.Set {
	switch data := measurement.Data.(type) {
	case metricdata.Gauge[int64]:
		return dataPointAttributeSets(data.DataPoints)
	case metricdata.Gauge[float64]:
		return dataPointAttributeSets(data.DataPoints)
	case metricdata.Sum[int64]:
		return dataPointAttributeSets(data.DataPoints)
	case metricdata.Sum[float64]:
		return dataPointAttributeSets(data.DataPoints)
	case metricdata.Histogram[int64]:
		result := make([]attribute.Set, 0, len(data.DataPoints))
		for _, point := range data.DataPoints {
			result = append(result, point.Attributes)
		}
		return result
	case metricdata.Histogram[float64]:
		result := make([]attribute.Set, 0, len(data.DataPoints))
		for _, point := range data.DataPoints {
			result = append(result, point.Attributes)
		}
		return result
	default:
		return nil
	}
}

func dataPointAttributeSets[N int64 | float64](points []metricdata.DataPoint[N]) []attribute.Set {
	result := make([]attribute.Set, 0, len(points))
	for _, point := range points {
		result = append(result, point.Attributes)
	}
	return result
}
