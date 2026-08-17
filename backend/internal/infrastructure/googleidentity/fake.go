package googleidentity

import (
	"context"
	"strings"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
)

// FakeVerifier is restricted to APP_ENV=test wiring. The token format is
// "test-google:<subject>" so E2E tests can deterministically model collisions.
type FakeVerifier struct{}

func (FakeVerifier) Verify(_ context.Context, rawToken string) (account.GoogleIdentity, error) {
	const prefix = "test-google:"
	if !strings.HasPrefix(rawToken, prefix) {
		return account.GoogleIdentity{}, account.ErrGoogleTokenInvalid
	}
	subject := strings.TrimSpace(strings.TrimPrefix(rawToken, prefix))
	if subject == "" || len(subject) > 255 {
		return account.GoogleIdentity{}, account.ErrGoogleTokenInvalid
	}
	return account.GoogleIdentity{Subject: subject}, nil
}
