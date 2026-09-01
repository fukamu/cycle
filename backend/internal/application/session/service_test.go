package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	"github.com/fukamu/cycle/backend/internal/securehash"
)

func TestCreateAnonymousHashesCredentialsAndReturnsPlainTokens(t *testing.T) {
	t.Parallel()

	repository := &fakeRepository{}
	service := testService(repository)
	view, err := service.CreateAnonymous(context.Background(), CreateAnonymousInput{
		BootstrapID: "0198c20b-7b95-7000-8000-000000000001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.UserID != "00000000-0000-7000-8000-000000000001" || view.SessionToken == "" || view.CSRFToken == "" ||
		!view.Created {
		t.Fatalf("view = %#v", view)
	}
	if string(repository.created.SessionTokenHash) == view.SessionToken || string(repository.created.CSRFTokenHash) == view.CSRFToken {
		t.Fatal("plain credential was passed to repository")
	}
	if repository.created.BootstrapExpires.Sub(repository.created.Now) != 10*time.Minute {
		t.Fatalf("bootstrap TTL = %v", repository.created.BootstrapExpires.Sub(repository.created.Now))
	}
}

func TestCreateAnonymousPropagatesRepositoryReplayWithoutChangingCredentials(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{replayed: true}
	service := testService(repository)
	view, err := service.CreateAnonymous(context.Background(), CreateAnonymousInput{
		BootstrapID: "0198c20b-7b95-7000-8000-000000000001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.Created || view.UserID != repository.replayUserID ||
		view.SessionToken == "" || view.CSRFToken == "" {
		t.Fatalf("replayed view = %#v", view)
	}
}

func TestCreateAnonymousRejectsInvalidBootstrapBeforeAbuseCheck(t *testing.T) {
	t.Parallel()

	for _, bootstrapID := range []string{"not-a-uuid", "123e4567-e89b-42d3-a456-426614174000"} {
		service := testService(&fakeRepository{})
		_, err := service.CreateAnonymous(context.Background(), CreateAnonymousInput{BootstrapID: bootstrapID})
		if !errors.Is(err, ErrBootstrapID) {
			t.Fatalf("bootstrap ID %q error = %v", bootstrapID, err)
		}
	}
}

func TestRefreshRotatesCSRFAndVerifyCSRF(t *testing.T) {
	t.Parallel()
	email := "person@example.com"

	repository := &fakeRepository{found: AuthenticatedSession{
		ID:              "00000000-0000-7000-8000-000000000009",
		UserID:          user.ID("00000000-0000-7000-8000-000000000001"),
		LastSeenAt:      testTime.Add(-time.Hour),
		CSRFTokenHash:   securehash.HMACSHA256([]byte("csrf-key"), []byte("token-2")),
		GoogleConnected: true,
		GoogleEmail:     &email,
	}}
	service := testService(repository)
	view, err := service.Refresh(context.Background(), "session-token")
	if err != nil {
		t.Fatal(err)
	}
	if view.CSRFToken != "token-1" || len(repository.rotatedHash) == 0 || !repository.touched {
		t.Fatalf("view/repository = %#v/%#v", view, repository)
	}
	if !view.GoogleConnected || view.GoogleEmail == nil || *view.GoogleEmail != email {
		t.Fatalf("Google identity view = %#v", view)
	}
	record := repository.found
	record.CSRFTokenHash = repository.rotatedHash
	if err := service.VerifyCSRF(record, view.CSRFToken); err != nil {
		t.Fatalf("VerifyCSRF() error = %v", err)
	}
	if err := service.VerifyCSRF(record, "wrong"); !errors.Is(err, ErrCSRFInvalid) {
		t.Fatalf("wrong CSRF error = %v", err)
	}
}

func TestAuthenticateCoalescesActivityTouchAtThreshold(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		lastSeenAt  time.Time
		wantTouch   bool
		wantTouchAt time.Time
		wantIdleAt  time.Time
	}{
		{
			name:       "immediately before threshold",
			lastSeenAt: testTime.Add(-15 * time.Minute).Add(time.Nanosecond),
			wantTouch:  false,
		},
		{
			name:        "exactly at threshold",
			lastSeenAt:  testTime.Add(-15 * time.Minute),
			wantTouch:   true,
			wantTouchAt: testTime,
			wantIdleAt:  testTime.Add(30 * 24 * time.Hour),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &fakeRepository{found: AuthenticatedSession{
				ID:         "00000000-0000-7000-8000-000000000009",
				UserID:     user.ID("00000000-0000-7000-8000-000000000001"),
				LastSeenAt: test.lastSeenAt,
			}}
			record, err := testService(repository).Authenticate(context.Background(), "session-token")
			if err != nil {
				t.Fatal(err)
			}
			if record.ID != repository.found.ID {
				t.Fatalf("Authenticate() record = %#v, want %#v", record, repository.found)
			}
			if repository.touchCalls != boolToInt(test.wantTouch) {
				t.Fatalf("Touch() calls = %d, want %d", repository.touchCalls, boolToInt(test.wantTouch))
			}
			if test.wantTouch && (!repository.touchAt.Equal(test.wantTouchAt) || !repository.touchIdleAt.Equal(test.wantIdleAt)) {
				t.Fatalf("Touch() times = %s/%s, want %s/%s",
					repository.touchAt, repository.touchIdleAt, test.wantTouchAt, test.wantIdleAt)
			}
		})
	}
}

func TestAuthenticateKeepsTouchBestEffort(t *testing.T) {
	t.Parallel()

	touchErr := errors.New("touch failed")
	repository := &fakeRepository{
		found: AuthenticatedSession{
			ID:         "00000000-0000-7000-8000-000000000009",
			UserID:     user.ID("00000000-0000-7000-8000-000000000001"),
			LastSeenAt: testTime.Add(-time.Hour),
		},
		touchErr: touchErr,
	}
	record, err := testService(repository).Authenticate(context.Background(), "session-token")
	if err != nil {
		t.Fatalf("Authenticate() error = %v, want nil despite %v", err, touchErr)
	}
	if record.ID != repository.found.ID || repository.touchCalls != 1 {
		t.Fatalf("Authenticate() record/calls = %#v/%d, want original record and one best-effort touch", record, repository.touchCalls)
	}
}

var testTime = time.Date(2026, time.August, 16, 0, 0, 0, 0, time.UTC)

func testService(repository Repository) *Service {
	return NewService(
		repository,
		fakeClock{},
		&fakeGenerator{},
		&fakeGenerator{},
		fakeAbuse{},
		Settings{
			SessionHashKey:     []byte("session-key"),
			CSRFHashKey:        []byte("csrf-key"),
			BootstrapHashKey:   []byte("bootstrap-key"),
			IdleTTL:            30 * 24 * time.Hour,
			AbsoluteTTL:        180 * 24 * time.Hour,
			ActivityTouchAfter: 15 * time.Minute,
			BootstrapTTL:       10 * time.Minute,
		},
	)
}

type fakeClock struct{}

func (fakeClock) Now() time.Time { return testTime }

type fakeGenerator struct{ next int }

func (generator *fakeGenerator) NewID() (string, error) {
	generator.next++
	return "00000000-0000-7000-8000-00000000000" + string(rune('0'+generator.next)), nil
}

func (generator *fakeGenerator) NewToken(int) (string, error) {
	generator.next++
	return "token-" + string(rune('0'+generator.next)), nil
}

type fakeAbuse struct{ err error }

func (abuse fakeAbuse) VerifyAnonymousCreation(context.Context, ports.AnonymousAbuseInput) error {
	return abuse.err
}

type fakeRepository struct {
	created      CreateAnonymousRecord
	found        AuthenticatedSession
	rotatedHash  []byte
	touched      bool
	touchCalls   int
	touchAt      time.Time
	touchIdleAt  time.Time
	touchErr     error
	replayed     bool
	replayUserID user.ID
}

func (repository *fakeRepository) FindByTokenHash(context.Context, []byte, time.Time) (AuthenticatedSession, error) {
	if repository.found.ID == "" {
		return AuthenticatedSession{}, errors.New("not found")
	}
	return repository.found, nil
}

func (repository *fakeRepository) RotateCSRF(_ context.Context, _ string, hash []byte, _ time.Time) error {
	repository.rotatedHash = hash
	return nil
}

func (repository *fakeRepository) Touch(_ context.Context, _ string, now time.Time, idleExpiresAt time.Time) error {
	repository.touched = true
	repository.touchCalls++
	repository.touchAt = now
	repository.touchIdleAt = idleExpiresAt
	return repository.touchErr
}

func (repository *fakeRepository) CreateOrResumeAnonymous(_ context.Context, input CreateAnonymousRecord) (AnonymousRecord, error) {
	repository.created = input
	if repository.replayed {
		if repository.replayUserID == "" {
			repository.replayUserID = user.ID("00000000-0000-7000-8000-000000000009")
		}
		return AnonymousRecord{UserID: repository.replayUserID, Created: false}, nil
	}
	return AnonymousRecord{UserID: input.UserID, Created: true}, nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
