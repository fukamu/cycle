package googleidentity

import (
	"context"
	"errors"
	"net"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"google.golang.org/api/idtoken"

	"github.com/fukamu/cycle/backend/internal/application/account"
)

type Verifier struct {
	audience string
	validate func(context.Context, string, string) (*idtoken.Payload, error)
}

func NewVerifier(audience string) *Verifier {
	return &Verifier{audience: audience, validate: idtoken.Validate}
}

func (verifier *Verifier) Verify(ctx context.Context, rawToken string) (account.GoogleIdentity, error) {
	ctx, span := otel.Tracer("fukamu-cycle/google-identity").Start(ctx, "google.identity.verify")
	defer span.End()
	if strings.TrimSpace(rawToken) == "" || verifier.audience == "" {
		return account.GoogleIdentity{}, account.ErrGoogleTokenInvalid
	}
	payload, err := verifier.validate(ctx, rawToken, verifier.audience)
	if err != nil {
		span.SetStatus(codes.Error, "identity verification failed")
		var networkError net.Error
		if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &networkError) {
			return account.GoogleIdentity{}, account.ErrGoogleVerificationFailed
		}
		return account.GoogleIdentity{}, account.ErrGoogleTokenInvalid
	}
	if strings.TrimSpace(payload.Subject) == "" {
		return account.GoogleIdentity{}, account.ErrGoogleTokenInvalid
	}
	result := account.GoogleIdentity{Subject: payload.Subject}
	if email, ok := payload.Claims["email"].(string); ok && email != "" {
		result.Email = &email
	}
	if verified, ok := payload.Claims["email_verified"].(bool); ok {
		result.EmailVerified = &verified
	}
	return result, nil
}
