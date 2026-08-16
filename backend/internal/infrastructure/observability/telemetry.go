package observability

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"sync/atomic"
	"time"

	metricexporter "github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/metric"
	traceexporter "github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/trace"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
)

// Setup installs the production Cloud Monitoring and Cloud Trace exporters.
// Development and tests retain the OpenTelemetry no-op providers and therefore
// never require Google credentials or external services.
func Setup(ctx context.Context, enabled bool) (func(context.Context) error, error) {
	if !enabled {
		otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{}, propagation.Baggage{},
		))
		return func(context.Context) error { return nil }, nil
	}

	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(
		semconv.SchemaURL,
		semconv.ServiceName("pdcai-web"),
	))
	if err != nil {
		return nil, fmt.Errorf("create telemetry resource: %w", err)
	}
	traceExporter, err := traceexporter.New()
	if err != nil {
		return nil, fmt.Errorf("create Cloud Trace exporter: %w", err)
	}
	metricExporter, err := metricexporter.New()
	if err != nil {
		return nil, fmt.Errorf("create Cloud Monitoring exporter: %w", err)
	}

	traces := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	metrics := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter, sdkmetric.WithInterval(60*time.Second))),
		sdkmetric.WithResource(res),
	)
	otel.SetTracerProvider(traces)
	otel.SetMeterProvider(metrics)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))

	return func(shutdownContext context.Context) error {
		return errors.Join(metrics.Shutdown(shutdownContext), traces.Shutdown(shutdownContext))
	}, nil
}

type Metrics struct {
	httpRequests         metric.Int64Counter
	httpDuration         metric.Float64Histogram
	autosaves            metric.Int64Counter
	autosaveDuration     metric.Float64Histogram
	cyclesCompleted      metric.Int64Counter
	aiGenerations        metric.Int64Counter
	aiGenerationDuration metric.Float64Histogram
	aiInputTokens        metric.Int64Counter
	aiOutputTokens       metric.Int64Counter
	aiEstimatedCost      metric.Float64Counter
	aiContextCycleCount  metric.Int64Histogram
	aiCurrentTruncated   metric.Int64Counter
	accountUpgrades      metric.Int64Counter
	accountDeletes       metric.Int64Counter
	anonymousCreates     metric.Int64Counter
	rateLimitRejected    metric.Int64Counter
	errorCodes           metric.Int64Counter
	budgetWarnings       metric.Int64Counter
	budgetUsageBits      atomic.Uint64
	warningThresholds    []float64
}

func NewMetrics(warningThresholds []float64) (*Metrics, error) {
	meter := otel.Meter("pdcai")
	result := Metrics{warningThresholds: append([]float64(nil), warningThresholds...)}
	var err error
	if result.httpRequests, err = meter.Int64Counter("http_requests_total"); err != nil {
		return nil, err
	}
	if result.httpDuration, err = meter.Float64Histogram("http_request_duration_ms", metric.WithUnit("ms")); err != nil {
		return nil, err
	}
	if result.autosaves, err = meter.Int64Counter("autosave_total"); err != nil {
		return nil, err
	}
	if result.autosaveDuration, err = meter.Float64Histogram("autosave_duration_ms", metric.WithUnit("ms")); err != nil {
		return nil, err
	}
	if result.cyclesCompleted, err = meter.Int64Counter("cycle_completed_total"); err != nil {
		return nil, err
	}
	if result.aiGenerations, err = meter.Int64Counter("ai_generation_total"); err != nil {
		return nil, err
	}
	if result.aiGenerationDuration, err = meter.Float64Histogram("ai_generation_duration_ms", metric.WithUnit("ms")); err != nil {
		return nil, err
	}
	if result.aiInputTokens, err = meter.Int64Counter("ai_input_tokens_total", metric.WithUnit("{token}")); err != nil {
		return nil, err
	}
	if result.aiOutputTokens, err = meter.Int64Counter("ai_output_tokens_total", metric.WithUnit("{token}")); err != nil {
		return nil, err
	}
	if result.aiEstimatedCost, err = meter.Float64Counter("ai_estimated_cost_usd_total", metric.WithUnit("USD")); err != nil {
		return nil, err
	}
	if result.aiContextCycleCount, err = meter.Int64Histogram("ai_context_cycle_count", metric.WithUnit("{cycle}")); err != nil {
		return nil, err
	}
	if result.aiCurrentTruncated, err = meter.Int64Counter("ai_context_current_truncated_total"); err != nil {
		return nil, err
	}
	if result.accountUpgrades, err = meter.Int64Counter("account_upgrade_total"); err != nil {
		return nil, err
	}
	if result.accountDeletes, err = meter.Int64Counter("account_delete_total"); err != nil {
		return nil, err
	}
	if result.anonymousCreates, err = meter.Int64Counter("anonymous_create_total"); err != nil {
		return nil, err
	}
	if result.rateLimitRejected, err = meter.Int64Counter("rate_limit_rejected_total"); err != nil {
		return nil, err
	}
	if result.errorCodes, err = meter.Int64Counter("error_code_total"); err != nil {
		return nil, err
	}
	if result.budgetWarnings, err = meter.Int64Counter("ai_budget_warning_total"); err != nil {
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
	attrs := metric.WithAttributes(attribute.String("route", route), attribute.String("status_class", statusClass))
	metrics.httpRequests.Add(ctx, 1, attrs)
	metrics.httpDuration.Record(ctx, float64(duration.Microseconds())/1000, metric.WithAttributes(attribute.String("route", route)))
}

func (metrics *Metrics) ObserveAutosave(ctx context.Context, result string, duration time.Duration) {
	if metrics == nil {
		return
	}
	metrics.autosaves.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
	metrics.autosaveDuration.Record(ctx, float64(duration.Microseconds())/1000)
}

func (metrics *Metrics) CycleCompleted(ctx context.Context) {
	if metrics != nil {
		metrics.cyclesCompleted.Add(ctx, 1)
	}
}

func (metrics *Metrics) AccountUpgrade(ctx context.Context, result string) {
	if metrics != nil {
		metrics.accountUpgrades.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
	}
}

func (metrics *Metrics) AccountDelete(ctx context.Context, result string) {
	if metrics != nil {
		metrics.accountDeletes.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
	}
}

func (metrics *Metrics) AnonymousCreate(ctx context.Context, result string) {
	if metrics != nil {
		metrics.anonymousCreates.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
	}
}

func (metrics *Metrics) RateLimitRejected(ctx context.Context, scope string) {
	if metrics != nil {
		metrics.rateLimitRejected.Add(ctx, 1, metric.WithAttributes(attribute.String("scope", scope)))
	}
}

func (metrics *Metrics) ErrorCode(ctx context.Context, code string) {
	if metrics != nil {
		metrics.errorCodes.Add(ctx, 1, metric.WithAttributes(attribute.String("code", code)))
	}
}

func (metrics *Metrics) ObserveAIGeneration(ctx context.Context, event appai.Observation) {
	if metrics == nil {
		return
	}
	attrs := metric.WithAttributes(
		attribute.String("type", string(event.Type)),
		attribute.String("result", event.Result),
		attribute.String("model", event.Model),
		attribute.String("prompt_version", event.PromptVersion),
	)
	metrics.aiGenerations.Add(ctx, 1, attrs)
	metrics.aiGenerationDuration.Record(ctx, float64(event.Duration.Microseconds())/1000, metric.WithAttributes(
		attribute.String("type", string(event.Type)), attribute.String("model", event.Model),
	))
	model := metric.WithAttributes(attribute.String("model", event.Model))
	metrics.aiInputTokens.Add(ctx, event.Usage.InputTokens, model)
	metrics.aiOutputTokens.Add(ctx, event.Usage.OutputTokens, model)
	metrics.aiEstimatedCost.Add(ctx, event.EstimatedCostUSD, model)
	metrics.aiContextCycleCount.Record(ctx, int64(event.ContextCycleCount))
	if event.CurrentTruncated {
		metrics.aiCurrentTruncated.Add(ctx, 1)
	}
	if event.BudgetUsageRatio > 0 {
		previous := math.Float64frombits(metrics.budgetUsageBits.Swap(math.Float64bits(event.BudgetUsageRatio)))
		for _, threshold := range metrics.warningThresholds {
			if previous < threshold && event.BudgetUsageRatio >= threshold {
				metrics.budgetWarnings.Add(ctx, 1, metric.WithAttributes(
					attribute.String("threshold", strconv.FormatFloat(threshold, 'f', -1, 64)),
				))
			}
		}
	}
}
