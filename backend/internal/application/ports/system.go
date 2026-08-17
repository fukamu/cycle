package ports

import (
	"context"
	"errors"
	"time"
)

var (
	ErrAnonymousCreationBlocked = errors.New("anonymous creation blocked")
	ErrAntiAbuseUnavailable     = errors.New("anti-abuse service unavailable")
)

type Clock interface {
	Now() time.Time
}

type IDGenerator interface {
	NewID() (string, error)
}

type TokenGenerator interface {
	NewToken(byteLength int) (string, error)
}

type AnonymousAbuseInput struct {
	TurnstileToken string
	RemoteAddress  string
	UserAgent      string
	BootstrapID    string
}

type AntiAbuseVerifier interface {
	VerifyAnonymousCreation(context.Context, AnonymousAbuseInput) error
}
