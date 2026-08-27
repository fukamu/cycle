package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/fukamu/cycle/backend/internal/infrastructure/safelog"
)

func TestHandlerPanicReturnsFixed500WithoutExportingRawValue(t *testing.T) {
	const (
		panicCanary = "GOAL_BODY_SESSION_TOKEN_PANIC_CANARY"
		bodyCanary  = "REQUEST_BODY_CANARY"
		rawIPCanary = "203.0.113.77"
		requestID   = "0198c20b-7b95-7000-8000-000000000077"
	)
	spanRecorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spanRecorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	var logs bytes.Buffer
	metrics := &panicMetrics{}
	router := NewRouter(Dependencies{
		Ready:  func(context.Context) error { panic(panicCanary) },
		Logger: safelog.NewJSON(&logs), TracerProvider: provider,
		Metrics: metrics,
	})
	request := httptest.NewRequest(http.MethodGet, "/readyz", strings.NewReader(bodyCanary))
	request.RemoteAddr = rawIPCanary + ":43210"
	request.Header.Set("X-Request-ID", requestID)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("panic response status = %d, want 500: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || !strings.HasPrefix(response.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("panic response headers = %v", response.Header())
	}
	var envelope errorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "INTERNAL_ERROR" || envelope.Error.RequestID != requestID || envelope.Error.Message == "" || envelope.Error.Details != nil {
		t.Fatalf("panic response = %#v", envelope)
	}

	spans := spanRecorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	span := spans[0]
	if span.Status().Code != codes.Error || len(span.Events()) != 0 || len(span.Links()) != 0 {
		t.Fatalf("panic span status/events/links = %#v/%v/%v", span.Status(), span.Events(), span.Links())
	}
	exported := span.Name() + " " + span.Status().Description
	for _, item := range span.Attributes() {
		exported += " " + string(item.Key) + "=" + item.Value.Emit()
	}
	combined := exported + "\n" + logs.String() + "\n" + response.Body.String()
	for _, forbidden := range []string{panicCanary, bodyCanary, rawIPCanary, "goroutine", "stack"} {
		if strings.Contains(combined, forbidden) {
			t.Fatalf("panic handling leaked %q: %s", forbidden, combined)
		}
	}
	if !strings.Contains(logs.String(), "http_handler_panic") || !strings.Contains(logs.String(), "INTERNAL_ERROR") {
		t.Fatalf("panic log lacks fixed classification: %s", logs.String())
	}
	if len(metrics.errorCodes) != 1 || metrics.errorCodes[0] != "INTERNAL_ERROR" {
		t.Fatalf("panic error metrics = %v, want one INTERNAL_ERROR", metrics.errorCodes)
	}
}

type panicMetrics struct {
	Metrics
	errorCodes []string
}

func (*panicMetrics) ObserveHTTP(context.Context, string, int, time.Duration) {}

func (metrics *panicMetrics) ErrorCode(_ context.Context, code string) {
	metrics.errorCodes = append(metrics.errorCodes, code)
}
