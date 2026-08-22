package system

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/fukamu/cycle/backend/internal/application/ports"
)

type Clock struct{}

func (Clock) Now() time.Time {
	return time.Now().UTC()
}

type RandomGenerator struct{}

func (RandomGenerator) NewID() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("generate UUID: %w", err)
	}
	return id.String(), nil
}

func (RandomGenerator) NewToken(byteLength int) (string, error) {
	if byteLength < 16 {
		return "", fmt.Errorf("token length %d is too short", byteLength)
	}
	raw := make([]byte, byteLength)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate random token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

type AllowAnonymous struct{}

func (AllowAnonymous) VerifyAnonymousCreation(context.Context, ports.AnonymousAbuseInput) error {
	return nil
}

type DenyAnonymous struct{}

func (DenyAnonymous) VerifyAnonymousCreation(context.Context, ports.AnonymousAbuseInput) error {
	return ports.ErrAntiAbuseUnavailable
}
