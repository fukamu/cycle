package session

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

const (
	sessionTokenBytes = 32
	csrfTokenBytes    = 32
)

var (
	ErrSessionMissing = errors.New("session is missing")
	ErrSessionExpired = errors.New("session is expired")
	ErrCSRFInvalid    = errors.New("CSRF token is invalid")
	ErrBootstrapID    = errors.New("bootstrap ID is invalid")
)

type Repository interface {
	FindByTokenHash(context.Context, []byte, time.Time) (AuthenticatedSession, error)
	RotateCSRF(context.Context, string, []byte, time.Time) error
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
	record, err := service.repository.FindByTokenHash(ctx, keyedHash(service.settings.SessionHashKey, sessionToken), now)
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
	csrfToken, err := service.tokens.NewToken(csrfTokenBytes)
	if err != nil {
		return View{}, err
	}
	now := service.clock.Now().UTC()
	if err := service.repository.RotateCSRF(ctx, record.ID, keyedHash(service.settings.CSRFHashKey, csrfToken), now); err != nil {
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
	if !isCanonicalUUID(input.BootstrapID) {
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
	csrfToken, err := service.tokens.NewToken(csrfTokenBytes)
	if err != nil {
		return View{}, err
	}
	now := service.clock.Now().UTC()
	record, err := service.repository.CreateOrResumeAnonymous(ctx, CreateAnonymousRecord{
		BootstrapKeyHash:  keyedHash(service.settings.BootstrapHashKey, input.BootstrapID),
		BootstrapExpires:  now.Add(service.settings.BootstrapTTL),
		UserID:            user.ID(userID),
		SessionID:         sessionID,
		SessionTokenHash:  keyedHash(service.settings.SessionHashKey, sessionToken),
		CSRFTokenHash:     keyedHash(service.settings.CSRFHashKey, csrfToken),
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
	}, nil
}

func (service *Service) VerifyCSRF(record AuthenticatedSession, token string) error {
	if token == "" || !hmac.Equal(record.CSRFTokenHash, keyedHash(service.settings.CSRFHashKey, token)) {
		return ErrCSRFInvalid
	}
	return nil
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

func keyedHash(key []byte, value string) []byte {
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write([]byte(value))
	return hash.Sum(nil)
}

func isCanonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}
