package googleidentity

import (
	"context"
	"errors"
	"net"
	"testing"

	"google.golang.org/api/idtoken"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
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
