package observability

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otelmetric "go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	collectmetricpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	collecttracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"

	"github.com/fukamu/cycle/backend/internal/httpapi"
)

const (
	headerSecretCanary      = "DUMMY_HEADER_SECRET"
	traceStateCanary        = "TRACESTATE_CANARY"
	scopeCanary             = "INSTRUMENTATION_SCOPE_CANARY"
	rawPathCanary           = "/private/RAW_PATH_CANARY"
	rawIPCanary             = "203.0.113.250"
	rawUserAgentCanary      = "RAW_USER_AGENT_CANARY"
	rawBodyCanary           = "RAW_BODY_CANARY"
	rawTokenCanary          = "RAW_TOKEN_CANARY"
	eventCanary             = "EVENT_CANARY"
	statusCanary            = "STATUS_DESCRIPTION_CANARY"
	spanNameCanary          = "SPAN_NAME_CANARY"
	linkCanary              = "LINK_ATTRIBUTE_CANARY"
	resourceCanary          = "RESOURCE_SECRET_CANARY"
	redirectCanary          = "REDIRECT_HEADER_SECRET_CANARY"
	metricCanary            = "METRIC_LABEL_SECRET_CANARY"
	correlationRequestID    = "0198c20b-7b95-7000-8000-000000000001"
	correlationGenerationID = "0198c20b-7b95-7000-8000-000000000002"
)

type recordedOTLPRequest struct {
	method        string
	path          string
	authorization string
	contentType   string
	body          []byte
}

type otlpReceiver struct {
	mu       sync.Mutex
	requests []recordedOTLPRequest
	status   int
	body     string
}

func (receiver *otlpReceiver) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 8<<20))
	if err != nil {
		writer.WriteHeader(http.StatusBadRequest)
		return
	}
	receiver.mu.Lock()
	receiver.requests = append(receiver.requests, recordedOTLPRequest{
		method:        request.Method,
		path:          request.URL.Path,
		authorization: request.Header.Get("Authorization"),
		contentType:   request.Header.Get("Content-Type"),
		body:          append([]byte(nil), body...),
	})
	receiver.mu.Unlock()

	if receiver.status >= http.StatusBadRequest {
		http.Error(writer, receiver.body, receiver.status)
		return
	}
	writer.Header().Set("Content-Type", "application/x-protobuf")
	switch {
	case strings.HasSuffix(request.URL.Path, "/v1/traces"):
		response, _ := proto.Marshal(&collecttracepb.ExportTraceServiceResponse{})
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(response)
	case strings.HasSuffix(request.URL.Path, "/v1/metrics"):
		response, _ := proto.Marshal(&collectmetricpb.ExportMetricsServiceResponse{})
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(response)
	default:
		writer.WriteHeader(http.StatusNotFound)
	}
}

func (receiver *otlpReceiver) snapshot() []recordedOTLPRequest {
	receiver.mu.Lock()
	defer receiver.mu.Unlock()
	result := make([]recordedOTLPRequest, len(receiver.requests))
	copy(result, receiver.requests)
	return result
}

func TestProductionOTLPHTTPExportsSanitizedTraceAndMetric(t *testing.T) {
	for _, trailingSlash := range []bool{false, true} {
		name := "base without trailing slash"
		if trailingSlash {
			name = "base with trailing slash"
		}
		t.Run(name, func(t *testing.T) {
			receiver := &otlpReceiver{}
			server := httptest.NewTLSServer(receiver)
			defer server.Close()

			endpoint := server.URL + "/tenant"
			if trailingSlash {
				endpoint += "/"
			}
			headerSetting := "authorization=Bearer%20" + headerSecretCanary + "%2Cscope"
			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint)
			t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", headerSetting)
			runtime, err := setupRuntime(
				context.Background(),
				slog.New(slog.NewTextHandler(io.Discard, nil)),
				Settings{
					Environment: "production",
					Endpoint:    endpoint,
					Headers:     headerSetting,
				},
				setupOptions{httpClient: server.Client()},
			)
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

			traceState, err := trace.ParseTraceState("vendor=" + traceStateCanary)
			if err != nil {
				t.Fatal(err)
			}
			parentTraceID := trace.TraceID{0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe}
			parentSpanID := trace.SpanID{0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe}
			parent := trace.NewSpanContext(trace.SpanContextConfig{
				TraceID:    parentTraceID,
				SpanID:     parentSpanID,
				TraceFlags: trace.FlagsSampled,
				TraceState: traceState,
				Remote:     true,
			})
			ctx := trace.ContextWithRemoteSpanContext(context.Background(), parent)
			httpTracer := runtime.TracerProvider().Tracer(
				"fukamu-cycle/http",
				trace.WithInstrumentationVersion(scopeCanary),
				trace.WithSchemaURL("https://example.invalid/"+scopeCanary),
				trace.WithInstrumentationAttributes(attribute.String("scope.canary", scopeCanary)),
			)
			_, httpSpan := httpTracer.Start(
				ctx,
				"GET "+rawPathCanary,
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithLinks(trace.Link{
					SpanContext: parent,
					Attributes:  []attribute.KeyValue{attribute.String("link.secret", linkCanary)},
				}),
				trace.WithAttributes(
					attribute.String("http.request.method", "RAW_METHOD_CANARY"),
					attribute.String("http.route", rawPathCanary),
					attribute.Int("http.response.status_code", http.StatusServiceUnavailable),
					attribute.String("fukamu.request_id", correlationRequestID),
					attribute.String("client.address", rawIPCanary),
					attribute.String("user_agent.original", rawUserAgentCanary),
					attribute.String("http.request.body", rawBodyCanary),
					attribute.String("authorization", rawTokenCanary),
				),
			)
			httpSpan.AddEvent(eventCanary, trace.WithAttributes(attribute.String("event.secret", rawBodyCanary)))
			httpSpan.SetStatus(codes.Error, statusCanary)
			httpSpan.End()

			applicationTracer := runtime.TracerProvider().Tracer(
				scopeCanary,
				trace.WithInstrumentationVersion(scopeCanary),
				trace.WithSchemaURL("https://example.invalid/"+scopeCanary),
				trace.WithInstrumentationAttributes(attribute.String("scope.secret", scopeCanary)),
			)
			_, applicationSpan := applicationTracer.Start(ctx, spanNameCanary)
			applicationSpan.SetAttributes(attribute.String("application.secret", rawTokenCanary))
			applicationSpan.SetStatus(codes.Error, statusCanary)
			applicationSpan.End()

			openAITracer := runtime.TracerProvider().Tracer(
				"fukamu-cycle/openai",
				trace.WithInstrumentationVersion(scopeCanary),
				trace.WithSchemaURL("https://example.invalid/"+scopeCanary),
				trace.WithInstrumentationAttributes(attribute.String("scope.secret", scopeCanary)),
			)
			_, openAISpan := openAITracer.Start(ctx, "openai.responses.create",
				trace.WithSpanKind(trace.SpanKindClient),
				trace.WithAttributes(
					attribute.String("fukamu.request_id", correlationRequestID),
					attribute.String("fukamu.ai_generation_id", correlationGenerationID),
					attribute.String("fukamu.ai_operation_type", "goal_refine"),
					attribute.String("gen_ai.prompt", rawBodyCanary),
					attribute.String("user.id", rawTokenCanary),
					attribute.String("server.address", rawIPCanary),
				),
			)
			openAISpan.AddEvent(eventCanary, trace.WithAttributes(attribute.String("event.secret", rawBodyCanary)))
			openAISpan.SetStatus(codes.Error, statusCanary)
			openAISpan.End()

			poisonedMeter := runtime.MeterProvider().Meter(
				"fukamu-cycle",
				otelmetric.WithInstrumentationVersion(metricCanary),
				otelmetric.WithSchemaURL("https://example.invalid/"+metricCanary),
				otelmetric.WithInstrumentationAttributes(attribute.String("scope.secret", metricCanary)),
			)
			poisonedCounter, err := poisonedMeter.Int64Counter(
				"http_requests_total",
				otelmetric.WithDescription(metricCanary),
				otelmetric.WithUnit(metricCanary),
			)
			if err != nil {
				t.Fatal(err)
			}
			poisonedCounter.Add(context.Background(), 1, otelmetric.WithAttributes(
				attribute.String("route", metricCanary),
				attribute.String("status_class", metricCanary),
				attribute.String("secret.label", metricCanary),
			))
			unknownMeter := runtime.MeterProvider().Meter(metricCanary)
			unknownCounter, err := unknownMeter.Int64Counter(metricCanary)
			if err != nil {
				t.Fatal(err)
			}
			unknownCounter.Add(context.Background(), 1, otelmetric.WithAttributes(attribute.String("secret.label", metricCanary)))

			metrics, err := NewMetrics(runtime.MeterProvider(), nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			metrics.CycleCompleted(context.Background())
			metrics.ErrorCode(context.Background(), metricCanary)
			metrics.ObserveAIGeneration(context.Background(), AIObservation{
				Operation:        metricCanary,
				Result:           metricCanary,
				Model:            metricCanary,
				PromptVersion:    metricCanary,
				CurrentTruncated: true,
				Duration:         time.Millisecond,
			})

			shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err = runtime.Shutdown(shutdownContext)
			cancel()
			shutdown = true
			if err != nil {
				t.Fatalf("Shutdown() error = %v", err)
			}

			requests := receiver.snapshot()
			if len(requests) < 2 {
				t.Fatalf("OTLP requests = %d, want trace and metric", len(requests))
			}
			var (
				traceRequests  []*collecttracepb.ExportTraceServiceRequest
				metricRequests []*collectmetricpb.ExportMetricsServiceRequest
				payload        []byte
			)
			pathCounts := map[string]int{}
			for _, request := range requests {
				pathCounts[request.path]++
				payload = append(payload, request.body...)
				if request.method != http.MethodPost {
					t.Errorf("OTLP method = %q, want POST", request.method)
				}
				if request.authorization != "Bearer "+headerSecretCanary+",scope" {
					t.Errorf("Authorization = %q, encoded comma was not preserved", request.authorization)
				}
				if request.contentType != "application/x-protobuf" {
					t.Errorf("Content-Type = %q, want application/x-protobuf", request.contentType)
				}
				switch request.path {
				case "/tenant/v1/traces":
					var exported collecttracepb.ExportTraceServiceRequest
					if err := proto.Unmarshal(request.body, &exported); err != nil {
						t.Fatal(err)
					}
					traceRequests = append(traceRequests, &exported)
				case "/tenant/v1/metrics":
					var exported collectmetricpb.ExportMetricsServiceRequest
					if err := proto.Unmarshal(request.body, &exported); err != nil {
						t.Fatal(err)
					}
					metricRequests = append(metricRequests, &exported)
				default:
					t.Errorf("unexpected OTLP path %q", request.path)
				}
			}
			if pathCounts["/tenant/v1/traces"] == 0 || pathCounts["/tenant/v1/metrics"] == 0 {
				t.Fatalf("OTLP paths = %v", pathCounts)
			}

			for _, forbidden := range []string{
				headerSecretCanary, traceStateCanary, scopeCanary, rawPathCanary, rawIPCanary, rawUserAgentCanary,
				rawBodyCanary, rawTokenCanary, eventCanary, statusCanary, spanNameCanary, linkCanary, metricCanary,
			} {
				if bytes.Contains(payload, []byte(forbidden)) {
					t.Fatalf("OTLP payload contains forbidden canary %q", forbidden)
				}
			}
			assertSanitizedTracePayload(t, traceRequests, parentTraceID, parentSpanID)
			assertMetricPayload(
				t,
				metricRequests,
				"cycle_completed_total",
				"http_requests_total",
				"ai_context_current_truncated_total",
			)
		})
	}
}

func assertSanitizedTracePayload(
	t *testing.T,
	requests []*collecttracepb.ExportTraceServiceRequest,
	parentTraceID trace.TraceID,
	parentSpanID trace.SpanID,
) {
	t.Helper()
	var httpSpan, applicationSpan, openAISpan *tracepb.Span
	for _, request := range requests {
		for _, resourceSpans := range request.ResourceSpans {
			if resourceSpans.SchemaUrl != "" {
				t.Fatalf("trace resource schema = %q, want empty", resourceSpans.SchemaUrl)
			}
			assertOnlyServiceName(t, resourceSpans.Resource.Attributes)
			for _, scopeSpans := range resourceSpans.ScopeSpans {
				if scopeSpans.Scope == nil {
					t.Fatal("trace instrumentation scope is nil")
				}
				if scopeSpans.Scope.Version != "" || scopeSpans.SchemaUrl != "" || len(scopeSpans.Scope.Attributes) != 0 {
					t.Fatalf("unsafe trace scope metadata was retained: %#v schema=%q", scopeSpans.Scope, scopeSpans.SchemaUrl)
				}
				switch scopeSpans.Scope.Name {
				case "fukamu-cycle/http", "fukamu-cycle/application", "fukamu-cycle/openai":
				default:
					t.Fatalf("unexpected sanitized trace scope %q", scopeSpans.Scope.Name)
				}
				for _, span := range scopeSpans.Spans {
					switch span.Name {
					case "http.request":
						httpSpan = span
					case "application.operation":
						applicationSpan = span
					case "openai.responses.create":
						openAISpan = span
					default:
						t.Fatalf("unexpected sanitized span name %q", span.Name)
					}
				}
			}
		}
	}
	if httpSpan == nil || applicationSpan == nil || openAISpan == nil {
		t.Fatalf("sanitized spans missing: http=%v application=%v openai=%v", httpSpan != nil, applicationSpan != nil, openAISpan != nil)
	}
	for _, span := range []*tracepb.Span{httpSpan, applicationSpan, openAISpan} {
		if span.TraceState != "" {
			t.Fatalf("span tracestate = %q, want empty", span.TraceState)
		}
		if !bytes.Equal(span.TraceId, parentTraceID[:]) {
			t.Fatalf("trace ID = %x, want %x", span.TraceId, parentTraceID)
		}
		if !bytes.Equal(span.ParentSpanId, parentSpanID[:]) {
			t.Fatalf("parent span ID = %x, want %x", span.ParentSpanId, parentSpanID)
		}
		if span.Flags&uint32(trace.FlagsSampled) == 0 {
			t.Fatalf("sampled trace flag was not preserved: %d", span.Flags)
		}
		if len(span.Events) != 0 {
			t.Fatalf("events were retained: %#v", span.Events)
		}
	}
	if httpSpan.Status == nil || httpSpan.Status.Message != "HTTP request failed" {
		t.Fatalf("HTTP status was not sanitized: %#v", httpSpan.Status)
	}
	if applicationSpan.Status == nil || applicationSpan.Status.Message != "operation failed" {
		t.Fatalf("application status was not sanitized: %#v", applicationSpan.Status)
	}
	if openAISpan.Status == nil || openAISpan.Status.Message != "provider request failed" {
		t.Fatalf("OpenAI status was not sanitized: %#v", openAISpan.Status)
	}
	if len(applicationSpan.Attributes) != 0 {
		t.Fatalf("application attributes were retained: %#v", applicationSpan.Attributes)
	}

	httpAttributes := make(map[string]any)
	for _, item := range httpSpan.Attributes {
		switch item.Key {
		case "http.request.method", "http.route", "fukamu.request_id":
			httpAttributes[item.Key] = item.Value.GetStringValue()
		case "http.response.status_code":
			httpAttributes[item.Key] = item.Value.GetIntValue()
		default:
			t.Fatalf("unexpected HTTP attribute %q", item.Key)
		}
	}
	wantHTTPAttributes := map[string]any{
		"http.request.method":       "OTHER",
		"http.route":                "unmatched",
		"http.response.status_code": int64(http.StatusServiceUnavailable),
		"fukamu.request_id":         correlationRequestID,
	}
	if len(httpAttributes) != len(wantHTTPAttributes) {
		t.Fatalf("HTTP attributes = %#v", httpAttributes)
	}
	for key, want := range wantHTTPAttributes {
		if got := httpAttributes[key]; got != want {
			t.Errorf("HTTP attribute %q = %#v, want %#v", key, got, want)
		}
	}
	if len(httpSpan.Links) != 1 {
		t.Fatalf("HTTP links = %d, want 1", len(httpSpan.Links))
	}
	if httpSpan.Links[0].TraceState != "" || len(httpSpan.Links[0].Attributes) != 0 {
		t.Fatalf("link metadata was not sanitized: %#v", httpSpan.Links[0])
	}
	openAIAttributes := map[string]string{}
	for _, item := range openAISpan.Attributes {
		openAIAttributes[item.Key] = item.Value.GetStringValue()
	}
	wantOpenAIAttributes := map[string]string{
		"fukamu.request_id":        correlationRequestID,
		"fukamu.ai_generation_id":  correlationGenerationID,
		"fukamu.ai_operation_type": "goal_refine",
	}
	if len(openAIAttributes) != len(wantOpenAIAttributes) {
		t.Fatalf("OpenAI attributes = %#v, want %#v", openAIAttributes, wantOpenAIAttributes)
	}
	for key, want := range wantOpenAIAttributes {
		if got := openAIAttributes[key]; got != want {
			t.Fatalf("OpenAI attribute %q = %q, want %q", key, got, want)
		}
	}
}

func assertMetricPayload(t *testing.T, requests []*collectmetricpb.ExportMetricsServiceRequest, wantMetrics ...string) {
	t.Helper()
	found := make(map[string]bool, len(wantMetrics))
	for _, name := range wantMetrics {
		found[name] = false
	}
	for _, request := range requests {
		for _, resourceMetrics := range request.ResourceMetrics {
			if resourceMetrics.SchemaUrl != "" {
				t.Fatalf("metric resource schema = %q, want empty", resourceMetrics.SchemaUrl)
			}
			assertOnlyServiceName(t, resourceMetrics.Resource.Attributes)
			for _, scopeMetrics := range resourceMetrics.ScopeMetrics {
				if scopeMetrics.Scope == nil || scopeMetrics.Scope.Name != metricScopeName ||
					scopeMetrics.Scope.Version != "" || scopeMetrics.SchemaUrl != "" || len(scopeMetrics.Scope.Attributes) != 0 {
					t.Fatalf("unsafe metric scope metadata was exported: scope=%#v schema=%q", scopeMetrics.Scope, scopeMetrics.SchemaUrl)
				}
				for _, metric := range scopeMetrics.Metrics {
					if _, wanted := found[metric.Name]; wanted {
						found[metric.Name] = true
					}
				}
			}
		}
	}
	for name, present := range found {
		if !present {
			t.Errorf("%s was not exported", name)
		}
	}
}

func assertOnlyServiceName(t *testing.T, attributes []*commonpb.KeyValue) {
	t.Helper()
	if len(attributes) != 1 {
		t.Fatalf("resource attributes = %#v, want fixed service.name only", attributes)
	}
	if attributes[0].Key != "service.name" || attributes[0].Value.GetStringValue() != serviceName {
		t.Fatalf("service resource = %#v", attributes[0])
	}
}

func TestProductionRejectsOTLPRedirectsWithoutCredentialReplay(t *testing.T) {
	for _, tlsSink := range []bool{false, true} {
		name := "HTTPS source to HTTP sink"
		if tlsSink {
			name = "HTTPS source to different HTTPS sink"
		}
		t.Run(name, func(t *testing.T) {
			var sinkRequests atomic.Uint64
			sinkHandler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				sinkRequests.Add(1)
				_, _ = io.Copy(io.Discard, io.LimitReader(request.Body, 8<<20))
				writer.WriteHeader(http.StatusOK)
			})
			var sink *httptest.Server
			if tlsSink {
				sink = httptest.NewTLSServer(sinkHandler)
			} else {
				sink = httptest.NewServer(sinkHandler)
			}
			defer sink.Close()

			var sourceRequests atomic.Uint64
			var sourceCredentialSeen atomic.Bool
			source := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				sourceRequests.Add(1)
				if request.Header.Get("X-Api-Key") == redirectCanary {
					sourceCredentialSeen.Store(true)
				}
				_, _ = io.Copy(io.Discard, io.LimitReader(request.Body, 8<<20))
				writer.Header().Set("Location", sink.URL+"/stolen")
				http.Error(writer, "REDIRECT_RESPONSE_SECRET_CANARY", http.StatusTemporaryRedirect)
			}))
			defer source.Close()

			rootCAs := x509.NewCertPool()
			rootCAs.AddCert(source.Certificate())
			if tlsSink {
				rootCAs.AddCert(sink.Certificate())
			}
			client := source.Client()
			transport := client.Transport.(*http.Transport).Clone()
			transport.TLSClientConfig = transport.TLSClientConfig.Clone()
			transport.TLSClientConfig.RootCAs = rootCAs
			client.Transport = transport

			var logs bytes.Buffer
			runtime, err := setupRuntime(
				context.Background(),
				slog.New(slog.NewTextHandler(&logs, nil)),
				Settings{
					Environment: "production",
					Endpoint:    source.URL + "/tenant",
					Headers:     "x-api-key=" + redirectCanary,
				},
				setupOptions{httpClient: client},
			)
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

			_, span := runtime.TracerProvider().Tracer("fukamu-cycle/http").Start(
				context.Background(),
				"GET /private/REDIRECT_BODY_SECRET_CANARY",
				trace.WithAttributes(attribute.String("http.route", "/private/REDIRECT_BODY_SECRET_CANARY")),
			)
			span.End()
			metrics, err := NewMetrics(runtime.MeterProvider(), nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			metrics.CycleCompleted(context.Background())

			started := time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			shutdownErr := runtime.Shutdown(ctx)
			cancel()
			shutdown = true
			if shutdownErr == nil {
				t.Fatal("Shutdown() unexpectedly succeeded after collector redirects")
			}
			if elapsed := time.Since(started); elapsed > 4*time.Second {
				t.Fatalf("redirect shutdown took %v", elapsed)
			}
			if sourceRequests.Load() < 2 || !sourceCredentialSeen.Load() {
				t.Fatalf("source requests=%d credential seen=%v, want both signal attempts with configured credential", sourceRequests.Load(), sourceCredentialSeen.Load())
			}
			if got := sinkRequests.Load(); got != 0 {
				t.Fatalf("redirect sink received %d requests, want zero", got)
			}
			for _, forbidden := range []string{redirectCanary, "REDIRECT_RESPONSE_SECRET_CANARY", "REDIRECT_BODY_SECRET_CANARY", sink.URL} {
				if strings.Contains(shutdownErr.Error(), forbidden) || strings.Contains(logs.String(), forbidden) {
					t.Fatalf("redirect failure revealed %q: err=%q log=%q", forbidden, shutdownErr, logs.String())
				}
			}
		})
	}
}

func TestMetricExportBoundaryRemovesAmbientResourceAttributes(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "secret.resource="+resourceCanary)
	receiver := &otlpReceiver{}
	server := httptest.NewTLSServer(receiver)
	defer server.Close()

	exporter, err := otlpmetrichttp.New(
		context.Background(),
		otlpmetrichttp.WithEndpointURL(server.URL+"/v1/metrics"),
		otlpmetrichttp.WithHTTPClient(pinnedHTTPClient(server.Client())),
		otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}),
	)
	if err != nil {
		t.Fatal(err)
	}
	fixedResource := resource.NewWithAttributes("", attribute.String("service.name", serviceName))
	provider := newMeterProvider(fixedResource, exporter)
	shutdown := false
	t.Cleanup(func() {
		if !shutdown {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = provider.Shutdown(ctx)
		}
	})

	metrics, err := NewMetrics(provider, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	metrics.CycleCompleted(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = provider.Shutdown(ctx)
	cancel()
	shutdown = true
	if err != nil {
		t.Fatal(err)
	}

	var exported []*collectmetricpb.ExportMetricsServiceRequest
	for _, request := range receiver.snapshot() {
		if bytes.Contains(request.body, []byte(resourceCanary)) {
			t.Fatalf("metric payload contains ambient resource canary %q", resourceCanary)
		}
		if request.path != "/v1/metrics" {
			t.Fatalf("unexpected request path %q", request.path)
		}
		var payload collectmetricpb.ExportMetricsServiceRequest
		if err := proto.Unmarshal(request.body, &payload); err != nil {
			t.Fatal(err)
		}
		exported = append(exported, &payload)
	}
	assertMetricPayload(t, exported, "cycle_completed_total")
}

func TestProductionCollectorFailureIsAsynchronousBoundedAndSecretSafe(t *testing.T) {
	const responseCanary = "COLLECTOR_RESPONSE_SECRET_CANARY"
	receiver := &otlpReceiver{status: http.StatusServiceUnavailable, body: responseCanary}
	server := httptest.NewTLSServer(receiver)
	defer server.Close()

	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	runtime, err := setupRuntime(
		context.Background(),
		logger,
		Settings{
			Environment: "production",
			Endpoint:    server.URL + "/tenant",
			Headers:     "authorization=Bearer%20" + headerSecretCanary,
		},
		setupOptions{httpClient: server.Client()},
	)
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

	metrics, err := NewMetrics(runtime.MeterProvider(), logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := httpapi.NewRouter(httpapi.Dependencies{
		Ready:          func(context.Context) error { return nil },
		Logger:         logger,
		Metrics:        metrics,
		TracerProvider: runtime.TracerProvider(),
	})
	for _, path := range []string{"/healthz", "/readyz"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		requestStarted := time.Now()
		router.ServeHTTP(response, request)
		if requestElapsed := time.Since(requestStarted); requestElapsed > 500*time.Millisecond {
			t.Fatalf("%s response took %v while collector was offline", path, requestElapsed)
		}
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", path, response.Code)
		}
	}
	if requests := receiver.snapshot(); len(requests) != 0 {
		t.Fatalf("application health/readiness synchronously probed collector: %#v", requests)
	}

	started := time.Now()
	shutdownContext, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	err = runtime.Shutdown(shutdownContext)
	cancel()
	shutdown = true
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("Shutdown() unexpectedly succeeded against a 503 collector")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Shutdown() took %v, want bounded by its context", elapsed)
	}
	if strings.Contains(err.Error(), headerSecretCanary) || strings.Contains(err.Error(), responseCanary) || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("Shutdown() error revealed collector data: %q", err)
	}

	requests := receiver.snapshot()
	seenTrace := false
	seenMetric := false
	for _, request := range requests {
		seenTrace = seenTrace || request.path == "/tenant/v1/traces"
		seenMetric = seenMetric || request.path == "/tenant/v1/metrics"
	}
	if !seenTrace || !seenMetric {
		t.Fatalf("collector attempts missing: trace=%v metric=%v requests=%#v", seenTrace, seenMetric, requests)
	}
	if !strings.Contains(logs.String(), diagnosticFailureMessage) {
		t.Fatalf("fixed telemetry failure diagnostic missing: %q", logs.String())
	}

	otel.GetErrorHandler().Handle(errors.New("LATE_EXPORT_SECRET_CANARY"))
	time.Sleep(50 * time.Millisecond)
	for _, forbidden := range []string{
		headerSecretCanary, responseCanary, server.URL, rawPathCanary, "LATE_EXPORT_SECRET_CANARY",
	} {
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("telemetry log contains forbidden value %q: %s", forbidden, logs.String())
		}
	}
}

type trackingSpanExporter struct {
	exportCalls  atomic.Uint64
	shutdownCall atomic.Bool
	exportErr    error
	shutdownErr  error
}

func (exporter *trackingSpanExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	exporter.exportCalls.Add(1)
	return exporter.exportErr
}

func (exporter *trackingSpanExporter) Shutdown(context.Context) error {
	exporter.shutdownCall.Store(true)
	return exporter.shutdownErr
}

type trackingMetricExporter struct {
	exportCalls    atomic.Uint64
	forceFlushCall atomic.Bool
	shutdownCall   atomic.Bool
	forceFlushErr  error
	shutdownErr    error
}

func (*trackingMetricExporter) Temporality(kind sdkmetric.InstrumentKind) metricdata.Temporality {
	return sdkmetric.DefaultTemporalitySelector(kind)
}

func (*trackingMetricExporter) Aggregation(kind sdkmetric.InstrumentKind) sdkmetric.Aggregation {
	return sdkmetric.DefaultAggregationSelector(kind)
}

func (exporter *trackingMetricExporter) Export(context.Context, *metricdata.ResourceMetrics) error {
	exporter.exportCalls.Add(1)
	return nil
}

func (exporter *trackingMetricExporter) ForceFlush(context.Context) error {
	exporter.forceFlushCall.Store(true)
	return exporter.forceFlushErr
}

func (exporter *trackingMetricExporter) Shutdown(context.Context) error {
	exporter.shutdownCall.Store(true)
	return exporter.shutdownErr
}

func TestSetupCleansBothNewProvidersWhenRuntimeIsAlreadyActive(t *testing.T) {
	first, err := Setup(context.Background(), nil, Settings{Environment: "development"})
	if err != nil {
		t.Fatal(err)
	}
	firstShutdown := false
	t.Cleanup(func() {
		if !firstShutdown {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = first.Shutdown(ctx)
		}
	})

	traceExporter := &trackingSpanExporter{}
	metricExporter := &trackingMetricExporter{}
	second, err := setupRuntime(
		context.Background(),
		nil,
		Settings{
			Environment: "production",
			Endpoint:    "https://collector.example/tenant",
			Headers:     "authorization=Bearer%20" + headerSecretCanary,
		},
		setupOptions{
			newTraceExporter: func(context.Context, ...otlptracehttp.Option) (sdktrace.SpanExporter, error) {
				return traceExporter, nil
			},
			newMetricExporter: func(context.Context, ...otlpmetrichttp.Option) (sdkmetric.Exporter, error) {
				return metricExporter, nil
			},
		},
	)
	if second != nil || !errors.Is(err, errRuntimeAlreadyActive) {
		t.Fatalf("second setup = (%v, %v), want fixed active-runtime failure", second, err)
	}
	if !traceExporter.shutdownCall.Load() || !metricExporter.shutdownCall.Load() {
		t.Fatalf("rejected runtime cleanup: trace=%v metric=%v", traceExporter.shutdownCall.Load(), metricExporter.shutdownCall.Load())
	}
	if activeRuntime != first || otel.GetTracerProvider() != first.traceProvider || otel.GetMeterProvider() != first.meterProvider {
		t.Fatal("rejected setup disturbed the active runtime or global providers")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = first.Shutdown(ctx)
	cancel()
	firstShutdown = true
	if err != nil {
		t.Fatal(err)
	}
}

func TestSetupCleansTraceExporterWhenMetricConstructionFails(t *testing.T) {
	const constructorSecret = "CONSTRUCTOR_SECRET_CANARY"
	traceExporter := &trackingSpanExporter{}
	var logs bytes.Buffer

	runtime, err := setupRuntime(
		context.Background(),
		slog.New(slog.NewTextHandler(&logs, nil)),
		Settings{
			Environment: "production",
			Endpoint:    "https://collector.example/tenant",
			Headers:     "authorization=Bearer%20" + headerSecretCanary,
		},
		setupOptions{
			newTraceExporter: func(context.Context, ...otlptracehttp.Option) (sdktrace.SpanExporter, error) {
				return traceExporter, nil
			},
			newMetricExporter: func(context.Context, ...otlpmetrichttp.Option) (sdkmetric.Exporter, error) {
				return nil, errors.New(constructorSecret)
			},
		},
	)
	if runtime != nil || err == nil {
		t.Fatalf("setupRuntime() = (%v, %v), want fixed failure", runtime, err)
	}
	if !traceExporter.shutdownCall.Load() {
		t.Fatal("trace exporter was not cleaned up after metric construction failure")
	}
	if strings.Contains(err.Error(), constructorSecret) || strings.Contains(err.Error(), headerSecretCanary) {
		t.Fatalf("construction error revealed a secret: %q", err)
	}
	if strings.Contains(logs.String(), constructorSecret) || strings.Contains(logs.String(), headerSecretCanary) {
		t.Fatalf("construction log revealed a secret: %q", logs.String())
	}
}

func TestRuntimeAttemptsBothSignalsAndRedactsLifecycleFailures(t *testing.T) {
	const lifecycleSecret = "LIFECYCLE_SECRET_CANARY"
	traceExporter := &trackingSpanExporter{
		exportErr:   errors.New(lifecycleSecret),
		shutdownErr: errors.New(lifecycleSecret),
	}
	metricExporter := &trackingMetricExporter{
		forceFlushErr: errors.New(lifecycleSecret),
		shutdownErr:   errors.New(lifecycleSecret),
	}
	var logs bytes.Buffer
	runtime, err := setupRuntime(
		context.Background(),
		slog.New(slog.NewTextHandler(&logs, nil)),
		Settings{
			Environment: "production",
			Endpoint:    "https://collector.example/tenant",
			Headers:     "authorization=Bearer%20" + headerSecretCanary,
		},
		setupOptions{
			newTraceExporter: func(context.Context, ...otlptracehttp.Option) (sdktrace.SpanExporter, error) {
				return traceExporter, nil
			},
			newMetricExporter: func(context.Context, ...otlpmetrichttp.Option) (sdkmetric.Exporter, error) {
				return metricExporter, nil
			},
		},
	)
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

	_, span := runtime.TracerProvider().Tracer("fukamu-cycle/test").Start(context.Background(), "test.operation")
	span.End()
	counter, err := runtime.MeterProvider().Meter("fukamu-cycle/test").Int64Counter("runtime_lifecycle_counter")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(context.Background(), 1)

	flushErr := runtime.ForceFlush(context.Background())
	if flushErr == nil {
		t.Fatal("ForceFlush() unexpectedly succeeded")
	}
	if traceExporter.exportCalls.Load() == 0 || !metricExporter.forceFlushCall.Load() {
		t.Fatalf("ForceFlush did not attempt both signals: trace=%d metric=%v", traceExporter.exportCalls.Load(), metricExporter.forceFlushCall.Load())
	}
	if strings.Contains(flushErr.Error(), lifecycleSecret) {
		t.Fatalf("ForceFlush() revealed exporter error: %q", flushErr)
	}

	shutdownErr := runtime.Shutdown(context.Background())
	shutdown = true
	if shutdownErr == nil {
		t.Fatal("Shutdown() unexpectedly succeeded")
	}
	if !traceExporter.shutdownCall.Load() || !metricExporter.shutdownCall.Load() {
		t.Fatalf("Shutdown did not attempt both signals: trace=%v metric=%v", traceExporter.shutdownCall.Load(), metricExporter.shutdownCall.Load())
	}
	if strings.Contains(shutdownErr.Error(), lifecycleSecret) || strings.Contains(logs.String(), lifecycleSecret) || strings.Contains(logs.String(), headerSecretCanary) {
		t.Fatalf("lifecycle failure revealed a secret: err=%q log=%q", shutdownErr, logs.String())
	}
}
