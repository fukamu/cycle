package session

import (
	"context"
	"crypto/hmac"
	"errors"
	"fmt"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/csrftoken"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	"github.com/fukamu/cycle/backend/internal/identifier"
	"github.com/fukamu/cycle/backend/internal/securehash"
)

const (
	sessionTokenBytes = 32
)

var (
	ErrSessionMissing = errors.New("session is missing")
	ErrSessionExpired = errors.New("session is expired")
	ErrCSRFInvalid    = errors.New("CSRF token is invalid")
	ErrBootstrapID    = errors.New("bootstrap ID is invalid")
)

type Repository interface {
	FindByTokenHash(context.Context, []byte, time.Time) (AuthenticatedSession, error)
	ConvergeCSRF(context.Context, string, []byte, time.Time) error
	Touch(context.Context, string, time.Time, time.Time) error
	CreateOrResumeAnonymous(context.Context, CreateAnonymousRecord) (AnonymousRecord, error)
}

type AuthenticatedSession struct {
	ID                string
	UserID            user.ID
	CSRFTokenHash     []byte
	LastSeenAt        time.Time
	IdleExpiresAt     time.Time
	AbsoluteExpiresAt time.Time
	GoogleConnected   bool
	GoogleEmail       *string
}

type CreateAnonymousRecord struct {
	BootstrapKeyHash  []byte
	BootstrapExpires  time.Time
	UserID            user.ID
	SessionID         string
	SessionTokenHash  []byte
	CSRFTokenHash     []byte
	Now               time.Time
	IdleExpiresAt     time.Time
	AbsoluteExpiresAt time.Time
}

type AnonymousRecord struct {
	UserID  user.ID
	Created bool
}

type View struct {
	UserID          user.ID
	GoogleConnected bool
	GoogleEmail     *string
	CSRFToken       string
	SessionToken    string
	Created         bool `json:"-"`
}

type CreateAnonymousInput struct {
	BootstrapID    string
	TurnstileToken string
	RemoteAddress  string
	UserAgent      string
}

type Settings struct {
	SessionHashKey     []byte
	CSRFHashKey        []byte
	BootstrapHashKey   []byte
	IdleTTL            time.Duration
	AbsoluteTTL        time.Duration
	ActivityTouchAfter time.Duration
	BootstrapTTL       time.Duration
}

type Service struct {
	repository Repository
	clock      ports.Clock
	ids        ports.IDGenerator
	tokens     ports.TokenGenerator
	abuse      ports.AntiAbuseVerifier
	settings   Settings
}

func NewService(repository Repository, clock ports.Clock, ids ports.IDGenerator, tokens ports.TokenGenerator, abuse ports.AntiAbuseVerifier, settings Settings) *Service {
	return &Service{repository: repository, clock: clock, ids: ids, tokens: tokens, abuse: abuse, settings: settings}
}

func (service *Service) Authenticate(ctx context.Context, sessionToken string) (AuthenticatedSession, error) {
	if sessionToken == "" {
		return AuthenticatedSession{}, ErrSessionMissing
	}
	now := service.clock.Now().UTC()
	record, err := service.repository.FindByTokenHash(ctx, securehash.HMACSHA256(service.settings.SessionHashKey, []byte(sessionToken)), now)
	if err != nil {
		return AuthenticatedSession{}, err
	}
	if now.Sub(record.LastSeenAt) >= service.settings.ActivityTouchAfter {
		_ = service.repository.Touch(ctx, record.ID, now, now.Add(service.settings.IdleTTL))
	}
	return record, nil
}

func (service *Service) Refresh(ctx context.Context, sessionToken string) (View, error) {
	record, err := service.Authenticate(ctx, sessionToken)
	if err != nil {
		return View{}, err
	}
	csrfToken, err := csrftoken.Derive(service.settings.CSRFHashKey, record.ID)
	if err != nil {
		return View{}, err
	}
	now := service.clock.Now().UTC()
	if err := service.repository.ConvergeCSRF(ctx, record.ID, securehash.HMACSHA256(service.settings.CSRFHashKey, []byte(csrfToken)), now); err != nil {
		return View{}, err
	}
	return View{
		UserID:          record.UserID,
		GoogleConnected: record.GoogleConnected,
		GoogleEmail:     record.GoogleEmail,
		CSRFToken:       csrfToken,
		SessionToken:    sessionToken,
	}, nil
}

func (service *Service) CreateAnonymous(ctx context.Context, input CreateAnonymousInput) (View, error) {
	if !identifier.IsCanonicalUUIDv7(input.BootstrapID) {
		return View{}, ErrBootstrapID
	}
	if err := service.abuse.VerifyAnonymousCreation(ctx, ports.AnonymousAbuseInput{
		TurnstileToken: input.TurnstileToken,
		RemoteAddress:  input.RemoteAddress,
		UserAgent:      input.UserAgent,
		BootstrapID:    input.BootstrapID,
	}); err != nil {
		return View{}, err
	}

	userID, sessionID, err := service.newEntityIDs()
	if err != nil {
		return View{}, err
	}
	sessionToken, err := service.tokens.NewToken(sessionTokenBytes)
	if err != nil {
		return View{}, err
	}
	csrfToken, err := csrftoken.Derive(service.settings.CSRFHashKey, sessionID)
	if err != nil {
		return View{}, err
	}
	now := service.clock.Now().UTC()
	record, err := service.repository.CreateOrResumeAnonymous(ctx, CreateAnonymousRecord{
		BootstrapKeyHash:  securehash.HMACSHA256(service.settings.BootstrapHashKey, []byte(input.BootstrapID)),
		BootstrapExpires:  now.Add(service.settings.BootstrapTTL),
		UserID:            user.ID(userID),
		SessionID:         sessionID,
		SessionTokenHash:  securehash.HMACSHA256(service.settings.SessionHashKey, []byte(sessionToken)),
		CSRFTokenHash:     securehash.HMACSHA256(service.settings.CSRFHashKey, []byte(csrfToken)),
		Now:               now,
		IdleExpiresAt:     now.Add(service.settings.IdleTTL),
		AbsoluteExpiresAt: now.Add(service.settings.AbsoluteTTL),
	})
	if err != nil {
		return View{}, fmt.Errorf("create anonymous session: %w", err)
	}
	return View{
		UserID:          record.UserID,
		GoogleConnected: false,
		CSRFToken:       csrfToken,
		SessionToken:    sessionToken,
		Created:         record.Created,
	}, nil
}

func (service *Service) VerifyCSRF(record AuthenticatedSession, token string) error {
	if !csrftoken.IsValid(token) {
		return ErrCSRFInvalid
	}
	stableToken, err := csrftoken.Derive(service.settings.CSRFHashKey, record.ID)
	if err != nil {
		return ErrCSRFInvalid
	}
	presentedVerifier := securehash.HMACSHA256(service.settings.CSRFHashKey, []byte(token))
	if !csrfTokenMatches(
		stableToken,
		token,
		record.CSRFTokenHash,
		presentedVerifier,
		hmac.Equal,
	) {
		return ErrCSRFInvalid
	}
	return nil
}

func csrfTokenMatches(
	stableToken string,
	presentedToken string,
	storedVerifier []byte,
	presentedVerifier []byte,
	equal func([]byte, []byte) bool,
) bool {
	// Evaluate both paths before the OR so legacy and stable tokens do not
	// expose their type through short-circuit timing.
	stableMatches := equal([]byte(stableToken), []byte(presentedToken))
	storedVerifierMatches := equal(storedVerifier, presentedVerifier)
	return stableMatches || storedVerifierMatches
}

func (service *Service) newEntityIDs() (string, string, error) {
	userID, err := service.ids.NewID()
	if err != nil {
		return "", "", err
	}
	sessionID, err := service.ids.NewID()
	if err != nil {
		return "", "", err
	}
	return userID, sessionID, nil
}
