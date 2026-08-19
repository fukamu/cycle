package observability

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestMetricsExposeRequiredInstruments(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
	})
	metrics, err := NewMetrics(nil, []float64{0.5, 0.8})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	metrics.ObserveHTTP(ctx, "/api/v1/goals/{goalId}/cycles/{cycleId}", 200, 10*time.Millisecond)
	metrics.ObserveAutosave(ctx, "success", 5*time.Millisecond)
	metrics.CycleCompleted(ctx)
	metrics.AccountUpgrade(ctx, "success")
	metrics.AccountDelete(ctx, "success")
	metrics.AnonymousCreate(ctx, "success")
	metrics.RateLimitRejected(ctx, "ai")
	metrics.AIContextIsolationViolation(ctx)
	metrics.ErrorCode(ctx, "VALIDATION_ERROR")
	metrics.ObserveAIGeneration(ctx, AIObservation{
		Type: "action_generate", Result: "success", Model: "test", PromptVersion: "v1",
		Usage: AIUsage{InputTokens: 10, OutputTokens: 5}, EstimatedCostUSD: 0.01,
		ContextCycleCount: 2, CurrentTruncated: true, BudgetUsageRatio: 0.5, Duration: 20 * time.Millisecond,
	})

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &collected); err != nil {
		t.Fatal(err)
	}
	names := make(map[string]bool)
	for _, scope := range collected.ScopeMetrics {
		for _, measurement := range scope.Metrics {
			names[measurement.Name] = true
		}
	}
	for _, required := range []string{
		"http_requests_total", "http_request_duration_ms", "autosave_total", "autosave_duration_ms",
		"cycle_completed_total", "ai_generation_total", "ai_generation_duration_ms", "ai_input_tokens_total",
		"ai_output_tokens_total", "ai_estimated_cost_usd_total", "ai_context_cycle_count",
		"ai_context_current_truncated_total", "ai_context_isolation_violation_total", "ai_budget_usage_ratio", "account_upgrade_total",
		"account_delete_total", "anonymous_create_total", "rate_limit_rejected_total", "error_code_total",
		"ai_budget_warning_total",
	} {
		if !names[required] {
			t.Errorf("required metric %q was not collected", required)
		}
	}
}
