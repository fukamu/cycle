package turnstile

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/fukamu/cycle/backend/internal/application/ports"
)

func TestVerifierAcceptsMatchingResponseAndHashesNormalizedIP(t *testing.T) {
	t.Parallel()
	limiter := &fakeLimiter{}
	client := &fakeHTTPClient{response: response(http.StatusOK, `{"success":true,"hostname":"cycle.example","action":"anonymous_bootstrap"}`)}
	verifier := testVerifier(client, limiter)
	err := verifier.VerifyAnonymousCreation(context.Background(), ports.AnonymousAbuseInput{
		TurnstileToken: "opaque-token", RemoteAddress: "203.0.113.10:54321", BootstrapID: "00000000-0000-7000-8000-000000000001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(limiter.key) == 0 || string(limiter.key) == "203.0.113.10" {
		t.Fatalf("rate key was not pseudonymized: %q", limiter.key)
	}
	if client.request == nil {
		t.Fatal("siteverify request was not sent")
	}
	if err := client.request.ParseForm(); err != nil {
		t.Fatal(err)
	}
	if client.request.Form.Get("response") != "opaque-token" || client.request.Form.Get("remoteip") != "203.0.113.10" {
		t.Fatalf("unexpected form: %#v", client.request.Form)
	}
}

func TestVerifierFailsClosedForInvalidSignals(t *testing.T) {
	t.Parallel()
	tests := map[string]string{
		"unsuccessful":     `{"success":false,"error-codes":["invalid-input-response"]}`,
		"wrong action":     `{"success":true,"hostname":"cycle.example","action":"other"}`,
		"wrong hostname":   `{"success":true,"hostname":"evil.example","action":"anonymous_bootstrap"}`,
		"missing hostname": `{"success":true,"action":"anonymous_bootstrap"}`,
	}
	for name, body := range tests {
		body := body
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			err := testVerifier(&fakeHTTPClient{response: response(http.StatusOK, body)}, &fakeLimiter{}).VerifyAnonymousCreation(
				context.Background(), ports.AnonymousAbuseInput{TurnstileToken: "token", RemoteAddress: "203.0.113.1"},
			)
			if !errors.Is(err, ports.ErrAnonymousCreationBlocked) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestVerifierTreatsSiteverifyFailureAsUnavailable(t *testing.T) {
	t.Parallel()
	tests := map[string]*fakeHTTPClient{
		"network":      {err: errors.New("service down")},
		"status":       {response: response(http.StatusBadGateway, "upstream failed")},
		"invalid json": {response: response(http.StatusOK, "not-json")},
	}
	for name, client := range tests {
		client := client
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			err := testVerifier(client, &fakeLimiter{}).VerifyAnonymousCreation(
				context.Background(), ports.AnonymousAbuseInput{TurnstileToken: "token", RemoteAddress: "203.0.113.1"},
			)
			if !errors.Is(err, ports.ErrAntiAbuseUnavailable) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func testVerifier(client HTTPClient, limiter RateLimiter) *Verifier {
	return testVerifierWithObserver(client, limiter, nil)
}

func testVerifierWithObserver(client HTTPClient, limiter RateLimiter, observer Observer) *Verifier {
	return NewVerifier(client, limiter, turnstileFakeClock{}, Settings{
		SecretKey: "secret", ExpectedAction: "anonymous_bootstrap", ExpectedHost: "cycle.example",
		RateHashKey: []byte("rate-key"), SiteverifyURL: "https://verify.example/siteverify", Observer: observer,
	})
}

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

type fakeHTTPClient struct {
	request  *http.Request
	response *http.Response
	err      error
}

func (client *fakeHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.request = request
	return client.response, client.err
}

type fakeLimiter struct {
	key []byte
	err error
}

func (limiter *fakeLimiter) Check(_ context.Context, key []byte, _ time.Time) error {
	limiter.key = append([]byte(nil), key...)
	return limiter.err
}

type turnstileFakeClock struct{}

func (turnstileFakeClock) Now() time.Time {
	return time.Date(2026, time.August, 17, 0, 0, 0, 0, time.UTC)
}

func TestVerifierSpanPreservesCallerParentWithoutRetainingAbuseMaterial(t *testing.T) {
	const (
		rawToken = "RAW_TURNSTILE_TOKEN_CANARY"
		rawIP    = "203.0.113.199"
		body     = "RAW_SITEVERIFY_BODY_CANARY"
	)
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previousProvider := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() {
		slog.SetDefault(previousLogger)
		otel.SetTracerProvider(previousProvider)
		_ = provider.Shutdown(context.Background())
	})

	observer := &recordingObserver{}
	client := &fakeHTTPClient{response: response(http.StatusOK,
		`{"success":true,"hostname":"cycle.example","action":"anonymous_bootstrap","private":"`+body+`"}`)}
	verifier := testVerifierWithObserver(client, &fakeLimiter{}, observer)
	ctx, parent := provider.Tracer("test").Start(context.Background(), "caller")
	if err := verifier.VerifyAnonymousCreation(ctx, ports.AnonymousAbuseInput{
		TurnstileToken: rawToken, RemoteAddress: rawIP + ":65432",
	}); err != nil {
		t.Fatal(err)
	}
	parent.End()

	span := findTurnstileSpan(t, exporter.GetSpans())
	if span.Parent.SpanID() != parent.SpanContext().SpanID() || span.SpanContext.TraceID() != parent.SpanContext().TraceID() {
		t.Fatalf("Turnstile parent/trace = %s/%s, want %s/%s", span.Parent.SpanID(), span.SpanContext.TraceID(), parent.SpanContext().SpanID(), parent.SpanContext().TraceID())
	}
	assertObserverCalls(t, observer, []string{"success"}, nil)
	observed := fmt.Sprintf("%#v\n%s\n%#v", exporter.GetSpans(), logs.String(), observer)
	for _, forbidden := range []string{rawToken, rawIP, body} {
		if strings.Contains(observed, forbidden) {
			t.Fatalf("Turnstile observability retained %q: %s", forbidden, observed)
		}
	}
}

func TestVerifierObserverClassifiesSiteverifyOutcomesExactlyOnce(t *testing.T) {
	tests := []struct {
		name    string
		input   ports.AnonymousAbuseInput
		client  *fakeHTTPClient
		wantErr error
		result  string
	}{
		{
			name: "success", input: ports.AnonymousAbuseInput{TurnstileToken: "token", RemoteAddress: "203.0.113.1"},
			client: &fakeHTTPClient{response: response(http.StatusOK, `{"success":true,"hostname":"cycle.example","action":"anonymous_bootstrap"}`)}, result: "success",
		},
		{
			name: "blank token", input: ports.AnonymousAbuseInput{RemoteAddress: "203.0.113.1"},
			client: &fakeHTTPClient{}, wantErr: ports.ErrAnonymousCreationBlocked, result: "blocked",
		},
		{
			name: "invalid response", input: ports.AnonymousAbuseInput{TurnstileToken: "token", RemoteAddress: "203.0.113.1"},
			client: &fakeHTTPClient{response: response(http.StatusOK, `{"success":false,"error-codes":["invalid-input-response"]}`)}, wantErr: ports.ErrAnonymousCreationBlocked, result: "blocked",
		},
		{
			name: "network failure", input: ports.AnonymousAbuseInput{TurnstileToken: "token", RemoteAddress: "203.0.113.1"},
			client: &fakeHTTPClient{err: errors.New("service down")}, wantErr: ports.ErrAntiAbuseUnavailable, result: "unavailable",
		},
		{
			name: "status failure", input: ports.AnonymousAbuseInput{TurnstileToken: "token", RemoteAddress: "203.0.113.1"},
			client: &fakeHTTPClient{response: response(http.StatusBadGateway, "upstream failed")}, wantErr: ports.ErrAntiAbuseUnavailable, result: "unavailable",
		},
		{
			name: "invalid JSON", input: ports.AnonymousAbuseInput{TurnstileToken: "token", RemoteAddress: "203.0.113.1"},
			client: &fakeHTTPClient{response: response(http.StatusOK, "not-json")}, wantErr: ports.ErrAntiAbuseUnavailable, result: "unavailable",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			observer := &recordingObserver{}
			err := testVerifierWithObserver(test.client, &fakeLimiter{}, observer).VerifyAnonymousCreation(context.Background(), test.input)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
			assertObserverCalls(t, observer, []string{test.result}, nil)
		})
	}
}

func TestVerifierObserverSeparatesSuccessfulSiteverifyFromAnonymousRateLimit(t *testing.T) {
	observer := &recordingObserver{}
	client := &fakeHTTPClient{response: response(http.StatusOK,
		`{"success":true,"hostname":"cycle.example","action":"anonymous_bootstrap"}`)}
	limiter := &fakeLimiter{err: ports.ErrAnonymousCreationBlocked}
	err := testVerifierWithObserver(client, limiter, observer).VerifyAnonymousCreation(context.Background(), ports.AnonymousAbuseInput{
		TurnstileToken: "token", RemoteAddress: "203.0.113.1",
	})
	if !errors.Is(err, ports.ErrAnonymousCreationBlocked) {
		t.Fatalf("error = %v, want %v", err, ports.ErrAnonymousCreationBlocked)
	}
	assertObserverCalls(t, observer, []string{"success"}, []string{"anonymous"})
}

func findTurnstileSpan(t *testing.T, spans tracetest.SpanStubs) tracetest.SpanStub {
	t.Helper()
	for _, span := range spans {
		if span.Name == "turnstile.siteverify" {
			return span
		}
	}
	t.Fatalf("Turnstile span not found in %#v", spans)
	return tracetest.SpanStub{}
}

func assertObserverCalls(t *testing.T, observer *recordingObserver, turnstile, rateLimit []string) {
	t.Helper()
	if len(observer.turnstileResults) != len(turnstile) {
		t.Fatalf("Turnstile observer calls = %q, want %q", observer.turnstileResults, turnstile)
	}
	for index, result := range turnstile {
		if observer.turnstileResults[index] != result {
			t.Fatalf("Turnstile observer calls = %q, want %q", observer.turnstileResults, turnstile)
		}
	}
	if len(observer.rateLimitScopes) != len(rateLimit) {
		t.Fatalf("rate-limit observer calls = %q, want %q", observer.rateLimitScopes, rateLimit)
	}
	for index, scope := range rateLimit {
		if observer.rateLimitScopes[index] != scope {
			t.Fatalf("rate-limit observer calls = %q, want %q", observer.rateLimitScopes, rateLimit)
		}
	}
}

type recordingObserver struct {
	turnstileResults []string
	rateLimitScopes  []string
}

func (observer *recordingObserver) TurnstileVerification(_ context.Context, result string) {
	observer.turnstileResults = append(observer.turnstileResults, result)
}

func (observer *recordingObserver) RateLimitRejected(_ context.Context, scope string) {
	observer.rateLimitScopes = append(observer.rateLimitScopes, scope)
}
