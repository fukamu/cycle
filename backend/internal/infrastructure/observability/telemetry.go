package observability

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

type AIUsage struct {
	InputTokens  int64
	OutputTokens int64
}

type AIObservation struct {
	GenerationID      string
	Operation         string
	Result            string
	Model             string
	PromptVersion     string
	Usage             AIUsage
	EstimatedCostUSD  float64
	ContextCycleCount int
	CurrentTruncated  bool
	ContextChanged    bool
	ProviderDuration  time.Duration
	BudgetUsageRatio  float64
	Duration          time.Duration
}

type Metrics struct {
	logger *slog.Logger

	httpRequests      metric.Int64Counter
	httpDuration      metric.Float64Histogram
	autosaves         metric.Int64Counter
	autosaveDuration  metric.Float64Histogram
	revisionConflicts metric.Int64Counter

	goalCreationDrafts            metric.Int64Counter
	goalsStarted                  metric.Int64Counter
	goalReviewsOpened             metric.Int64Counter
	goalReviewsContinued          metric.Int64Counter
	goalsTerminal                 metric.Int64Counter
	goalsDeleted                  metric.Int64Counter
	goalVersionsCreated           metric.Int64Counter
	progressingGoalLimitRejected  metric.Int64Counter
	progressingGoalLimitInvariant metric.Int64Counter
	cyclesStarted                 metric.Int64Counter
	cyclesCompleted               metric.Int64Counter
	cyclesCanceled                metric.Int64Counter

	aiGenerations        metric.Int64Counter
	aiGenerationDuration metric.Float64Histogram
	aiProviderAttempts   metric.Int64Counter
	aiInputTokens        metric.Int64Counter
	aiOutputTokens       metric.Int64Counter
	aiEstimatedCost      metric.Float64Counter
	aiUnattributedCost   metric.Float64Counter
	aiCostSettlements    metric.Int64Counter
	aiContextCycleCount  metric.Int64Histogram
	aiCurrentTruncated   metric.Int64Counter
	aiContextChanged     metric.Int64Counter
	aiSuggestionsAdopted metric.Int64Counter
	aiContextIsolation   metric.Int64Counter
	aiQuotaRejected      metric.Int64Counter
	aiBudgetRejected     metric.Int64Counter

	anonymousCreates       metric.Int64Counter
	accountUpgrades        metric.Int64Counter
	googleLogins           metric.Int64Counter
	accountDeletes         metric.Int64Counter
	rateLimitRejected      metric.Int64Counter
	turnstileVerifications metric.Int64Counter
	errorCodes             metric.Int64Counter

	budgetWarnings    metric.Int64Counter
	budgetUsageBits   atomic.Uint64
	warningThresholds []float64
}

func NewMetrics(provider metric.MeterProvider, logger *slog.Logger, warningThresholds []float64) (*Metrics, error) {
	if provider == nil {
		return nil, fmt.Errorf("telemetry meter provider is required")
	}
	meter := provider.Meter(metricScopeName)
	result := Metrics{logger: logger, warningThresholds: append([]float64(nil), warningThresholds...)}

	counters := []struct {
		name   string
		target *metric.Int64Counter
		unit   string
	}{
		{"http_requests_total", &result.httpRequests, ""},
		{"autosave_total", &result.autosaves, ""},
		{"revision_conflict_total", &result.revisionConflicts, ""},
		{"goal_creation_draft_created_total", &result.goalCreationDrafts, ""},
		{"goal_started_total", &result.goalsStarted, ""},
		{"goal_review_opened_total", &result.goalReviewsOpened, ""},
		{"goal_review_continued_total", &result.goalReviewsContinued, ""},
		{"goal_terminal_total", &result.goalsTerminal, ""},
		{"goal_deleted_total", &result.goalsDeleted, ""},
		{"goal_version_created_total", &result.goalVersionsCreated, ""},
		{"progressing_goal_limit_rejected_total", &result.progressingGoalLimitRejected, ""},
		{"progressing_goal_limit_invariant_violation_total", &result.progressingGoalLimitInvariant, ""},
		{"cycle_started_total", &result.cyclesStarted, ""},
		{"cycle_completed_total", &result.cyclesCompleted, ""},
		{"cycle_canceled_total", &result.cyclesCanceled, ""},
		{"ai_generation_total", &result.aiGenerations, ""},
		{"ai_provider_attempt_total", &result.aiProviderAttempts, ""},
		{"ai_input_tokens_total", &result.aiInputTokens, "{token}"},
		{"ai_output_tokens_total", &result.aiOutputTokens, "{token}"},
		{"ai_cost_settlement_total", &result.aiCostSettlements, ""},
		{"ai_context_current_truncated_total", &result.aiCurrentTruncated, ""},
		{"ai_context_changed_total", &result.aiContextChanged, ""},
		{"ai_suggestion_adopted_total", &result.aiSuggestionsAdopted, ""},
		{"ai_context_isolation_violation_total", &result.aiContextIsolation, ""},
		{"ai_quota_rejected_total", &result.aiQuotaRejected, ""},
		{"ai_budget_rejected_total", &result.aiBudgetRejected, ""},
		{"anonymous_create_total", &result.anonymousCreates, ""},
		{"account_upgrade_total", &result.accountUpgrades, ""},
		{"google_login_total", &result.googleLogins, ""},
		{"account_delete_total", &result.accountDeletes, ""},
		{"rate_limit_rejected_total", &result.rateLimitRejected, ""},
		{"turnstile_verification_total", &result.turnstileVerifications, ""},
		{"error_code_total", &result.errorCodes, ""},
		{"ai_budget_warning_total", &result.budgetWarnings, ""},
	}
	for _, definition := range counters {
		options := []metric.Int64CounterOption{}
		if definition.unit != "" {
			options = append(options, metric.WithUnit(definition.unit))
		}
		instrument, err := meter.Int64Counter(definition.name, options...)
		if err != nil {
			return nil, err
		}
		*definition.target = instrument
	}

	histograms := []struct {
		name   string
		target *metric.Float64Histogram
	}{
		{"http_request_duration_ms", &result.httpDuration},
		{"autosave_duration_ms", &result.autosaveDuration},
		{"ai_generation_duration_ms", &result.aiGenerationDuration},
	}
	for _, definition := range histograms {
		instrument, err := meter.Float64Histogram(definition.name, metric.WithUnit("ms"))
		if err != nil {
			return nil, err
		}
		*definition.target = instrument
	}
	var err error
	if result.aiContextCycleCount, err = meter.Int64Histogram("ai_context_cycle_count", metric.WithUnit("{cycle}")); err != nil {
		return nil, err
	}
	if result.aiEstimatedCost, err = meter.Float64Counter("ai_estimated_cost_usd_total", metric.WithUnit("USD")); err != nil {
		return nil, err
	}
	if result.aiUnattributedCost, err = meter.Float64Counter("ai_unattributed_cost_usd_total", metric.WithUnit("USD")); err != nil {
		return nil, err
	}
	budgetUsage, err := meter.Float64ObservableGauge("ai_budget_usage_ratio", metric.WithUnit("1"))
	if err != nil {
		return nil, err
	}
	if _, err = meter.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		observer.ObserveFloat64(budgetUsage, math.Float64frombits(result.budgetUsageBits.Load()))
		return nil
	}, budgetUsage); err != nil {
		return nil, err
	}
	return &result, nil
}

func (metrics *Metrics) ObserveHTTP(ctx context.Context, route string, status int, duration time.Duration) {
	if metrics == nil {
		return
	}
	statusClass := fmt.Sprintf("%dxx", status/100)
	metrics.httpRequests.Add(ctx, 1, metric.WithAttributes(
		metricLabel("http_requests_total", "route", route),
		metricLabel("http_requests_total", "status_class", statusClass),
	))
	metrics.httpDuration.Record(ctx, milliseconds(duration), metric.WithAttributes(
		metricLabel("http_request_duration_ms", "route", route),
	))
}

func (metrics *Metrics) ObserveAutosave(ctx context.Context, resourceType, result string, duration time.Duration) {
	if metrics == nil {
		return
	}
	metrics.autosaves.Add(ctx, 1, metric.WithAttributes(
		metricLabel("autosave_total", "resource_type", resourceType),
		metricLabel("autosave_total", "result", result),
	))
	metrics.autosaveDuration.Record(ctx, milliseconds(duration), metric.WithAttributes(
		metricLabel("autosave_duration_ms", "resource_type", resourceType),
	))
	if result == "conflict" {
		metrics.revisionConflicts.Add(ctx, 1, metric.WithAttributes(
			metricLabel("revision_conflict_total", "resource_type", resourceType),
		))
	}
	metrics.log(ctx, "autosave", slog.Int64("latency_ms", duration.Milliseconds()))
}

func (metrics *Metrics) CycleCompleted(ctx context.Context) {
	if metrics != nil {
		metrics.cyclesCompleted.Add(ctx, 1)
		metrics.log(ctx, "cycle_completed")
	}
}

func (metrics *Metrics) AccountUpgrade(ctx context.Context, result string) {
	if metrics != nil {
		metrics.accountUpgrades.Add(ctx, 1, metric.WithAttributes(
			metricLabel("account_upgrade_total", "result", result),
		))
		metrics.log(ctx, "account_upgrade")
	}
}

func (metrics *Metrics) GoogleLogin(ctx context.Context, result string) {
	if metrics != nil {
		metrics.googleLogins.Add(ctx, 1, metric.WithAttributes(
			metricLabel("google_login_total", "result", result),
		))
		metrics.log(ctx, "google_login")
	}
}

func (metrics *Metrics) AccountDelete(ctx context.Context, result string) {
	if metrics != nil {
		metrics.accountDeletes.Add(ctx, 1, metric.WithAttributes(
			metricLabel("account_delete_total", "result", result),
		))
		metrics.log(ctx, "account_delete")
	}
}

func (metrics *Metrics) AnonymousCreate(ctx context.Context, result string) {
	if metrics != nil {
		metrics.anonymousCreates.Add(ctx, 1, metric.WithAttributes(
			metricLabel("anonymous_create_total", "result", result),
		))
		metrics.log(ctx, "anonymous_create")
	}
}

func (metrics *Metrics) RateLimitRejected(ctx context.Context, scope string) {
	if metrics != nil {
		metrics.rateLimitRejected.Add(ctx, 1, metric.WithAttributes(
			metricLabel("rate_limit_rejected_total", "scope", scope),
		))
		metrics.log(ctx, "rate_limit_rejected")
	}
}

func (metrics *Metrics) TurnstileVerification(ctx context.Context, result string) {
	if metrics != nil {
		metrics.turnstileVerifications.Add(ctx, 1, metric.WithAttributes(
			metricLabel("turnstile_verification_total", "result", result),
		))
		metrics.log(ctx, "turnstile_verification")
	}
}

func (metrics *Metrics) ErrorCode(ctx context.Context, code string) {
	if metrics != nil {
		metrics.errorCodes.Add(ctx, 1, metric.WithAttributes(
			metricLabel("error_code_total", "code", code),
		))
		metrics.log(ctx, "error_code", slog.String("error_code", sanitizeMetricAttributeValue("error_code_total", "code", code)))
	}
}

func (metrics *Metrics) ObserveAIGeneration(ctx context.Context, event AIObservation) {
	if metrics == nil {
		return
	}
	operation := metricLabel("ai_generation_total", "operation_type", event.Operation)
	model := metricLabel("ai_generation_total", "model", event.Model)
	promptVersion := metricLabel("ai_generation_total", "prompt_version", event.PromptVersion)
	metrics.aiGenerations.Add(ctx, 1, metric.WithAttributes(
		operation,
		metricLabel("ai_generation_total", "result", event.Result),
		model,
		promptVersion,
	))
	metrics.aiGenerationDuration.Record(ctx, milliseconds(event.Duration), metric.WithAttributes(
		metricLabel("ai_generation_duration_ms", "operation_type", event.Operation),
		metricLabel("ai_generation_duration_ms", "model", event.Model),
	))
	modelOnly := metric.WithAttributes(metricLabel("ai_input_tokens_total", "model", event.Model))
	metrics.aiInputTokens.Add(ctx, event.Usage.InputTokens, modelOnly)
	metrics.aiOutputTokens.Add(ctx, event.Usage.OutputTokens, metric.WithAttributes(
		metricLabel("ai_output_tokens_total", "model", event.Model),
	))
	metrics.aiEstimatedCost.Add(ctx, event.EstimatedCostUSD, metric.WithAttributes(
		metricLabel("ai_estimated_cost_usd_total", "model", event.Model),
	))
	operationOnly := metric.WithAttributes(metricLabel("ai_context_cycle_count", "operation_type", event.Operation))
	metrics.aiContextCycleCount.Record(ctx, int64(event.ContextCycleCount), operationOnly)
	if event.CurrentTruncated {
		metrics.aiCurrentTruncated.Add(ctx, 1, metric.WithAttributes(
			metricLabel("ai_context_current_truncated_total", "operation_type", event.Operation),
		))
	}
	if event.ContextChanged {
		metrics.aiContextChanged.Add(ctx, 1, metric.WithAttributes(
			metricLabel("ai_context_changed_total", "operation_type", event.Operation),
		))
	}
	metrics.log(ctx, "ai_generation",
		slog.String("ai_model", sanitizeMetricAttributeValue("ai_generation_total", "model", event.Model)),
		slog.String("prompt_version", sanitizeMetricAttributeValue("ai_generation_total", "prompt_version", event.PromptVersion)),
		slog.Int64("input_tokens", event.Usage.InputTokens),
		slog.Int64("output_tokens", event.Usage.OutputTokens),
		slog.Float64("estimated_cost_usd", event.EstimatedCostUSD),
		slog.Int64("provider_latency_ms", event.ProviderDuration.Milliseconds()),
		slog.Int("context_cycle_count", event.ContextCycleCount),
		slog.Bool("context_changed", event.ContextChanged),
	)
	if event.BudgetUsageRatio > 0 {
		previous := math.Float64frombits(metrics.budgetUsageBits.Swap(math.Float64bits(event.BudgetUsageRatio)))
		for _, threshold := range metrics.warningThresholds {
			if previous < threshold && event.BudgetUsageRatio >= threshold {
				metrics.budgetWarnings.Add(ctx, 1, metric.WithAttributes(
					metricLabel("ai_budget_warning_total", "threshold", strconv.FormatFloat(threshold, 'f', -1, 64)),
				))
				metrics.log(ctx, "ai_budget_warning")
			}
		}
	}
}

func (metrics *Metrics) ObserveWorkspace(ctx context.Context, event workspace.WorkspaceObservation) {
	if metrics == nil {
		return
	}
	switch event.Event {
	case workspace.WorkspaceMetricGoalCreationDraftCreated:
		metrics.goalCreationDrafts.Add(ctx, 1)
		metrics.log(ctx, "goal_creation_draft_created")
	case workspace.WorkspaceMetricGoalStarted:
		metrics.goalsStarted.Add(ctx, 1)
		metrics.log(ctx, "goal_started")
	case workspace.WorkspaceMetricGoalReviewOpened:
		metrics.goalReviewsOpened.Add(ctx, 1)
		metrics.log(ctx, "goal_review_opened")
	case workspace.WorkspaceMetricGoalReviewContinued:
		metrics.goalReviewsContinued.Add(ctx, 1, metric.WithAttributes(
			metricLabel("goal_review_continued_total", "version_changed", strconv.FormatBool(event.VersionChanged)),
		))
		metrics.log(ctx, "goal_review_continued")
	case workspace.WorkspaceMetricGoalTerminal:
		metrics.goalsTerminal.Add(ctx, 1, metric.WithAttributes(
			metricLabel("goal_terminal_total", "outcome", string(event.Outcome)),
			metricLabel("goal_terminal_total", "source_state", string(event.SourceState)),
		))
		metrics.log(ctx, "goal_terminal",
			slog.String("goal_state_from", sanitizeMetricAttributeValue("goal_terminal_total", "source_state", string(event.SourceState))),
			slog.String("goal_state_to", sanitizeMetricAttributeValue("goal_terminal_total", "outcome", string(event.Outcome))),
		)
	case workspace.WorkspaceMetricGoalDeleted:
		metrics.goalsDeleted.Add(ctx, 1, metric.WithAttributes(
			metricLabel("goal_deleted_total", "source_state", string(event.SourceState)),
			metricLabel("goal_deleted_total", "result", event.Result),
		))
		metrics.log(ctx, "goal_deleted")
	case workspace.WorkspaceMetricGoalVersionCreated:
		metrics.goalVersionsCreated.Add(ctx, 1)
		metrics.log(ctx, "goal_version_created")
	case workspace.WorkspaceMetricProgressingGoalLimitRejected:
		metrics.progressingGoalLimitRejected.Add(ctx, 1)
		metrics.log(ctx, "progressing_goal_limit_rejected")
	case workspace.WorkspaceMetricProgressingGoalLimitInvariantViolation:
		metrics.progressingGoalLimitInvariant.Add(ctx, 1)
		metrics.log(ctx, "progressing_goal_limit_invariant_violation")
	case workspace.WorkspaceMetricCycleStarted:
		metrics.cyclesStarted.Add(ctx, 1)
		metrics.log(ctx, "cycle_started")
	case workspace.WorkspaceMetricCycleCompleted:
		metrics.cyclesCompleted.Add(ctx, 1)
		metrics.log(ctx, "cycle_completed")
	case workspace.WorkspaceMetricCycleCanceled:
		metrics.cyclesCanceled.Add(ctx, 1, metric.WithAttributes(
			metricLabel("cycle_canceled_total", "reason", string(event.CancellationReason)),
		))
		metrics.log(ctx, "cycle_canceled")
	case workspace.WorkspaceMetricAIProviderAttempt:
		metrics.aiProviderAttempts.Add(ctx, 1, metric.WithAttributes(
			metricLabel("ai_provider_attempt_total", "operation_type", string(event.Operation)),
			metricLabel("ai_provider_attempt_total", "result", event.Result),
		))
	case workspace.WorkspaceMetricAICostSettlement:
		metrics.AICostSettlement(ctx, event.SettlementPath, event.Result, 1)
	case workspace.WorkspaceMetricAISuggestionAdopted:
		metrics.aiSuggestionsAdopted.Add(ctx, 1, metric.WithAttributes(
			metricLabel("ai_suggestion_adopted_total", "source_type", event.SuggestionSource),
		))
		metrics.log(ctx, "ai_suggestion_adopted")
	case workspace.WorkspaceMetricAIQuotaRejected:
		metrics.aiQuotaRejected.Add(ctx, 1)
		metrics.log(ctx, "ai_quota_rejected")
	case workspace.WorkspaceMetricAIBudgetRejected:
		metrics.aiBudgetRejected.Add(ctx, 1)
		metrics.log(ctx, "ai_budget_rejected")
	case workspace.WorkspaceMetricRateLimitRejected:
		metrics.RateLimitRejected(ctx, event.Scope)
	}
}

func (metrics *Metrics) AICostSettlement(ctx context.Context, path, result string, count int64) {
	if metrics != nil && count > 0 {
		metrics.aiCostSettlements.Add(ctx, count, metric.WithAttributes(
			metricLabel("ai_cost_settlement_total", "path", path),
			metricLabel("ai_cost_settlement_total", "result", result),
		))
		metrics.log(ctx, "ai_cost_settlement")
	}
}

func (metrics *Metrics) AIUnattributedCost(ctx context.Context, amountUSD float64) {
	if metrics != nil && amountUSD > 0 {
		metrics.aiUnattributedCost.Add(ctx, amountUSD)
		metrics.log(ctx, "ai_unattributed_cost")
	}
}

func (metrics *Metrics) AIContextIsolationViolation(ctx context.Context) {
	if metrics != nil {
		metrics.aiContextIsolation.Add(ctx, 1)
		metrics.log(ctx, "ai_context_isolation_violation")
	}
}

func (metrics *Metrics) ObserveAI(ctx context.Context, event workspace.AIObservation) {
	metrics.ObserveAIGeneration(ctx, AIObservation{
		GenerationID: event.GenerationID, Operation: string(event.Operation),
		Result: event.Result, Model: event.Model, PromptVersion: event.PromptVersion,
		Usage:            AIUsage{InputTokens: event.InputTokens, OutputTokens: event.OutputTokens},
		EstimatedCostUSD: event.EstimatedCostUSD, ContextCycleCount: event.ContextCycleCount,
		CurrentTruncated: event.CurrentTruncated, ContextChanged: event.ContextChanged,
		ProviderDuration: event.ProviderDuration, Duration: event.Duration,
	})
}

func (metrics *Metrics) log(ctx context.Context, operation string, attributes ...slog.Attr) {
	if metrics == nil || metrics.logger == nil {
		return
	}
	base := []slog.Attr{slog.String("operation", operation)}
	correlation := ports.CorrelationFromContext(ctx)
	if correlation.RequestID != "" {
		base = append(base, slog.String("request_id", correlation.RequestID))
	}
	if spanContext := trace.SpanFromContext(ctx).SpanContext(); spanContext.IsValid() {
		base = append(base, slog.String("trace_id", spanContext.TraceID().String()))
	}
	if correlation.AIGenerationID != "" {
		base = append(base, slog.String("ai_generation_id", correlation.AIGenerationID))
	}
	if correlation.AIOperationType != "" {
		base = append(base, slog.String("ai_operation_type",
			sanitizeMetricAttributeValue("ai_generation_total", "operation_type", correlation.AIOperationType)))
	}
	metrics.logger.LogAttrs(ctx, slog.LevelInfo, "application metric", append(base, attributes...)...)
}

func metricLabel(name, key, value string) attribute.KeyValue {
	return attribute.String(key, sanitizeMetricAttributeValue(name, key, value))
}

func milliseconds(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}
