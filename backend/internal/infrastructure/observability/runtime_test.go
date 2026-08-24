package observability

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
)

func TestValidateSettings(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		settings Settings
		wantErr  bool
	}{
		{name: "development count only", settings: Settings{Environment: "development"}},
		{name: "test count only", settings: Settings{Environment: "test"}},
		{
			name: "production base path",
			settings: Settings{
				Environment: "production",
				Endpoint:    "https://collector.example/tenant",
				Headers:     "authorization=Bearer%20test-token",
			},
		},
		{
			name: "production explicit HTTPS port",
			settings: Settings{
				Environment: "production",
				Endpoint:    "https://collector.example:443/tenant",
				Headers:     "authorization=Bearer%20test-token",
			},
		},
		{
			name: "production trailing slash and encoded comma",
			settings: Settings{
				Environment: "production",
				Endpoint:    "https://collector.example/tenant/",
				Headers:     "authorization=Bearer%20test-token%2Cscope",
			},
		},
		{
			name: "header surrounding whitespace is normalized",
			settings: Settings{
				Environment: "production",
				Endpoint:    "https://collector.example",
				Headers:     " authorization = Bearer%20test-token ",
			},
		},
		{name: "unknown environment", settings: Settings{Environment: "staging"}, wantErr: true},
		{name: "development cannot export", settings: Settings{Environment: "development", Endpoint: "https://collector.example", Headers: "authorization=test"}, wantErr: true},
		{name: "test cannot export", settings: Settings{Environment: "test", Endpoint: "https://collector.example"}, wantErr: true},
		{name: "production endpoint required", settings: Settings{Environment: "production", Headers: "authorization=test"}, wantErr: true},
		{name: "production credentials required", settings: Settings{Environment: "production", Endpoint: "https://collector.example"}, wantErr: true},
		{name: "production endpoint must use HTTPS", settings: Settings{Environment: "production", Endpoint: "http://collector.example", Headers: "authorization=test"}, wantErr: true},
		{name: "endpoint surrounding whitespace forbidden", settings: Settings{Environment: "production", Endpoint: " https://collector.example", Headers: "authorization=test"}, wantErr: true},
		{name: "endpoint host required", settings: Settings{Environment: "production", Endpoint: "https:///tenant", Headers: "authorization=test"}, wantErr: true},
		{name: "opaque endpoint forbidden", settings: Settings{Environment: "production", Endpoint: "https:collector.example", Headers: "authorization=test"}, wantErr: true},
		{name: "userinfo forbidden", settings: Settings{Environment: "production", Endpoint: "https://user:secret@collector.example", Headers: "authorization=test"}, wantErr: true},
		{name: "query forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example?secret=value", Headers: "authorization=test"}, wantErr: true},
		{name: "empty query forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example?", Headers: "authorization=test"}, wantErr: true},
		{name: "fragment forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example#fragment", Headers: "authorization=test"}, wantErr: true},
		{name: "endpoint control forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example/tenant%0Ainjected", Headers: "authorization=test"}, wantErr: true},
		{name: "zero port forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example:0", Headers: "authorization=test"}, wantErr: true},
		{name: "out of range port forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example:65536", Headers: "authorization=test"}, wantErr: true},
		{name: "non decimal port forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example:abc", Headers: "authorization=test"}, wantErr: true},
		{name: "empty port forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example:", Headers: "authorization=test"}, wantErr: true},
		{name: "non canonical port forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example:0443", Headers: "authorization=test"}, wantErr: true},
		{name: "signed port forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example:+443", Headers: "authorization=test"}, wantErr: true},
		{name: "malformed header", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization"}, wantErr: true},
		{name: "empty member", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test,"}, wantErr: true},
		{name: "empty key", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "=value"}, wantErr: true},
		{name: "empty value", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization="}, wantErr: true},
		{name: "raw value space forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=Bearer token"}, wantErr: true},
		{name: "raw value tab forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=Bearer\ttoken"}, wantErr: true},
		{name: "header key space forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "bad key=value"}, wantErr: true},
		{name: "header key punctuation forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "bad:key=value"}, wantErr: true},
		{name: "header metadata forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test;meta=value"}, wantErr: true},
		{name: "invalid escape forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=%zz"}, wantErr: true},
		{name: "case insensitive duplicate forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=one,Authorization=two"}, wantErr: true},
		{name: "header nul forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test%00injected"}, wantErr: true},
		{name: "header carriage return forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test%0Dinjected"}, wantErr: true},
		{name: "header newline forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test%0Ainjected"}, wantErr: true},
		{name: "decoded trailing newline forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test%0A"}, wantErr: true},
		{name: "raw nul forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test\x00"}, wantErr: true},
		{name: "raw carriage return forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test\r"}, wantErr: true},
		{name: "raw newline forbidden", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "authorization=test\n"}, wantErr: true},
		{name: "content type managed", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "CoNtEnT-TyPe=text/plain"}, wantErr: true},
		{name: "content length managed", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "CONTENT-LENGTH=1"}, wantErr: true},
		{name: "content encoding managed", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "content-ENCODING=gzip"}, wantErr: true},
		{name: "proxy authorization managed", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "Proxy-Authorization=secret"}, wantErr: true},
		{name: "proxy authenticate managed", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "pRoXy-AuThEnTiCaTe=value"}, wantErr: true},
		{name: "keep alive managed", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "KEEP-ALIVE=value"}, wantErr: true},
		{name: "TE managed", settings: Settings{Environment: "production", Endpoint: "https://collector.example", Headers: "tE=trailers"}, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateSettings(test.settings)
			if (err != nil) != test.wantErr {
				t.Fatalf("ValidateSettings() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestSettingsRejectUnapprovedOrMismatchedOTelEnvironment(t *testing.T) {
	const secret = "DUMMY_OTEL_ENV_SECRET_CANARY"
	tests := []struct {
		name     string
		key      string
		value    string
		settings Settings
	}{
		{name: "sampler", key: "OTEL_TRACES_SAMPLER", value: "always_off_" + secret, settings: Settings{Environment: "development"}},
		{name: "empty unapproved override", key: "OTEL_LOG_LEVEL", value: "", settings: Settings{Environment: "development"}},
		{name: "resource attributes", key: "OTEL_RESOURCE_ATTRIBUTES", value: "secret.resource=" + secret, settings: Settings{Environment: "development"}},
		{name: "metric interval", key: "OTEL_METRIC_EXPORT_INTERVAL", value: secret, settings: Settings{Environment: "development"}},
		{name: "signal endpoint", key: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value: "https://" + secret + ".invalid", settings: Settings{Environment: "development"}},
		{name: "signal headers", key: "OTEL_EXPORTER_OTLP_METRICS_HEADERS", value: "authorization=" + secret, settings: Settings{Environment: "development"}},
		{name: "timeout", key: "OTEL_EXPORTER_OTLP_TIMEOUT", value: secret, settings: Settings{Environment: "development"}},
		{name: "certificate", key: "OTEL_EXPORTER_OTLP_CERTIFICATE", value: secret, settings: Settings{Environment: "development"}},
		{name: "exemplar filter", key: "OTEL_METRICS_EXEMPLAR_FILTER", value: secret, settings: Settings{Environment: "development"}},
		{name: "cardinality limit", key: "OTEL_GO_X_CARDINALITY_LIMIT", value: secret, settings: Settings{Environment: "development"}},
		{name: "SDK disabled", key: "OTEL_SDK_DISABLED", value: secret, settings: Settings{Environment: "development"}},
		{name: "development generic endpoint", key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "https://" + secret + ".invalid", settings: Settings{Environment: "development"}},
		{
			name:  "generic endpoint differs from validated setting",
			key:   "OTEL_EXPORTER_OTLP_ENDPOINT",
			value: " https://" + secret + ".invalid",
			settings: Settings{
				Environment: "production",
				Endpoint:    "https://collector.example",
				Headers:     "authorization=test",
			},
		},
		{
			name:  "generic headers differ from validated setting",
			key:   "OTEL_EXPORTER_OTLP_HEADERS",
			value: "authorization=" + secret,
			settings: Settings{
				Environment: "production",
				Endpoint:    "https://collector.example",
				Headers:     "authorization=test",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(test.key, test.value)
			if err := ValidateSettings(test.settings); !errors.Is(err, errUnsupportedOTelEnv) {
				t.Fatalf("ValidateSettings() error = %v, want fixed unsupported environment error", err)
			} else if strings.Contains(err.Error(), secret) {
				t.Fatalf("validation error revealed ambient value: %q", err)
			}

			var logs strings.Builder
			logger := slog.New(slog.NewTextHandler(&logs, nil))
			if _, err := Setup(context.Background(), logger, test.settings); !errors.Is(err, errUnsupportedOTelEnv) {
				t.Fatalf("Setup() error = %v, want fixed unsupported environment error", err)
			} else if strings.Contains(err.Error(), secret) || strings.Contains(logs.String(), secret) {
				t.Fatalf("setup revealed ambient value: err=%q log=%q", err, logs.String())
			}
		})
	}
}

func TestTraceProviderPinsSamplerAgainstAmbientEnvironment(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "always_off")
	exporter := &countingSpanExporter{}
	provider := newTraceProvider(resource.Empty(), exporter)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = provider.Shutdown(ctx)
	})

	_, span := provider.Tracer("fukamu-cycle/test").Start(context.Background(), "test.operation")
	span.End()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := provider.ForceFlush(ctx); err != nil {
		t.Fatal(err)
	}
	if exporter.spanCount.Load() != 1 {
		t.Fatalf("exported spans = %d, want explicit pinned sampling to retain one", exporter.spanCount.Load())
	}
}

func TestSettingsErrorsNeverRevealValues(t *testing.T) {
	t.Parallel()

	const secret = "DUMMY_SECRET_CANARY"
	tests := []Settings{
		{
			Environment: "production",
			Endpoint:    "https://collector.example?credential=" + secret,
			Headers:     "authorization=Bearer%20" + secret,
		},
		{
			Environment: "production",
			Endpoint:    "https://collector.example",
			Headers:     "Proxy-Authorization=" + secret,
		},
	}
	for _, settings := range tests {
		if err := ValidateSettings(settings); err == nil {
			t.Fatal("ValidateSettings() unexpectedly succeeded")
		} else if strings.Contains(err.Error(), secret) {
			t.Fatalf("validation error revealed a secret: %q", err)
		}
		if _, err := Setup(context.Background(), nil, settings); err == nil {
			t.Fatal("Setup() unexpectedly succeeded")
		} else if strings.Contains(err.Error(), secret) {
			t.Fatalf("setup error revealed a secret: %q", err)
		}
	}
}

func TestMetricSanitizerPreservesSoTConfigurationLabels(t *testing.T) {
	t.Parallel()

	for _, model := range []string{"gpt-5.6-luna", "gpt-5.6-terra"} {
		if got := sanitizeMetricAttributeValue("ai_generation_total", "model", model); got != model {
			t.Errorf("model %q sanitized to %q", model, got)
		}
	}
	for _, version := range []string{
		"goal-refine-v1", "action-generate-v1", "action-refine-v1",
		"goal-refine-v2", "action-generate-v2", "action-refine-v2",
	} {
		if got := sanitizeMetricAttributeValue("ai_generation_total", "prompt_version", version); got != version {
			t.Errorf("prompt version %q sanitized to %q", version, got)
		}
	}
	for _, test := range []struct{ key, value string }{
		{key: "model", value: "unapproved-model"},
		{key: "prompt_version", value: "goal-refine-v3"},
	} {
		if got := sanitizeMetricAttributeValue("ai_generation_total", test.key, test.value); got != "other" {
			t.Errorf("unapproved %s %q sanitized to %q, want other", test.key, test.value, got)
		}
	}
}

func TestMetricSanitizerPreservesGoalStartRateLimitScopeAndErrorCode(t *testing.T) {
	t.Parallel()
	if got := sanitizeMetricAttributeValue("rate_limit_rejected_total", "scope", "goal_start"); got != "goal_start" {
		t.Fatalf("goal_start scope sanitized to %q", got)
	}
	if got := sanitizeMetricAttributeValue("rate_limit_rejected_total", "scope", "user-id-canary"); got != "other" {
		t.Fatalf("unknown rate scope sanitized to %q, want other", got)
	}
	if got := sanitizeMetricAttributeValue("error_code_total", "code", "RATE_LIMIT_EXCEEDED"); got != "RATE_LIMIT_EXCEEDED" {
		t.Fatalf("RATE_LIMIT_EXCEEDED sanitized to %q", got)
	}
}

func TestSetupDevelopmentUsesBoundedCountOnlyExporters(t *testing.T) {
	previousTraceProvider := otel.GetTracerProvider()
	previousMeterProvider := otel.GetMeterProvider()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	runtime, err := Setup(context.Background(), logger, Settings{Environment: "development"})
	if err != nil {
		t.Fatal(err)
	}
	shutdown := false
	t.Cleanup(func() {
		if !shutdown {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = runtime.Shutdown(ctx)
		}
	})

	if runtime.MeterProvider() == nil || runtime.TracerProvider() == nil {
		t.Fatal("runtime providers must be installed")
	}
	if otel.GetTracerProvider() != runtime.traceProvider || otel.GetMeterProvider() != runtime.meterProvider {
		t.Fatal("runtime providers were not installed globally")
	}
	if runtime.localTraceExporter == nil || runtime.localMetricExporter == nil {
		t.Fatal("development runtime must use local count-only exporters")
	}
	if current, ok := otel.GetTextMapPropagator().(*propagation.TraceContext); !ok || current != runtime.propagator {
		t.Fatal("runtime must install its TraceContext-only propagator")
	}
	fields := runtime.propagator.Fields()
	if len(fields) != 2 || fields[0] != "traceparent" || fields[1] != "tracestate" {
		t.Fatalf("propagator fields = %v, want only traceparent and tracestate", fields)
	}

	tracer := runtime.TracerProvider().Tracer("fukamu-cycle/test")
	for index := 0; index < traceQueueSize*2; index++ {
		_, span := tracer.Start(context.Background(), "test.operation")
		span.End()
	}
	metrics, err := NewMetrics(runtime.MeterProvider(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	metrics.CycleCompleted(context.Background())

	if err := runtime.ForceFlush(context.Background()); err != nil {
		t.Fatalf("ForceFlush() error = %v", err)
	}
	if runtime.localTraceExporter.exportCalls.Load() == 0 || runtime.localTraceExporter.spanCount.Load() == 0 {
		t.Fatal("local trace exporter did not observe flushed spans")
	}
	if runtime.localMetricExporter.exportCalls.Load() == 0 || runtime.localMetricExporter.metricCount.Load() == 0 {
		t.Fatal("local metric exporter did not observe flushed metrics")
	}
	assertCountOnlyExporter(t, reflect.TypeOf(runtime.localTraceExporter).Elem())
	assertCountOnlyExporter(t, reflect.TypeOf(runtime.localMetricExporter).Elem())

	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	shutdown = true
	if !runtime.localTraceExporter.shutdown.Load() || !runtime.localMetricExporter.shutdown.Load() {
		t.Fatal("both local exporters must be shut down")
	}
	if otel.GetTracerProvider() != previousTraceProvider || otel.GetMeterProvider() != previousMeterProvider {
		t.Fatal("previous global providers were not restored")
	}
	if activeRuntime != nil {
		t.Fatal("runtime remained active after shutdown")
	}
	if handler, ok := otel.GetErrorHandler().(*safeErrorHandler); !ok || handler.logger != nil {
		t.Fatal("shutdown must leave a secret-discarding global error handler")
	}
}

func TestCorrelationAttributeSanitizerIsClassAndValueFailClosed(t *testing.T) {
	validRequestID := attribute.String("fukamu.request_id", "0198c20b-7b95-7000-8000-000000000001")
	validGenerationID := attribute.String("fukamu.ai_generation_id", "0198c20b-7b95-7000-8000-000000000002")
	validOperation := attribute.String("fukamu.ai_operation_type", "goal_refine")
	for _, test := range []struct {
		name  string
		class spanClass
		item  attribute.KeyValue
	}{
		{name: "HTTP request", class: spanClassHTTP, item: validRequestID},
		{name: "Postgres request", class: spanClassPostgres, item: validRequestID},
		{name: "Postgres generation", class: spanClassPostgres, item: validGenerationID},
		{name: "Postgres operation", class: spanClassPostgres, item: validOperation},
		{name: "OpenAI request", class: spanClassOpenAI, item: validRequestID},
		{name: "OpenAI generation", class: spanClassOpenAI, item: validGenerationID},
		{name: "OpenAI operation", class: spanClassOpenAI, item: validOperation},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, ok := sanitizeCorrelationAttribute(test.class, test.item)
			if !ok || got != test.item {
				t.Fatalf("sanitize correlation = %#v/%v, want %#v/true", got, ok, test.item)
			}
		})
	}
	for _, test := range []struct {
		name  string
		class spanClass
		item  attribute.KeyValue
	}{
		{name: "request on application", class: spanClassApplication, item: validRequestID},
		{name: "generation on HTTP", class: spanClassHTTP, item: validGenerationID},
		{name: "wrong UUID version", class: spanClassOpenAI, item: attribute.String("fukamu.ai_generation_id", "0198c20b-7b95-4000-8000-000000000002")},
		{name: "uppercase UUID", class: spanClassPostgres, item: attribute.String("fukamu.request_id", "0198C20B-7B95-7000-8000-000000000001")},
		{name: "raw identity", class: spanClassOpenAI, item: attribute.String("fukamu.request_id", "private@example.com")},
		{name: "unknown operation", class: spanClassOpenAI, item: attribute.String("fukamu.ai_operation_type", "PROMPT_BODY_CANARY")},
		{name: "wrong type", class: spanClassOpenAI, item: attribute.Int("fukamu.request_id", 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got, ok := sanitizeCorrelationAttribute(test.class, test.item); ok {
				t.Fatalf("sanitize correlation = %#v/true, want rejection", got)
			}
		})
	}
}

func assertCountOnlyExporter(t *testing.T, exporterType reflect.Type) {
	t.Helper()
	for index := 0; index < exporterType.NumField(); index++ {
		field := exporterType.Field(index)
		switch field.Type.Kind() {
		case reflect.Array, reflect.Chan, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice, reflect.String:
			t.Fatalf("count-only exporter %s retains field %s of type %s", exporterType, field.Name, field.Type)
		}
	}
}
