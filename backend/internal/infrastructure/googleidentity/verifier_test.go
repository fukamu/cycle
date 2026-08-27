package googleidentity

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"google.golang.org/api/idtoken"

	"github.com/fukamu/cycle/backend/internal/application/account"
)

func TestVerifierUsesSubjectAsIdentityAndTreatsEmailAsMetadata(t *testing.T) {
	email := "first@example.com"
	verified := true
	verifier := &Verifier{audience: "client-id", validate: func(_ context.Context, raw, audience string) (*idtoken.Payload, error) {
		if raw != "signed-token" || audience != "client-id" {
			t.Fatal("validator did not receive the token and configured audience")
		}
		return &idtoken.Payload{Subject: "stable-google-sub", Claims: map[string]any{
			"email": email, "email_verified": verified,
		}}, nil
	}}
	identity, err := verifier.Verify(context.Background(), "signed-token")
	if err != nil || identity.Subject != "stable-google-sub" || identity.Email == nil || *identity.Email != email || identity.EmailVerified == nil || !*identity.EmailVerified {
		t.Fatalf("identity/error = %#v/%v", identity, err)
	}
}

func TestVerifierFailsClosedForTokenValidationAndMissingSubject(t *testing.T) {
	tests := []struct {
		name     string
		validate func(context.Context, string, string) (*idtoken.Payload, error)
		want     error
	}{
		{"invalid signature, audience, or expiry", func(context.Context, string, string) (*idtoken.Payload, error) {
			return nil, errors.New("validation failed")
		}, account.ErrGoogleTokenInvalid},
		{"missing subject", func(context.Context, string, string) (*idtoken.Payload, error) {
			return &idtoken.Payload{}, nil
		}, account.ErrGoogleTokenInvalid},
		{"verification network timeout", func(context.Context, string, string) (*idtoken.Payload, error) {
			return nil, &net.DNSError{IsTimeout: true}
		}, account.ErrGoogleVerificationFailed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			verifier := &Verifier{audience: "client-id", validate: test.validate}
			if _, err := verifier.Verify(context.Background(), "signed-token"); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestVerifierSpanPreservesCallerParentWithoutRetainingIdentityMaterial(t *testing.T) {
	const (
		rawToken = "RAW_GOOGLE_ID_TOKEN_CANARY"
		rawEmail = "raw-google-email-canary@example.invalid"
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

	ctx, parent := provider.Tracer("test").Start(context.Background(), "caller")
	verifier := &Verifier{audience: "client-id", validate: func(_ context.Context, token, audience string) (*idtoken.Payload, error) {
		if token != rawToken || audience != "client-id" {
			t.Fatalf("validator arguments = %q/%q", token, audience)
		}
		return &idtoken.Payload{Subject: "stable-google-sub", Claims: map[string]any{"email": rawEmail}}, nil
	}}
	identity, err := verifier.Verify(ctx, rawToken)
	if err != nil || identity.Email == nil || *identity.Email != rawEmail {
		t.Fatalf("identity/error = %#v/%v", identity, err)
	}
	parent.End()

	span := findIdentitySpan(t, exporter.GetSpans())
	if span.Parent.SpanID() != parent.SpanContext().SpanID() || span.SpanContext.TraceID() != parent.SpanContext().TraceID() {
		t.Fatalf("identity parent/trace = %s/%s, want %s/%s", span.Parent.SpanID(), span.SpanContext.TraceID(), parent.SpanContext().SpanID(), parent.SpanContext().TraceID())
	}
	assertIdentityMaterialAbsent(t, fmt.Sprintf("%#v\n%s", exporter.GetSpans(), logs.String()), rawToken, rawEmail)
}

func TestVerifierFailureSpanAndLogsDoNotRetainValidatorErrorMaterial(t *testing.T) {
	const (
		rawToken = "RAW_INVALID_GOOGLE_TOKEN_CANARY"
		rawEmail = "validator-error-email-canary@example.invalid"
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

	verifier := &Verifier{audience: "client-id", validate: func(context.Context, string, string) (*idtoken.Payload, error) {
		return nil, fmt.Errorf("provider rejected %s for %s", rawToken, rawEmail)
	}}
	if _, err := verifier.Verify(context.Background(), rawToken); !errors.Is(err, account.ErrGoogleTokenInvalid) {
		t.Fatalf("error = %v, want %v", err, account.ErrGoogleTokenInvalid)
	}

	span := findIdentitySpan(t, exporter.GetSpans())
	if span.Status.Description != "identity verification failed" {
		t.Fatalf("identity span status = %#v", span.Status)
	}
	assertIdentityMaterialAbsent(t, fmt.Sprintf("%#v\n%s", exporter.GetSpans(), logs.String()), rawToken, rawEmail)
}

func findIdentitySpan(t *testing.T, spans tracetest.SpanStubs) tracetest.SpanStub {
	t.Helper()
	for _, span := range spans {
		if span.Name == "google.identity.verify" {
			return span
		}
	}
	t.Fatalf("google identity span not found in %#v", spans)
	return tracetest.SpanStub{}
}

func assertIdentityMaterialAbsent(t *testing.T, observed string, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if strings.Contains(observed, value) {
			t.Fatalf("identity observability retained %q: %s", value, observed)
		}
	}
}
