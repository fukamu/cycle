package turnstile

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
)

func TestVerifierAcceptsMatchingResponseAndHashesNormalizedIP(t *testing.T) {
	t.Parallel()
	limiter := &fakeLimiter{}
	client := &fakeHTTPClient{response: response(http.StatusOK, `{"success":true,"hostname":"pdcai.example","action":"anonymous_bootstrap"}`)}
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
		"wrong action":     `{"success":true,"hostname":"pdcai.example","action":"other"}`,
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
	return NewVerifier(client, limiter, turnstileFakeClock{}, Settings{
		SecretKey: "secret", ExpectedAction: "anonymous_bootstrap", ExpectedHost: "pdcai.example",
		RateHashKey: []byte("rate-key"), SiteverifyURL: "https://verify.example/siteverify",
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
