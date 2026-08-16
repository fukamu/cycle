package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

func TestGoogleUpgradePreservesApplicationUserAndRotatesSession(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	record := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	email := "user@example.com"
	verified := true
	result, err := NewAccountRepository(pool).UpgradeGoogle(context.Background(), account.UpgradeRecord{
		CurrentUserID: record.UserID, CurrentSessionID: record.SessionID,
		IdentityID: uuid(10), Identity: account.GoogleIdentity{Subject: "google-subject", Email: &email, EmailVerified: &verified},
		NewSessionID: uuid(11), SessionTokenHash: []byte("new-session"), CSRFTokenHash: []byte("new-csrf"),
		Now: integrationNow(), IdleExpiresAt: integrationNow().Add(30 * 24 * time.Hour), AbsoluteExpiresAt: integrationNow().Add(180 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.UserID != record.UserID || result.ActiveCycleID != record.CycleID {
		t.Fatalf("upgrade result = %#v", result)
	}
	var identityUser string
	if err := pool.QueryRow(context.Background(), `SELECT user_id::text FROM auth_identities WHERE provider_subject='google-subject'`).Scan(&identityUser); err != nil || identityUser != string(record.UserID) {
		t.Fatalf("identity/error = %s/%v", identityUser, err)
	}
	var bootstraps, liveOld, liveNew int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM anonymous_bootstraps WHERE user_id=$1`, string(record.UserID)).Scan(&bootstraps)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1 AND revoked_at IS NULL`, record.SessionID).Scan(&liveOld)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1 AND revoked_at IS NULL`, uuid(11)).Scan(&liveNew)
	if bootstraps != 0 || liveOld != 0 || liveNew != 1 {
		t.Fatalf("bootstrap/old/new = %d/%d/%d", bootstraps, liveOld, liveNew)
	}
}

func TestGoogleIdentityCollisionRollsBackAnonymousUpgrade(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	first := anonymousInput(1, 2, 3, 1)
	second := anonymousInput(4, 5, 6, 2)
	sessions := NewSessionRepository(pool)
	if _, err := sessions.CreateOrResumeAnonymous(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.CreateOrResumeAnonymous(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	repository := NewAccountRepository(pool)
	upgrade := func(record appsession.CreateAnonymousRecord, identityID, sessionID int) error {
		_, err := repository.UpgradeGoogle(context.Background(), account.UpgradeRecord{
			CurrentUserID: record.UserID, CurrentSessionID: record.SessionID,
			IdentityID: uuid(identityID), Identity: account.GoogleIdentity{Subject: "same-google-subject"},
			NewSessionID: uuid(sessionID), SessionTokenHash: []byte{byte(sessionID)}, CSRFTokenHash: []byte{byte(sessionID), 2},
			Now: integrationNow(), IdleExpiresAt: integrationNow().Add(time.Hour), AbsoluteExpiresAt: integrationNow().Add(2 * time.Hour),
		})
		return err
	}
	if err := upgrade(first, 10, 11); err != nil {
		t.Fatal(err)
	}
	if err := upgrade(second, 12, 13); !errors.Is(err, account.ErrGoogleIdentityLinked) {
		t.Fatalf("collision error = %v", err)
	}
	var bootstrap, liveSession int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM anonymous_bootstraps WHERE user_id=$1`, string(second.UserID)).Scan(&bootstrap)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1 AND revoked_at IS NULL`, second.SessionID).Scan(&liveSession)
	if bootstrap != 1 || liveSession != 1 {
		t.Fatalf("second user changed after rollback: bootstrap/session = %d/%d", bootstrap, liveSession)
	}
}

func TestGoogleLoginSwitchesSessionWithoutMergingAnonymousUser(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	target := anonymousInput(1, 2, 3, 1)
	current := anonymousInput(4, 5, 6, 2)
	sessions := NewSessionRepository(pool)
	for _, input := range []appsession.CreateAnonymousRecord{target, current} {
		if _, err := sessions.CreateOrResumeAnonymous(context.Background(), input); err != nil {
			t.Fatal(err)
		}
	}
	repository := NewAccountRepository(pool)
	if _, err := repository.UpgradeGoogle(context.Background(), account.UpgradeRecord{
		CurrentUserID: target.UserID, CurrentSessionID: target.SessionID,
		IdentityID: uuid(10), Identity: account.GoogleIdentity{Subject: "login-subject"}, NewSessionID: uuid(11),
		SessionTokenHash: []byte("target-token"), CSRFTokenHash: []byte("target-csrf"),
		Now: integrationNow(), IdleExpiresAt: integrationNow().Add(time.Hour), AbsoluteExpiresAt: integrationNow().Add(2 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	result, err := repository.LoginGoogle(context.Background(), account.LoginRecord{
		CurrentSessionID: current.SessionID, Identity: account.GoogleIdentity{Subject: "login-subject"},
		NewSessionID: uuid(12), SessionTokenHash: []byte("login-token"), CSRFTokenHash: []byte("login-csrf"),
		Now: integrationNow().Add(time.Minute), IdleExpiresAt: integrationNow().Add(2 * time.Hour), AbsoluteExpiresAt: integrationNow().Add(3 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.UserID != target.UserID || result.ActiveCycleID != target.CycleID {
		t.Fatalf("login result = %#v", result)
	}
	var users, currentCycles, oldSession, targetSession int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&users)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM pdca_cycles WHERE user_id=$1`, string(current.UserID)).Scan(&currentCycles)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1 AND revoked_at IS NULL`, current.SessionID).Scan(&oldSession)
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, uuid(12), string(target.UserID)).Scan(&targetSession)
	if users != 2 || currentCycles != 1 || oldSession != 0 || targetSession != 1 {
		t.Fatalf("users/current cycles/old/new = %d/%d/%d/%d", users, currentCycles, oldSession, targetSession)
	}
}

func TestAccountDeleteCascadesPersonalDataAndReleasesAIRunningReservation(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	record := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='p',do_text='d',check_text='c' WHERE id=$1`, record.CycleID); err != nil {
		t.Fatal(err)
	}
	start := integrationAIStart(record, 10, 11, 12, integrationNow())
	start.BudgetReservationUSD = 2
	if _, err := NewAIRepository(pool).Start(context.Background(), start); err != nil {
		t.Fatal(err)
	}
	if err := NewAccountRepository(pool).DeleteAccount(context.Background(), record.UserID, integrationNow().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"users", "sessions", "pdca_cycles", "ai_generations", "ai_usage_events", "anonymous_bootstraps"} {
		var count int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM `+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count/error = %d/%v", table, count, err)
		}
	}
	var reserved float64
	if err := pool.QueryRow(context.Background(), `SELECT reserved_cost_usd FROM ai_budget_monthly`).Scan(&reserved); err != nil || reserved != 0 {
		t.Fatalf("aggregate budget/error = %f/%v", reserved, err)
	}
	_, err := NewAIRepository(pool).Succeed(context.Background(), appai.SuccessInput{
		UserID: record.UserID, CycleID: domaincycle.ID(record.CycleID), GenerationID: start.GenerationID,
		GenerationRevision: 0, Action: "late result", AttemptCount: 1, Now: integrationNow().Add(2 * time.Second),
	})
	if !errors.Is(err, appai.ErrTargetGone) && !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("late AI error = %v", err)
	}
	var users int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&users)
	if users != 0 {
		t.Fatalf("late result recreated user: %d", users)
	}
}

func TestAccountDeleteFailureRollsBackAllPersonalData(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	record := anonymousInput(1, 2, 3, 1)
	if _, err := NewSessionRepository(pool).CreateOrResumeAnonymous(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='p',do_text='d',check_text='c' WHERE id=$1`, record.CycleID); err != nil {
		t.Fatal(err)
	}
	start := integrationAIStart(record, 10, 11, 12, integrationNow())
	start.BudgetReservationUSD = 2
	if _, err := NewAIRepository(pool).Start(context.Background(), start); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_budget_monthly SET reserved_cost_usd=1`); err != nil {
		t.Fatal(err)
	}
	if err := NewAccountRepository(pool).DeleteAccount(context.Background(), record.UserID, integrationNow().Add(time.Second)); err == nil {
		t.Fatal("expected budget invariant failure")
	}
	for _, table := range []string{"users", "sessions", "pdca_cycles", "ai_generations"} {
		var count int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM `+table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s count/error = %d/%v", table, count, err)
		}
	}
}
