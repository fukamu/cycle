package system

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
)

type Clock struct{}

func (Clock) Now() time.Time {
	return time.Now().UTC()
}

type RandomGenerator struct{}

func (RandomGenerator) NewID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate UUID: %w", err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
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
