package account

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

var accountTestTime = time.Date(2026, time.August, 16, 1, 2, 3, 0, time.UTC)

func TestUpgradeGoogleKeepsUserAndHashesRotatedCredentials(t *testing.T) {
	t.Parallel()
	repository := &fakeAccountRepository{result: AuthResult{
		UserID:        user.ID("00000000-0000-4000-8000-000000000001"),
		ActiveCycleID: "00000000-0000-4000-8000-000000000002",
	}}
	service := accountTestService(repository, fakeGoogleVerifier{identity: GoogleIdentity{Subject: "google-sub"}})
	view, err := service.UpgradeGoogle(context.Background(), repository.result.UserID, "old-session", "signed-token")
	if err != nil {
		t.Fatal(err)
	}
	if view.UserID != repository.result.UserID || !view.GoogleConnected || view.SessionToken == "" || view.CSRFToken == "" {
		t.Fatalf("view = %#v", view)
	}
	if repository.upgrade.Identity.Subject != "google-sub" || repository.upgrade.CurrentSessionID != "old-session" {
		t.Fatalf("upgrade = %#v", repository.upgrade)
	}
	if string(repository.upgrade.SessionTokenHash) == view.SessionToken || string(repository.upgrade.CSRFTokenHash) == view.CSRFToken {
		t.Fatal("plain session material reached the repository")
	}
}

func TestUpgradeCollisionRemainsStableAndDeleteNeedsConfirmation(t *testing.T) {
	t.Parallel()
	repository := &fakeAccountRepository{upgradeErr: ErrGoogleIdentityLinked}
	service := accountTestService(repository, fakeGoogleVerifier{identity: GoogleIdentity{Subject: "google-sub"}})
	_, err := service.UpgradeGoogle(context.Background(), user.ID("00000000-0000-4000-8000-000000000001"), "old", "token")
	if !errors.Is(err, ErrGoogleIdentityLinked) || errors.Is(err, ErrAccountUpgradeFailed) {
		t.Fatalf("collision error = %v", err)
	}
	if err := service.Delete(context.Background(), user.ID("00000000-0000-4000-8000-000000000001"), false); !errors.Is(err, ErrDeleteConfirmationRequired) {
		t.Fatalf("delete error = %v", err)
	}
	if repository.deleted {
		t.Fatal("repository delete called without confirmation")
	}
}

func TestGoogleVerificationFailureDoesNotCreateSession(t *testing.T) {
	t.Parallel()
	repository := &fakeAccountRepository{}
	service := accountTestService(repository, fakeGoogleVerifier{err: ErrGoogleTokenInvalid})
	_, err := service.LoginGoogle(context.Background(), "old", "bad")
	if !errors.Is(err, ErrGoogleTokenInvalid) {
		t.Fatalf("error = %v", err)
	}
	if repository.login.NewSessionID != "" {
		t.Fatal("login repository was called after failed verification")
	}
}

func accountTestService(repository Repository, verifier GoogleVerifier) *Service {
	return NewService(repository, verifier, accountFakeClock{}, &accountFakeGenerator{}, &accountFakeGenerator{}, Settings{
		SessionHashKey: []byte("session-key"), CSRFHashKey: []byte("csrf-key"),
		IdleTTL: 30 * 24 * time.Hour, AbsoluteTTL: 180 * 24 * time.Hour,
	})
}

type accountFakeClock struct{}

func (accountFakeClock) Now() time.Time { return accountTestTime }

type accountFakeGenerator struct{ next int }

func (generator *accountFakeGenerator) NewID() (string, error) {
	generator.next++
	return "00000000-0000-4000-8000-00000000000" + string(rune('0'+generator.next)), nil
}

func (generator *accountFakeGenerator) NewToken(int) (string, error) {
	generator.next++
	return "token-" + string(rune('0'+generator.next)), nil
}

type fakeGoogleVerifier struct {
	identity GoogleIdentity
	err      error
}

func (verifier fakeGoogleVerifier) Verify(context.Context, string) (GoogleIdentity, error) {
	return verifier.identity, verifier.err
}

type fakeAccountRepository struct {
	result     AuthResult
	upgrade    UpgradeRecord
	login      LoginRecord
	upgradeErr error
	loginErr   error
	deleteErr  error
	deleted    bool
}

func (repository *fakeAccountRepository) UpgradeGoogle(_ context.Context, input UpgradeRecord) (AuthResult, error) {
	repository.upgrade = input
	return repository.result, repository.upgradeErr
}

func (repository *fakeAccountRepository) LoginGoogle(_ context.Context, input LoginRecord) (AuthResult, error) {
	repository.login = input
	return repository.result, repository.loginErr
}

func (repository *fakeAccountRepository) DeleteAccount(context.Context, user.ID, time.Time) error {
	repository.deleted = true
	return repository.deleteErr
}
