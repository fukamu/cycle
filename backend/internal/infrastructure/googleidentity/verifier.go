package googleidentity

import (
	"context"
	"errors"
	"net"
	"strings"

	"google.golang.org/api/idtoken"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
)

type Verifier struct {
	audience string
}

func NewVerifier(audience string) *Verifier {
	return &Verifier{audience: audience}
}

func (verifier *Verifier) Verify(ctx context.Context, rawToken string) (account.GoogleIdentity, error) {
	if strings.TrimSpace(rawToken) == "" || verifier.audience == "" {
		return account.GoogleIdentity{}, account.ErrGoogleTokenInvalid
	}
	payload, err := idtoken.Validate(ctx, rawToken, verifier.audience)
	if err != nil {
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
