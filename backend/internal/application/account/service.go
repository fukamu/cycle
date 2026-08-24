package account

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

const tokenBytes = 32

var (
	ErrGoogleTokenInvalid         = errors.New("Google ID token is invalid")
	ErrGoogleVerificationFailed   = errors.New("Google identity verification unavailable")
	ErrGoogleIdentityLinked       = errors.New("Google identity is already linked")
	ErrGoogleAccountNotLinked     = errors.New("Google account is not linked")
	ErrDeleteConfirmationRequired = errors.New("account delete confirmation is required")
	ErrAccountUpgradeFailed       = errors.New("account upgrade failed")
	ErrGoogleLoginFailed          = errors.New("Google login failed")
	ErrAccountDeleteFailed        = errors.New("account delete failed")
)

type GoogleIdentity struct {
	Subject       string
	Email         *string
	EmailVerified *bool
}

type GoogleVerifier interface {
	Verify(context.Context, string) (GoogleIdentity, error)
}

type Repository interface {
	UpgradeGoogle(context.Context, UpgradeRecord) (AuthResult, error)
	LoginGoogle(context.Context, LoginRecord) (AuthResult, error)
	DeleteAccount(context.Context, user.ID, time.Time) (DeleteResult, error)
}

type Observer interface {
	AIUnattributedCost(context.Context, float64)
	AICostSettlement(context.Context, string, string, int64)
}

type UpgradeRecord struct {
	CurrentUserID     user.ID
	CurrentSessionID  string
	IdentityID        string
	Identity          GoogleIdentity
	NewSessionID      string
	SessionTokenHash  []byte
	CSRFTokenHash     []byte
	Now               time.Time
	IdleExpiresAt     time.Time
	AbsoluteExpiresAt time.Time
}

type LoginRecord struct {
	CurrentSessionID  string
	Identity          GoogleIdentity
	NewSessionID      string
	SessionTokenHash  []byte
	CSRFTokenHash     []byte
	Now               time.Time
	IdleExpiresAt     time.Time
	AbsoluteExpiresAt time.Time
}

type AuthResult struct {
	UserID      user.ID
	GoogleEmail *string
}

type DeleteResult struct {
	UnattributedCostUSD      float64
	SettlementOperationCount int64
}

type View struct {
	UserID          user.ID
	GoogleConnected bool
	GoogleEmail     *string
	SessionToken    string
	CSRFToken       string
}

type Settings struct {
	SessionHashKey []byte
	CSRFHashKey    []byte
	IdleTTL        time.Duration
	AbsoluteTTL    time.Duration
	Observer       Observer
}

type Service struct {
	repository Repository
	verifier   GoogleVerifier
	clock      ports.Clock
	ids        ports.IDGenerator
	tokens     ports.TokenGenerator
	settings   Settings
}

func NewService(repository Repository, verifier GoogleVerifier, clock ports.Clock, ids ports.IDGenerator, tokens ports.TokenGenerator, settings Settings) *Service {
	return &Service{repository: repository, verifier: verifier, clock: clock, ids: ids, tokens: tokens, settings: settings}
}

func (service *Service) UpgradeGoogle(ctx context.Context, currentUserID user.ID, currentSessionID, idToken string) (View, error) {
	identity, err := service.verifier.Verify(ctx, idToken)
	if err != nil {
		return View{}, err
	}
	identityID, err := service.ids.NewID()
	if err != nil {
		return View{}, err
	}
	view, err := service.createSession(ctx, func(session sessionMaterial) (AuthResult, error) {
		return service.repository.UpgradeGoogle(ctx, UpgradeRecord{
			CurrentUserID: currentUserID, CurrentSessionID: currentSessionID,
			IdentityID: identityID, Identity: identity,
			NewSessionID: session.id, SessionTokenHash: session.tokenHash, CSRFTokenHash: session.csrfHash,
			Now: session.now, IdleExpiresAt: session.idleExpiresAt, AbsoluteExpiresAt: session.absoluteExpiresAt,
		})
	})
	if err != nil && !errors.Is(err, ErrGoogleIdentityLinked) {
		return View{}, errors.Join(ErrAccountUpgradeFailed, err)
	}
	return view, err
}

func (service *Service) LoginGoogle(ctx context.Context, currentSessionID, idToken string) (View, error) {
	identity, err := service.verifier.Verify(ctx, idToken)
	if err != nil {
		return View{}, err
	}
	view, err := service.createSession(ctx, func(session sessionMaterial) (AuthResult, error) {
		return service.repository.LoginGoogle(ctx, LoginRecord{
			CurrentSessionID: currentSessionID, Identity: identity,
			NewSessionID: session.id, SessionTokenHash: session.tokenHash, CSRFTokenHash: session.csrfHash,
			Now: session.now, IdleExpiresAt: session.idleExpiresAt, AbsoluteExpiresAt: session.absoluteExpiresAt,
		})
	})
	if err != nil && !errors.Is(err, ErrGoogleAccountNotLinked) {
		return View{}, errors.Join(ErrGoogleLoginFailed, err)
	}
	return view, err
}

func (service *Service) Delete(ctx context.Context, userID user.ID, confirmed bool) error {
	if !confirmed {
		return ErrDeleteConfirmationRequired
	}
	now := service.clock.Now().UTC()
	result, err := service.repository.DeleteAccount(ctx, userID, now)
	if service.settings.Observer != nil && result.SettlementOperationCount > 0 {
		settlementResult := "success"
		if err != nil {
			settlementResult = "failure"
		}
		service.settings.Observer.AICostSettlement(
			context.WithoutCancel(ctx), "account_delete", settlementResult, result.SettlementOperationCount,
		)
	}
	if err != nil {
		return errors.Join(ErrAccountDeleteFailed, err)
	}
	if service.settings.Observer != nil && result.UnattributedCostUSD > 0 {
		service.settings.Observer.AIUnattributedCost(context.WithoutCancel(ctx), result.UnattributedCostUSD)
	}
	return nil
}

type sessionMaterial struct {
	id                string
	token             string
	csrf              string
	tokenHash         []byte
	csrfHash          []byte
	now               time.Time
	idleExpiresAt     time.Time
	absoluteExpiresAt time.Time
}

func (service *Service) createSession(ctx context.Context, operation func(sessionMaterial) (AuthResult, error)) (View, error) {
	sessionID, err := service.ids.NewID()
	if err != nil {
		return View{}, err
	}
	token, err := service.tokens.NewToken(tokenBytes)
	if err != nil {
		return View{}, err
	}
	csrf, err := service.tokens.NewToken(tokenBytes)
	if err != nil {
		return View{}, err
	}
	now := service.clock.Now().UTC()
	material := sessionMaterial{
		id: sessionID, token: token, csrf: csrf,
		tokenHash: keyedHash(service.settings.SessionHashKey, token),
		csrfHash:  keyedHash(service.settings.CSRFHashKey, csrf),
		now:       now, idleExpiresAt: now.Add(service.settings.IdleTTL), absoluteExpiresAt: now.Add(service.settings.AbsoluteTTL),
	}
	result, err := operation(material)
	if err != nil {
		return View{}, err
	}
	return View{
		UserID: result.UserID, GoogleConnected: true,
		GoogleEmail:  result.GoogleEmail,
		SessionToken: token, CSRFToken: csrf,
	}, nil
}

func keyedHash(key []byte, value string) []byte {
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write([]byte(value))
	return hash.Sum(nil)
}
