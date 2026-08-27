package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestNormalizedHTTPMethodUsesFixedAllowlist(t *testing.T) {
	for _, method := range []string{
		http.MethodConnect, http.MethodDelete, http.MethodGet, http.MethodHead, http.MethodOptions,
		http.MethodPatch, http.MethodPost, http.MethodPut, http.MethodTrace,
	} {
		if got := normalizedHTTPMethod(method); got != method {
			t.Errorf("normalizedHTTPMethod(%q) = %q", method, got)
		}
	}
	for _, method := range []string{"", "get", "METHOD_CANARY"} {
		if got := normalizedHTTPMethod(method); got != "OTHER" {
			t.Errorf("normalizedHTTPMethod(%q) = %q, want OTHER", method, got)
		}
	}
}

func TestRouterExportsOnlySafeServerSpanAttributes(t *testing.T) {
	spanRecorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spanRecorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	const (
		rawMethodCanary  = "METHOD_CANARY"
		rawPathCanary    = "0198c20b-7b95-7000-8000-000000000099"
		rawIPCanary      = "203.0.113.99"
		userAgentCanary  = "USER_AGENT_CANARY"
		bodyCanary       = "BODY_CANARY"
		baggageCanary    = "BAGGAGE_CANARY"
		traceStateCanary = "TRACESTATE_CANARY"
	)
	request := httptest.NewRequest(rawMethodCanary, "/private/"+rawPathCanary, strings.NewReader(bodyCanary))
	request.RemoteAddr = rawIPCanary + ":43210"
	request.Header.Set("X-Forwarded-For", rawIPCanary)
	request.Header.Set("CF-Connecting-IP", rawIPCanary)
	request.Header.Set("User-Agent", userAgentCanary)
	request.Header.Set("Baggage", "unsafe="+baggageCanary)
	request.Header.Set("Traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")
	request.Header.Set("Tracestate", "vendor="+traceStateCanary)

	response := httptest.NewRecorder()
	NewRouter(Dependencies{TracerProvider: provider}).ServeHTTP(response, request)

	spans := spanRecorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	span := spans[0]
	if got := span.Name(); got != "OTHER unmatched" {
		t.Fatalf("span name = %q, want safe normalized name", got)
	}
	if got := span.Parent().SpanID().String(); got != "0123456789abcdef" {
		t.Fatalf("parent span ID = %q", got)
	}
	if got := span.Parent().TraceID().String(); got != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("parent trace ID = %q", got)
	}
	if !span.Parent().IsRemote() {
		t.Fatal("parent span context must remain remote")
	}
	if got := span.Parent().TraceState().String(); got != "" {
		t.Fatalf("parent tracestate = %q, want empty", got)
	}

	wantAttributes := map[attribute.Key]any{
		"http.request.method":       "OTHER",
		"http.route":                "unmatched",
		"http.response.status_code": int64(response.Code),
		"fukamu.request_id":         "00000000-0000-7000-8000-000000000000",
	}
	if len(span.Attributes()) != len(wantAttributes) {
		t.Fatalf("span attributes = %v", span.Attributes())
	}
	for _, item := range span.Attributes() {
		want, ok := wantAttributes[item.Key]
		if !ok {
			t.Fatalf("unexpected span attribute %q", item.Key)
		}
		if got := item.Value.AsInterface(); got != want {
			t.Fatalf("span attribute %q = %#v, want %#v", item.Key, got, want)
		}
	}

	exported := span.Name()
	for _, item := range span.Attributes() {
		exported += " " + string(item.Key) + "=" + item.Value.Emit()
	}
	for _, forbidden := range []string{
		rawMethodCanary, rawPathCanary, rawIPCanary, userAgentCanary, bodyCanary, baggageCanary, traceStateCanary,
		"client.address", "network.peer.address", "user_agent.original", "url.path",
	} {
		if strings.Contains(exported, forbidden) {
			t.Fatalf("exported span contains forbidden value or attribute %q: %s", forbidden, exported)
		}
	}
}
