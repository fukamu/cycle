package postgres

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

func TestSessionRepositoryFindByTokenHashEnforcesValidity(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertSessionRepositoryUser(t, pool, userID, now)

	valid := sessionRepositoryFixture{
		id: "20000000-0000-7000-8000-000000000001", userID: userID,
		tokenHash: []byte("valid-token"), csrfHash: []byte("valid-csrf"),
		lastSeenAt: now.Add(-5 * time.Minute), idleExpiresAt: now.Add(time.Hour),
		absoluteExpiresAt: now.Add(24 * time.Hour),
	}
	insertSessionRepositorySession(t, pool, valid)

	revokedAt := now.Add(-time.Minute)
	invalid := []struct {
		name    string
		fixture sessionRepositoryFixture
	}{
		{
			name: "idle expiry boundary",
			fixture: sessionRepositoryFixture{
				id: "20000000-0000-7000-8000-000000000002", userID: userID,
				tokenHash: []byte("idle-expired-token"), csrfHash: []byte("idle-expired-csrf"),
				lastSeenAt: now.Add(-time.Hour), idleExpiresAt: now,
				absoluteExpiresAt: now.Add(24 * time.Hour),
			},
		},
		{
			name: "absolute expiry boundary",
			fixture: sessionRepositoryFixture{
				id: "20000000-0000-7000-8000-000000000003", userID: userID,
				tokenHash: []byte("absolute-expired-token"), csrfHash: []byte("absolute-expired-csrf"),
				lastSeenAt: now.Add(-time.Hour), idleExpiresAt: now.Add(time.Hour),
				absoluteExpiresAt: now,
			},
		},
		{
			name: "revoked",
			fixture: sessionRepositoryFixture{
				id: "20000000-0000-7000-8000-000000000004", userID: userID,
				tokenHash: []byte("revoked-token"), csrfHash: []byte("revoked-csrf"),
				lastSeenAt: now.Add(-time.Hour), idleExpiresAt: now.Add(time.Hour),
				absoluteExpiresAt: now.Add(24 * time.Hour), revokedAt: &revokedAt,
			},
		},
	}
	for _, test := range invalid {
		insertSessionRepositorySession(t, pool, test.fixture)
	}

	record, err := NewSessionRepository(pool).FindByTokenHash(context.Background(), valid.tokenHash, now)
	if err != nil {
		t.Fatal(err)
	}
	if record.ID != valid.id || record.UserID != user.ID(userID) ||
		!bytes.Equal(record.CSRFTokenHash, valid.csrfHash) ||
		!record.LastSeenAt.Equal(valid.lastSeenAt) ||
		!record.IdleExpiresAt.Equal(valid.idleExpiresAt) ||
		!record.AbsoluteExpiresAt.Equal(valid.absoluteExpiresAt) ||
		record.GoogleConnected || record.GoogleEmail != nil {
		t.Fatalf("valid session = %#v", record)
	}

	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			record, err := NewSessionRepository(pool).FindByTokenHash(context.Background(), test.fixture.tokenHash, now)
			if !errors.Is(err, appsession.ErrSessionExpired) || !reflect.DeepEqual(record, appsession.AuthenticatedSession{}) {
				t.Fatalf("FindByTokenHash() = %#v, %v; want zero record, %v", record, err, appsession.ErrSessionExpired)
			}
		})
	}
}

func TestSessionRepositoryFindByTokenHashRejectsInfiniteTimestamp(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000005"
	insertSessionRepositoryUser(t, pool, userID, now)

	finiteLastSeen := timestamptz(now)
	finiteIdle := timestamptz(now.Add(time.Hour))
	finiteAbsolute := timestamptz(now.Add(24 * time.Hour))
	infinite := pgtype.Timestamptz{Valid: true, InfinityModifier: pgtype.Infinity}
	tests := []struct {
		name, sessionID                       string
		lastSeenAt, idleExpiresAt, absoluteAt pgtype.Timestamptz
	}{
		{"last seen", "20000000-0000-7000-8000-000000000005", infinite, finiteIdle, finiteAbsolute},
		{"idle expiry", "20000000-0000-7000-8000-000000000006", finiteLastSeen, infinite, finiteAbsolute},
		{"absolute expiry", "20000000-0000-7000-8000-000000000007", finiteLastSeen, finiteIdle, infinite},
	}
	for _, test := range tests {
		tokenHash := []byte("infinite-session-" + test.name)
		if _, err := pool.Exec(context.Background(), `INSERT INTO sessions
(id,user_id,token_hash,csrf_token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, test.sessionID, userID, tokenHash,
			[]byte("infinite-session-csrf"), now, test.lastSeenAt, test.idleExpiresAt, test.absoluteAt,
		); err != nil {
			t.Fatal(err)
		}
		record, err := NewSessionRepository(pool).FindByTokenHash(context.Background(), tokenHash, now)
		if !errors.Is(err, errSessionPersistenceInvariant) ||
			!reflect.DeepEqual(record, appsession.AuthenticatedSession{}) {
			t.Fatalf(
				"FindByTokenHash(%s) = %#v, %v; want zero record and persistence invariant",
				test.name,
				record,
				err,
			)
		}
	}
}

func TestSessionRepositoryFindByTokenHashMapsVerifiedGoogleEmail(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	tests := []struct {
		name          string
		userID        string
		sessionID     string
		identityID    string
		tokenHash     []byte
		subject       string
		emailVerified bool
		wantEmail     *string
	}{
		{
			name: "verified", userID: "10000000-0000-7000-8000-000000000011",
			sessionID: "20000000-0000-7000-8000-000000000011", identityID: "30000000-0000-7000-8000-000000000011",
			tokenHash: []byte("verified-token"), subject: "verified-subject", emailVerified: true,
			wantEmail: sessionRepositoryStringPointer("verified@example.com"),
		},
		{
			name: "unverified", userID: "10000000-0000-7000-8000-000000000012",
			sessionID: "20000000-0000-7000-8000-000000000012", identityID: "30000000-0000-7000-8000-000000000012",
			tokenHash: []byte("unverified-token"), subject: "unverified-subject", emailVerified: false,
			wantEmail: nil,
		},
	}

	for _, test := range tests {
		insertSessionRepositoryUser(t, pool, test.userID, now)
		insertSessionRepositorySession(t, pool, sessionRepositoryFixture{
			id: test.sessionID, userID: test.userID, tokenHash: test.tokenHash,
			csrfHash: []byte(test.name + "-csrf"), lastSeenAt: now,
			idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(24 * time.Hour),
		})
		if _, err := pool.Exec(context.Background(), `INSERT INTO auth_identities
(id,user_id,provider,provider_subject,email_at_link,email_verified_at_link,created_at)
VALUES($1,$2,'google',$3,$4,$5,$6)`, test.identityID, test.userID, test.subject,
			test.name+"@example.com", test.emailVerified, now); err != nil {
			t.Fatal(err)
		}
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record, err := NewSessionRepository(pool).FindByTokenHash(context.Background(), test.tokenHash, now)
			if err != nil {
				t.Fatal(err)
			}
			if !record.GoogleConnected {
				t.Fatalf("GoogleConnected = false, want true")
			}
			if test.wantEmail == nil {
				if record.GoogleEmail != nil {
					t.Fatalf("GoogleEmail = %q, want nil", *record.GoogleEmail)
				}
			} else if record.GoogleEmail == nil || *record.GoogleEmail != *test.wantEmail {
				t.Fatalf("GoogleEmail = %v, want %q", record.GoogleEmail, *test.wantEmail)
			}
		})
	}
}

func TestSessionRepositoryRotateCSRFRequiresExactlyOneActiveSession(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000021"
	insertSessionRepositoryUser(t, pool, userID, now)

	active := sessionRepositoryFixture{
		id: "20000000-0000-7000-8000-000000000021", userID: userID,
		tokenHash: []byte("rotate-active-token"), csrfHash: []byte("rotate-active-old-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(24 * time.Hour),
	}
	control := sessionRepositoryFixture{
		id: "20000000-0000-7000-8000-000000000022", userID: userID,
		tokenHash: []byte("rotate-control-token"), csrfHash: []byte("rotate-control-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(24 * time.Hour),
	}
	revokedAt := now.Add(-time.Minute)
	invalid := []sessionRepositoryFixture{
		{
			id: "20000000-0000-7000-8000-000000000023", userID: userID,
			tokenHash: []byte("rotate-idle-expired-token"), csrfHash: []byte("rotate-idle-expired-csrf"),
			lastSeenAt: now.Add(-time.Hour), idleExpiresAt: now, absoluteExpiresAt: now.Add(24 * time.Hour),
		},
		{
			id: "20000000-0000-7000-8000-000000000024", userID: userID,
			tokenHash: []byte("rotate-absolute-expired-token"), csrfHash: []byte("rotate-absolute-expired-csrf"),
			lastSeenAt: now.Add(-time.Hour), idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now,
		},
		{
			id: "20000000-0000-7000-8000-000000000025", userID: userID,
			tokenHash: []byte("rotate-revoked-token"), csrfHash: []byte("rotate-revoked-csrf"),
			lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(24 * time.Hour), revokedAt: &revokedAt,
		},
	}
	insertSessionRepositorySession(t, pool, active)
	insertSessionRepositorySession(t, pool, control)
	for _, fixture := range invalid {
		insertSessionRepositorySession(t, pool, fixture)
	}

	newHash := []byte("rotate-active-new-csrf")
	repository := NewSessionRepository(pool)
	if err := repository.RotateCSRF(context.Background(), active.id, newHash, now); err != nil {
		t.Fatal(err)
	}
	assertSessionRepositoryCSRFHash(t, pool, active.id, newHash)
	assertSessionRepositoryCSRFHash(t, pool, control.id, control.csrfHash)

	for _, fixture := range invalid {
		err := repository.RotateCSRF(context.Background(), fixture.id, []byte("must-not-be-written"), now)
		if !errors.Is(err, appsession.ErrSessionExpired) {
			t.Fatalf("RotateCSRF(%s) error = %v, want %v", fixture.id, err, appsession.ErrSessionExpired)
		}
		assertSessionRepositoryCSRFHash(t, pool, fixture.id, fixture.csrfHash)
	}
	missingID := "20000000-0000-7000-8000-000000000026"
	if err := repository.RotateCSRF(context.Background(), missingID, []byte("missing"), now); !errors.Is(err, appsession.ErrSessionExpired) {
		t.Fatalf("RotateCSRF(missing) error = %v, want %v", err, appsession.ErrSessionExpired)
	}
}

func TestSessionRepositoryTouchUpdatesSessionAndUserMonotonically(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000031"
	insertSessionRepositoryUser(t, pool, userID, now)
	fixture := sessionRepositoryFixture{
		id: "20000000-0000-7000-8000-000000000031", userID: userID,
		tokenHash: []byte("touch-monotonic-token"), csrfHash: []byte("touch-monotonic-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(2 * time.Hour),
	}
	insertSessionRepositorySession(t, pool, fixture)
	repository := NewSessionRepository(pool)
	newerTouchAt := now.Add(30 * time.Minute)
	if err := repository.Touch(context.Background(), fixture.id, newerTouchAt, now.Add(3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	assertSessionRepositoryActivityTimes(t, pool, fixture.id, userID, sessionRepositoryActivityTimes{
		lastSeenAt: newerTouchAt, idleExpiresAt: fixture.absoluteExpiresAt,
		lastActiveAt: newerTouchAt, userUpdatedAt: newerTouchAt,
	})

	if _, err := pool.Exec(context.Background(), `UPDATE users
SET last_active_at=$2, updated_at=$2
WHERE id=$1`, userID, now); err != nil {
		t.Fatal(err)
	}
	if err := repository.Touch(context.Background(), fixture.id, now.Add(10*time.Minute), now.Add(90*time.Minute)); err != nil {
		t.Fatal(err)
	}
	assertSessionRepositoryActivityTimes(t, pool, fixture.id, userID, sessionRepositoryActivityTimes{
		lastSeenAt: newerTouchAt, idleExpiresAt: fixture.absoluteExpiresAt,
		lastActiveAt: newerTouchAt, userUpdatedAt: newerTouchAt,
	})
}

func TestSessionRepositoryTouchUsesUncappedIdleProposal(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000035"
		sessionID = "20000000-0000-7000-8000-000000000035"
	)
	insertSessionRepositoryUser(t, pool, userID, now)
	insertSessionRepositorySession(t, pool, sessionRepositoryFixture{
		id: sessionID, userID: userID,
		tokenHash: []byte("touch-uncapped-token"), csrfHash: []byte("touch-uncapped-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(4 * time.Hour),
	})
	touchedAt := now.Add(30 * time.Minute)
	idleExpiresAt := now.Add(90 * time.Minute)
	if err := NewSessionRepository(pool).Touch(context.Background(), sessionID, touchedAt, idleExpiresAt); err != nil {
		t.Fatal(err)
	}
	assertSessionRepositoryActivityTimes(t, pool, sessionID, userID, sessionRepositoryActivityTimes{
		lastSeenAt: touchedAt, idleExpiresAt: idleExpiresAt,
		lastActiveAt: touchedAt, userUpdatedAt: touchedAt,
	})
}

func TestSessionRepositoryTouchDoesNotMutateRevokedOrMissingSessionOwner(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000032"
		sessionID = "20000000-0000-7000-8000-000000000032"
		missingID = "20000000-0000-7000-8000-000000000033"
	)
	insertSessionRepositoryUser(t, pool, userID, now)
	revokedAt := now.Add(-time.Minute)
	fixture := sessionRepositoryFixture{
		id: sessionID, userID: userID,
		tokenHash: []byte("touch-revoked-token"), csrfHash: []byte("touch-revoked-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(4 * time.Hour),
		revokedAt: &revokedAt,
	}
	insertSessionRepositorySession(t, pool, fixture)

	repository := NewSessionRepository(pool)
	for _, id := range []string{sessionID, missingID} {
		if err := repository.Touch(context.Background(), id, now.Add(30*time.Minute), now.Add(2*time.Hour)); err != nil {
			t.Fatalf("Touch(%s) error = %v", id, err)
		}
	}
	assertSessionRepositoryActivityTimes(t, pool, sessionID, userID, sessionRepositoryActivityTimes{
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), lastActiveAt: now, userUpdatedAt: now,
	})
}

func TestSessionRepositoryTouchRollsBackSessionWhenUserUpdateFails(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000034"
		sessionID = "20000000-0000-7000-8000-000000000034"
	)
	insertSessionRepositoryUser(t, pool, userID, now)
	fixture := sessionRepositoryFixture{
		id: sessionID, userID: userID,
		tokenHash: []byte("touch-atomic-token"), csrfHash: []byte("touch-atomic-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(4 * time.Hour),
	}
	insertSessionRepositorySession(t, pool, fixture)
	if _, err := pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS reject_session_activity_user_update ON users`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `CREATE OR REPLACE FUNCTION reject_session_activity_user_update()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reject activity update'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `CREATE TRIGGER reject_session_activity_user_update
BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION reject_session_activity_user_update()`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS reject_session_activity_user_update ON users`)
		_, _ = pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS reject_session_activity_user_update()`)
	})

	err := NewSessionRepository(pool).Touch(context.Background(), sessionID, now.Add(30*time.Minute), now.Add(2*time.Hour))
	if err == nil {
		t.Fatal("Touch() succeeded despite rejecting the User update")
	}
	assertSessionRepositoryActivityTimes(t, pool, sessionID, userID, sessionRepositoryActivityTimes{
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), lastActiveAt: now, userUpdatedAt: now,
	})
}

func TestSessionRepositoryResumesLiveAnonymousBootstrap(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		existingUserID  = "10000000-0000-7000-8000-000000000041"
		candidateUserID = "10000000-0000-7000-8000-000000000042"
		sessionID       = "20000000-0000-7000-8000-000000000041"
	)
	bootstrapHash := []byte("live-bootstrap")
	originalExpiry := now.Add(10 * time.Minute)
	insertSessionRepositoryUser(t, pool, existingUserID, now)
	if _, err := pool.Exec(context.Background(), `INSERT INTO anonymous_bootstraps(key_hash,user_id,expires_at,created_at)
VALUES($1,$2,$3,$4)`, bootstrapHash, existingUserID, originalExpiry, now); err != nil {
		t.Fatal(err)
	}
	input := sessionRepositoryAnonymousInput(bootstrapHash, candidateUserID, sessionID, now)

	record, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if record.UserID != user.ID(existingUserID) || record.Created {
		t.Fatalf("anonymous record = %#v, want existing User and Created=false", record)
	}

	var sessionUserID, bootstrapUserID string
	var bootstrapExpiry time.Time
	var candidateUsers int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT user_id::text FROM sessions WHERE id=$1),
(SELECT user_id::text FROM anonymous_bootstraps WHERE key_hash=$2),
(SELECT expires_at FROM anonymous_bootstraps WHERE key_hash=$2),
(SELECT count(*) FROM users WHERE id=$3)`, sessionID, bootstrapHash, candidateUserID).Scan(
		&sessionUserID, &bootstrapUserID, &bootstrapExpiry, &candidateUsers,
	); err != nil {
		t.Fatal(err)
	}
	if sessionUserID != existingUserID || bootstrapUserID != existingUserID ||
		!bootstrapExpiry.Equal(originalExpiry) || candidateUsers != 0 {
		t.Fatalf("resume state = session User %s, bootstrap User %s/expiry %s, candidate count %d",
			sessionUserID, bootstrapUserID, bootstrapExpiry, candidateUsers)
	}
}

func TestSessionRepositoryReplacesExpiredAnonymousBootstrap(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		existingUserID  = "10000000-0000-7000-8000-000000000051"
		candidateUserID = "10000000-0000-7000-8000-000000000052"
		sessionID       = "20000000-0000-7000-8000-000000000051"
	)
	bootstrapHash := []byte("expired-bootstrap")
	insertSessionRepositoryUser(t, pool, existingUserID, now)
	if _, err := pool.Exec(context.Background(), `INSERT INTO anonymous_bootstraps(key_hash,user_id,expires_at,created_at)
VALUES($1,$2,$3,$4)`, bootstrapHash, existingUserID, now, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	input := sessionRepositoryAnonymousInput(bootstrapHash, candidateUserID, sessionID, now)

	record, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if record.UserID != user.ID(candidateUserID) || !record.Created {
		t.Fatalf("anonymous record = %#v, want candidate User and Created=true", record)
	}

	var sessionUserID, bootstrapUserID string
	var bootstrapExpiry time.Time
	var existingUsers, candidateUsers int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT user_id::text FROM sessions WHERE id=$1),
(SELECT user_id::text FROM anonymous_bootstraps WHERE key_hash=$2),
(SELECT expires_at FROM anonymous_bootstraps WHERE key_hash=$2),
(SELECT count(*) FROM users WHERE id=$3),
(SELECT count(*) FROM users WHERE id=$4)`, sessionID, bootstrapHash, existingUserID, candidateUserID).Scan(
		&sessionUserID, &bootstrapUserID, &bootstrapExpiry, &existingUsers, &candidateUsers,
	); err != nil {
		t.Fatal(err)
	}
	if sessionUserID != candidateUserID || bootstrapUserID != candidateUserID ||
		!bootstrapExpiry.Equal(input.BootstrapExpires) || existingUsers != 1 || candidateUsers != 1 {
		t.Fatalf("replacement state = session User %s, bootstrap User %s/expiry %s, user counts %d/%d",
			sessionUserID, bootstrapUserID, bootstrapExpiry, existingUsers, candidateUsers)
	}
}

func TestSessionRepositoryRejectsInfiniteAnonymousBootstrapWithoutMutation(t *testing.T) {
	pool := integrationPool(t)
	now := integrationNow()
	const (
		existingUserID  = "10000000-0000-7000-8000-000000000061"
		candidateUserID = "10000000-0000-7000-8000-000000000062"
		sessionID       = "20000000-0000-7000-8000-000000000061"
	)
	for _, infinity := range []string{"infinity", "-infinity"} {
		t.Run(infinity, func(t *testing.T) {
			resetDatabase(t, pool)
			bootstrapHash := []byte("infinite-bootstrap-" + infinity)
			insertSessionRepositoryUser(t, pool, existingUserID, now)
			if _, err := pool.Exec(context.Background(), `INSERT INTO anonymous_bootstraps
(key_hash,user_id,expires_at,created_at) VALUES($1,$2,$3::timestamptz,$4)`,
				bootstrapHash, existingUserID, infinity, now,
			); err != nil {
				t.Fatal(err)
			}
			input := sessionRepositoryAnonymousInput(bootstrapHash, candidateUserID, sessionID, now)
			record, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), input)
			if !errors.Is(err, errSessionPersistenceInvariant) || !reflect.DeepEqual(record, appsession.AnonymousRecord{}) {
				t.Fatalf("CreateOrResumeAnonymous() = %#v, %v; want zero record and persistence invariant", record, err)
			}
			var bootstrapUserID, bootstrapExpiry string
			var candidateUsers, sessions int
			if err := pool.QueryRow(context.Background(), `SELECT
(SELECT user_id::text FROM anonymous_bootstraps WHERE key_hash=$1),
(SELECT expires_at::text FROM anonymous_bootstraps WHERE key_hash=$1),
(SELECT count(*) FROM users WHERE id=$2),
(SELECT count(*) FROM sessions WHERE id=$3)`, bootstrapHash, candidateUserID, sessionID).Scan(
				&bootstrapUserID, &bootstrapExpiry, &candidateUsers, &sessions,
			); err != nil {
				t.Fatal(err)
			}
			if bootstrapUserID != existingUserID || bootstrapExpiry != infinity || candidateUsers != 0 || sessions != 0 {
				t.Fatalf(
					"state = bootstrap %s/%s, candidate users %d, sessions %d",
					bootstrapUserID,
					bootstrapExpiry,
					candidateUsers,
					sessions,
				)
			}
		})
	}
}

type sessionRepositoryFixture struct {
	id                string
	userID            string
	tokenHash         []byte
	csrfHash          []byte
	lastSeenAt        time.Time
	idleExpiresAt     time.Time
	absoluteExpiresAt time.Time
	revokedAt         *time.Time
}

type sessionRepositoryActivityTimes struct {
	lastSeenAt    time.Time
	idleExpiresAt time.Time
	lastActiveAt  time.Time
	userUpdatedAt time.Time
}

func insertSessionRepositoryUser(t *testing.T, pool *pgxpool.Pool, userID string, now time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
}

func insertSessionRepositorySession(t *testing.T, pool *pgxpool.Pool, fixture sessionRepositoryFixture) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO sessions
(id,user_id,token_hash,csrf_token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, fixture.id, fixture.userID, fixture.tokenHash, fixture.csrfHash,
		fixture.lastSeenAt, fixture.lastSeenAt, fixture.idleExpiresAt, fixture.absoluteExpiresAt, fixture.revokedAt); err != nil {
		t.Fatal(err)
	}
}

func assertSessionRepositoryActivityTimes(
	t *testing.T,
	pool *pgxpool.Pool,
	sessionID string,
	userID string,
	want sessionRepositoryActivityTimes,
) {
	t.Helper()
	var got sessionRepositoryActivityTimes
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT last_seen_at FROM sessions WHERE id=$1),
(SELECT idle_expires_at FROM sessions WHERE id=$1),
(SELECT last_active_at FROM users WHERE id=$2),
(SELECT updated_at FROM users WHERE id=$2)`, sessionID, userID).Scan(
		&got.lastSeenAt,
		&got.idleExpiresAt,
		&got.lastActiveAt,
		&got.userUpdatedAt,
	); err != nil {
		t.Fatal(err)
	}
	if !got.lastSeenAt.Equal(want.lastSeenAt) ||
		!got.idleExpiresAt.Equal(want.idleExpiresAt) ||
		!got.lastActiveAt.Equal(want.lastActiveAt) ||
		!got.userUpdatedAt.Equal(want.userUpdatedAt) {
		t.Fatalf("activity times = %#v, want %#v", got, want)
	}
}

func assertSessionRepositoryCSRFHash(t *testing.T, pool *pgxpool.Pool, sessionID string, want []byte) {
	t.Helper()
	var got []byte
	if err := pool.QueryRow(context.Background(), `SELECT csrf_token_hash FROM sessions WHERE id=$1`, sessionID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("session %s CSRF hash = %q, want %q", sessionID, got, want)
	}
}

func sessionRepositoryAnonymousInput(bootstrapHash []byte, userID, sessionID string, now time.Time) appsession.CreateAnonymousRecord {
	return appsession.CreateAnonymousRecord{
		BootstrapKeyHash: bootstrapHash, BootstrapExpires: now.Add(20 * time.Minute), UserID: user.ID(userID),
		SessionID: sessionID, SessionTokenHash: []byte("anonymous-session-token"), CSRFTokenHash: []byte("anonymous-csrf"),
		Now: now, IdleExpiresAt: now.Add(30 * 24 * time.Hour), AbsoluteExpiresAt: now.Add(180 * 24 * time.Hour),
	}
}

func sessionRepositoryStringPointer(value string) *string {
	return &value
}
