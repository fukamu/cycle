package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/account"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type loginDeleteCommandContextKey struct{}

type loginDeleteQueryContextKey struct{}

type loginDeleteCommand uint8

const loginAfterSourceDelete loginDeleteCommand = iota + 1

type loginDeleteQuery struct {
	pid uint32
}

type loginDeleteObservation struct {
	rowsAffected int64
	err          error
}

type loginDeleteBarrier struct {
	loginAtRevoke chan uint32
	releaseLogin  chan struct{}
	revokeEnd     chan loginDeleteObservation

	loginOnce   sync.Once
	releaseOnce sync.Once
}

func newLoginDeleteBarrier() *loginDeleteBarrier {
	return &loginDeleteBarrier{
		loginAtRevoke: make(chan uint32, 1),
		releaseLogin:  make(chan struct{}),
		revokeEnd:     make(chan loginDeleteObservation, 1),
	}
}

func (barrier *loginDeleteBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if ctx.Value(loginDeleteCommandContextKey{}) != loginAfterSourceDelete || !isSessionRevokeQuery(data.SQL) {
		return ctx
	}
	query := loginDeleteQuery{pid: connection.PgConn().PID()}
	barrier.loginOnce.Do(func() { barrier.loginAtRevoke <- query.pid })
	select {
	case <-barrier.releaseLogin:
	case <-ctx.Done():
	}
	return context.WithValue(ctx, loginDeleteQueryContextKey{}, query)
}

func (barrier *loginDeleteBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if _, ok := ctx.Value(loginDeleteQueryContextKey{}).(loginDeleteQuery); !ok {
		return
	}
	barrier.revokeEnd <- loginDeleteObservation{rowsAffected: data.CommandTag.RowsAffected(), err: data.Err}
}

func (barrier *loginDeleteBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseLogin) })
}

func isSessionRevokeQuery(sql string) bool {
	normalized := normalizeAccountSessionSQL(sql)
	return strings.Contains(normalized, "update sessions set revoked_at=") &&
		strings.Contains(normalized, "where id=$") &&
		strings.Contains(normalized, "revoked_at is null")
}

type loginGoogleCall struct {
	result account.AuthResult
	err    error
}

func TestAccountRepositoryLoginGoogleRollsBackWhenSourceAccountWasDeleted(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		sourceUserID  = "10000000-0000-7000-8000-000000000001"
		targetUserID  = "10000000-0000-7000-8000-000000000002"
		sourceSession = "20000000-0000-7000-8000-000000000001"
		newSessionID  = "20000000-0000-7000-8000-000000000002"
		identityID    = "30000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$3,$3,$3),($2,$3,$3,$3)`, sourceUserID, targetUserID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO auth_identities
(id,user_id,provider,provider_subject,email_at_link,email_verified_at_link,created_at)
VALUES($1,$2,'google','target-subject','target@example.test',true,$3)`, identityID, targetUserID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO sessions
(id,user_id,token_hash,csrf_token_hash,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
VALUES($1,$2,$3,$4,$5,$5,$6,$7)`, sourceSession, sourceUserID, []byte("source-token"), []byte("source-csrf"),
		now, now.Add(30*24*time.Hour), now.Add(180*24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	barrier := newLoginDeleteBarrier()
	tracedPool := newAccountSessionTracedPool(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	loginCalls := make(chan loginGoogleCall, 1)
	loginCtx := context.WithValue(ctx, loginDeleteCommandContextKey{}, loginAfterSourceDelete)
	go func() {
		result, err := NewAccountRepository(tracedPool).LoginGoogle(loginCtx, account.LoginRecord{
			CurrentSessionID:  sourceSession,
			Identity:          account.GoogleIdentity{Subject: "target-subject"},
			NewSessionID:      newSessionID,
			SessionTokenHash:  []byte("new-target-token"),
			CSRFTokenHash:     []byte("new-target-csrf"),
			Now:               now.Add(time.Minute),
			IdleExpiresAt:     now.Add(30 * 24 * time.Hour),
			AbsoluteExpiresAt: now.Add(180 * 24 * time.Hour),
		})
		loginCalls <- loginGoogleCall{result: result, err: err}
	}()

	select {
	case <-barrier.loginAtRevoke:
	case call := <-loginCalls:
		t.Fatalf("LoginGoogle returned before the revoke barrier: result=%#v error=%v", call.result, call.err)
	case <-ctx.Done():
		t.Fatalf("LoginGoogle did not reach the revoke barrier: %v", ctx.Err())
	}

	if err := NewAccountRepository(pool).DeleteAccount(ctx, user.ID(sourceUserID), now.Add(2*time.Minute)); err != nil {
		t.Fatalf("DeleteAccount(source) error = %v", err)
	}
	barrier.release()

	var call loginGoogleCall
	select {
	case call = <-loginCalls:
	case <-ctx.Done():
		t.Fatalf("LoginGoogle did not finish after release: %v", ctx.Err())
	}
	if !errors.Is(call.err, pgx.ErrNoRows) {
		t.Fatalf("LoginGoogle error = %v, want %v", call.err, pgx.ErrNoRows)
	}
	select {
	case observation := <-barrier.revokeEnd:
		if observation.err != nil || observation.rowsAffected != 0 {
			t.Fatalf("source revoke observation = %#v, want zero rows without query error", observation)
		}
	case <-ctx.Done():
		t.Fatalf("source revoke QueryEnd was not observed: %v", ctx.Err())
	}

	var sourceUsers, sourceSessions, targetUsers, targetIdentities, newSessions int
	if err := pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM sessions WHERE user_id=$1),
(SELECT count(*) FROM users WHERE id=$2),
(SELECT count(*) FROM auth_identities WHERE user_id=$2),
(SELECT count(*) FROM sessions WHERE id=$3)`, sourceUserID, targetUserID, newSessionID).Scan(
		&sourceUsers, &sourceSessions, &targetUsers, &targetIdentities, &newSessions,
	); err != nil {
		t.Fatal(err)
	}
	if sourceUsers != 0 || sourceSessions != 0 || targetUsers != 1 || targetIdentities != 1 || newSessions != 0 {
		t.Fatalf("post-race source users/sessions=%d/%d target users/identities=%d/%d new sessions=%d",
			sourceUsers, sourceSessions, targetUsers, targetIdentities, newSessions)
	}
}

type bootstrapDeleteCommandContextKey struct{}

type bootstrapDeleteQueryContextKey struct{}

type bootstrapDeleteCommand uint8

const (
	bootstrapResume bootstrapDeleteCommand = iota + 1
	bootstrapDelete
)

type bootstrapDeleteQuery struct {
	pid uint32
}

type bootstrapDeleteBarrier struct {
	resumeAfterBootstrapLock chan uint32
	releaseResume            chan struct{}
	deletePID                chan uint32

	resumeOnce  sync.Once
	releaseOnce sync.Once
	deleteOnce  sync.Once
}

func newBootstrapDeleteBarrier() *bootstrapDeleteBarrier {
	return &bootstrapDeleteBarrier{
		resumeAfterBootstrapLock: make(chan uint32, 1),
		releaseResume:            make(chan struct{}),
		deletePID:                make(chan uint32, 1),
	}
}

func (barrier *bootstrapDeleteBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(bootstrapDeleteCommandContextKey{}) {
	case bootstrapResume:
		if isBootstrapRowLockQuery(data.SQL) {
			return context.WithValue(ctx, bootstrapDeleteQueryContextKey{}, bootstrapDeleteQuery{pid: connection.PgConn().PID()})
		}
	case bootstrapDelete:
		if isUserLockQuery(data.SQL) {
			barrier.deleteOnce.Do(func() { barrier.deletePID <- connection.PgConn().PID() })
		}
	}
	return ctx
}

func (barrier *bootstrapDeleteBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	query, ok := ctx.Value(bootstrapDeleteQueryContextKey{}).(bootstrapDeleteQuery)
	if !ok {
		return
	}
	barrier.resumeOnce.Do(func() { barrier.resumeAfterBootstrapLock <- query.pid })
	select {
	case <-barrier.releaseResume:
	case <-ctx.Done():
	}
}

func (barrier *bootstrapDeleteBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseResume) })
}

func isBootstrapRowLockQuery(sql string) bool {
	normalized := normalizeAccountSessionSQL(sql)
	return strings.Contains(normalized, "from anonymous_bootstraps") &&
		strings.Contains(normalized, "for update") &&
		!strings.Contains(normalized, "for update of u")
}

func isUserLockQuery(sql string) bool {
	normalized := normalizeAccountSessionSQL(sql)
	return strings.Contains(normalized, "select id from users") &&
		strings.Contains(normalized, "where id=$1 for update")
}

type anonymousResumeCall struct {
	record appsession.AnonymousRecord
	err    error
}

type accountDeleteCall struct {
	err error
}

func TestSessionRepositoryAnonymousResumeSerializesUserBeforeBootstrapWithAccountDelete(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		existingUserID  = "10000000-0000-7000-8000-000000000001"
		candidateUserID = "10000000-0000-7000-8000-000000000002"
		newSessionID    = "20000000-0000-7000-8000-000000000001"
	)
	bootstrapHash := []byte("resume-delete-bootstrap")
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, existingUserID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO anonymous_bootstraps(key_hash,user_id,expires_at,created_at)
VALUES($1,$2,$3,$4)`, bootstrapHash, existingUserID, now.Add(10*time.Minute), now); err != nil {
		t.Fatal(err)
	}

	barrier := newBootstrapDeleteBarrier()
	tracedPool := newAccountSessionTracedPool(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	resumeCalls := make(chan anonymousResumeCall, 1)
	resumeCtx := context.WithValue(ctx, bootstrapDeleteCommandContextKey{}, bootstrapResume)
	go func() {
		record, err := NewSessionRepository(tracedPool).CreateOrResumeAnonymous(resumeCtx, appsession.CreateAnonymousRecord{
			BootstrapKeyHash:  bootstrapHash,
			BootstrapExpires:  now.Add(10 * time.Minute),
			UserID:            user.ID(candidateUserID),
			SessionID:         newSessionID,
			SessionTokenHash:  []byte("resume-token"),
			CSRFTokenHash:     []byte("resume-csrf"),
			Now:               now,
			IdleExpiresAt:     now.Add(30 * 24 * time.Hour),
			AbsoluteExpiresAt: now.Add(180 * 24 * time.Hour),
		})
		resumeCalls <- anonymousResumeCall{record: record, err: err}
	}()

	var resumePID uint32
	select {
	case resumePID = <-barrier.resumeAfterBootstrapLock:
	case call := <-resumeCalls:
		t.Fatalf("anonymous resume returned before the bootstrap barrier: record=%#v error=%v", call.record, call.err)
	case <-ctx.Done():
		t.Fatalf("anonymous resume did not reach the bootstrap barrier: %v", ctx.Err())
	}

	deleteCalls := make(chan accountDeleteCall, 1)
	deleteCtx := context.WithValue(ctx, bootstrapDeleteCommandContextKey{}, bootstrapDelete)
	go func() {
		deleteCalls <- accountDeleteCall{err: NewAccountRepository(tracedPool).DeleteAccount(deleteCtx, user.ID(existingUserID), now.Add(time.Minute))}
	}()
	var deletePID uint32
	select {
	case deletePID = <-barrier.deletePID:
	case call := <-deleteCalls:
		t.Fatalf("DeleteAccount returned before issuing the User lock: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not issue the User lock: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, deletePID, resumePID); err != nil {
		t.Fatalf("DeleteAccount did not wait for the resume transaction: %v", err)
	}

	barrier.release()
	var resumeCall anonymousResumeCall
	select {
	case resumeCall = <-resumeCalls:
	case <-ctx.Done():
		t.Fatalf("anonymous resume did not finish after release: %v", ctx.Err())
	}
	var deleteCall accountDeleteCall
	select {
	case deleteCall = <-deleteCalls:
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not finish after release: %v", ctx.Err())
	}
	if resumeCall.err != nil || resumeCall.record.UserID != user.ID(existingUserID) || resumeCall.record.Created {
		t.Fatalf("anonymous resume = %#v, error = %v", resumeCall.record, resumeCall.err)
	}
	if deleteCall.err != nil {
		t.Fatalf("DeleteAccount error = %v", deleteCall.err)
	}

	var users, bootstraps, sessions int
	if err := pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM anonymous_bootstraps WHERE key_hash=$2),
(SELECT count(*) FROM sessions WHERE user_id=$1)`, existingUserID, bootstrapHash).Scan(&users, &bootstraps, &sessions); err != nil {
		t.Fatal(err)
	}
	if users != 0 || bootstraps != 0 || sessions != 0 {
		t.Fatalf("post-race users/bootstraps/sessions = %d/%d/%d, want 0/0/0", users, bootstraps, sessions)
	}
}

type accountDeleteCommandContextKey struct{}

type accountDeleteQueryContextKey struct{}

type accountDeleteCommand uint8

const (
	accountDeleteFirst accountDeleteCommand = iota + 1
	accountDeleteSecond
)

type accountDeleteQuery struct {
	pid uint32
}

type accountDeleteBarrier struct {
	firstAtBudget chan uint32
	releaseFirst  chan struct{}
	secondPID     chan uint32

	mu          sync.Mutex
	firstOrder  []string
	budgetOnce  sync.Once
	releaseOnce sync.Once
	secondOnce  sync.Once
}

func newAccountDeleteBarrier() *accountDeleteBarrier {
	return &accountDeleteBarrier{
		firstAtBudget: make(chan uint32, 1),
		releaseFirst:  make(chan struct{}),
		secondPID:     make(chan uint32, 1),
	}
}

func (barrier *accountDeleteBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	command, _ := ctx.Value(accountDeleteCommandContextKey{}).(accountDeleteCommand)
	if command == accountDeleteSecond && isUserLockQuery(data.SQL) {
		barrier.secondOnce.Do(func() { barrier.secondPID <- connection.PgConn().PID() })
	}
	if command != accountDeleteFirst {
		return ctx
	}
	label := accountDeleteQueryLabel(data)
	if label == "" {
		return ctx
	}
	barrier.mu.Lock()
	barrier.firstOrder = append(barrier.firstOrder, label)
	barrier.mu.Unlock()
	if strings.HasPrefix(label, "budget:") {
		return context.WithValue(ctx, accountDeleteQueryContextKey{}, accountDeleteQuery{pid: connection.PgConn().PID()})
	}
	return ctx
}

func (barrier *accountDeleteBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	query, ok := ctx.Value(accountDeleteQueryContextKey{}).(accountDeleteQuery)
	if !ok {
		return
	}
	barrier.budgetOnce.Do(func() {
		barrier.firstAtBudget <- query.pid
		select {
		case <-barrier.releaseFirst:
		case <-ctx.Done():
		}
	})
}

func (barrier *accountDeleteBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseFirst) })
}

func (barrier *accountDeleteBarrier) order() []string {
	barrier.mu.Lock()
	defer barrier.mu.Unlock()
	return append([]string(nil), barrier.firstOrder...)
}

func accountDeleteQueryLabel(data pgx.TraceQueryStartData) string {
	normalized := normalizeAccountSessionSQL(data.SQL)
	switch {
	case isUserLockQuery(data.SQL):
		return "user-lock"
	case strings.Contains(normalized, "select id from goals") && strings.Contains(normalized, "order by id for update"):
		return "goal-lock"
	case strings.Contains(normalized, "select id from goal_drafts") && strings.Contains(normalized, "order by id for update"):
		return "draft-lock"
	case strings.Contains(normalized, "select id from pdca_cycles") && strings.Contains(normalized, "order by id for update"):
		return "cycle-lock"
	case strings.Contains(normalized, "from ai_generations") && strings.Contains(normalized, "order by id for update"):
		return "generation-lock"
	case strings.Contains(normalized, "from ai_usage_events") && strings.Contains(normalized, "order by operation_id for update"):
		return "usage-lock"
	case strings.Contains(normalized, "update ai_generations set") && strings.Contains(normalized, "budget_reserved_cost_usd=0"):
		return "generation-zero"
	case strings.Contains(normalized, "update ai_budget_monthly set"):
		if month, ok := accountDeleteBudgetMonth(data); ok {
			return "budget:" + month.UTC().Format("2006-01-02")
		}
		return "budget"
	case strings.Contains(normalized, "delete from users where id=$1"):
		return "user-delete"
	default:
		return ""
	}
}

func accountDeleteBudgetMonth(data pgx.TraceQueryStartData) (time.Time, bool) {
	normalized := normalizeAccountSessionSQL(data.SQL)
	const monthPredicate = "where month_utc=$"
	start := strings.Index(normalized, monthPredicate)
	if start < 0 {
		return time.Time{}, false
	}
	start += len(monthPredicate)
	end := start
	argumentNumber := 0
	for end < len(normalized) && normalized[end] >= '0' && normalized[end] <= '9' {
		argumentNumber = argumentNumber*10 + int(normalized[end]-'0')
		end++
	}
	if end == start || argumentNumber < 1 || argumentNumber > len(data.Args) {
		return time.Time{}, false
	}
	switch month := data.Args[argumentNumber-1].(type) {
	case time.Time:
		return month, true
	case pgtype.Date:
		if !month.Valid || month.InfinityModifier != pgtype.Finite {
			return time.Time{}, false
		}
		return month.Time, true
	default:
		return time.Time{}, false
	}
}

func TestAccountDeleteBudgetMonthFollowsSQLPlaceholder(t *testing.T) {
	month := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name string
		data pgx.TraceQueryStartData
	}{
		{
			name: "legacy raw SQL",
			data: pgx.TraceQueryStartData{
				SQL:  `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd-$2 WHERE month_utc=$1`,
				Args: []any{month, "1.25"},
			},
		},
		{
			name: "sqlc generated SQL",
			data: pgx.TraceQueryStartData{
				SQL: `UPDATE ai_budget_monthly SET reserved_cost_usd=reserved_cost_usd-$1::text::numeric,
updated_at=$3::timestamptz WHERE month_utc=$4::date`,
				Args: []any{"1.25", "1.25", pgtype.Timestamptz{Time: month, Valid: true}, pgtype.Date{Time: month, Valid: true}},
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, ok := accountDeleteBudgetMonth(test.data)
			if !ok || !got.Equal(month) {
				t.Fatalf("accountDeleteBudgetMonth() = %v, %t, want %v, true", got, ok, month)
			}
		})
	}
}

type accountDeleteReservationFixture struct {
	userID      string
	august      time.Time
	september   time.Time
	actionID    string
	refineID    string
	actionCost  float64
	refineCost  float64
	initialAug  float64
	initialSep  float64
	initialUnat float64
}

func seedAccountDeleteReservationFixture(t *testing.T, pool *pgxpool.Pool) accountDeleteReservationFixture {
	t.Helper()
	resetDatabase(t, pool)
	now := integrationNow()
	fixture := accountDeleteReservationFixture{
		userID:      "10000000-0000-7000-8000-000000000001",
		august:      time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC),
		september:   time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC),
		actionID:    "81000000-0000-7000-8000-000000000001",
		refineID:    "81000000-0000-7000-8000-000000000002",
		actionCost:  1.25,
		refineCost:  2.50,
		initialAug:  6.00,
		initialSep:  5.00,
		initialUnat: 0.75,
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, fixture.userID, now); err != nil {
		t.Fatal(err)
	}
	goalFixture := progressingGoalFixtures()[0]
	store := NewWorkspaceStore(pool)
	startProgressingGoal(t, store, fixture.userID, goalFixture, 2, now)
	const pendingDraftID = "12000000-0000-7000-8000-000000000001"
	if _, err := executeGoalDraftCreateUseCase(store, context.Background(), fixture.userID, pendingDraftID, "保留中の目標", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_budget_monthly
(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,$3,0.50,$5,$6),($2,$4,0.25,$5,$6)`, fixture.august, fixture.september,
		fixture.initialAug, fixture.initialSep, fixture.initialUnat, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,goal_id,goal_version_id,cycle_id,target_revision,idempotency_key,input_hash,
provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'action_generate','running',$3,$4,$5,0,$6,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','fake','test','action-v1',$7,$8,$9,$10)`,
		fixture.actionID, fixture.userID, goalFixture.goalID, goalFixture.versionID, goalFixture.cycleID,
		"82000000-0000-7000-8000-000000000001", fixture.september, fixture.actionCost, now.Add(time.Hour), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'goal_refine','running',$3,0,$4,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','保留中の目標','fake','test','refine-v1',$5,$6,$7,$8)`,
		fixture.refineID, fixture.userID, pendingDraftID, "82000000-0000-7000-8000-000000000002",
		fixture.august, fixture.refineCost, now.Add(time.Hour), now); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestAccountRepositoryDeleteAccountUsesGlobalLockOrderAndTransfersReservationsOnce(t *testing.T) {
	pool := integrationPool(t)
	fixture := seedAccountDeleteReservationFixture(t, pool)
	now := integrationNow()
	barrier := newAccountDeleteBarrier()
	tracedPool := newAccountSessionTracedPool(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	firstCalls := make(chan accountDeleteCall, 1)
	firstCtx := context.WithValue(ctx, accountDeleteCommandContextKey{}, accountDeleteFirst)
	go func() {
		firstCalls <- accountDeleteCall{err: NewAccountRepository(tracedPool).DeleteAccount(firstCtx, user.ID(fixture.userID), now.Add(time.Minute))}
	}()
	var firstPID uint32
	select {
	case firstPID = <-barrier.firstAtBudget:
	case call := <-firstCalls:
		t.Fatalf("first DeleteAccount returned before budget barrier: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("first DeleteAccount did not reach budget barrier: %v", ctx.Err())
	}

	secondCalls := make(chan accountDeleteCall, 1)
	secondCtx := context.WithValue(ctx, accountDeleteCommandContextKey{}, accountDeleteSecond)
	go func() {
		secondCalls <- accountDeleteCall{err: NewAccountRepository(tracedPool).DeleteAccount(secondCtx, user.ID(fixture.userID), now.Add(2*time.Minute))}
	}()
	var secondPID uint32
	select {
	case secondPID = <-barrier.secondPID:
	case call := <-secondCalls:
		t.Fatalf("second DeleteAccount returned before User lock: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("second DeleteAccount did not issue User lock: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, secondPID, firstPID); err != nil {
		t.Fatalf("second DeleteAccount did not wait for first: %v", err)
	}
	barrier.release()

	var firstCall, secondCall accountDeleteCall
	select {
	case firstCall = <-firstCalls:
	case <-ctx.Done():
		t.Fatalf("first DeleteAccount did not finish: %v", ctx.Err())
	}
	select {
	case secondCall = <-secondCalls:
	case <-ctx.Done():
		t.Fatalf("second DeleteAccount did not finish: %v", ctx.Err())
	}
	if firstCall.err != nil {
		t.Fatalf("first DeleteAccount error = %v", firstCall.err)
	}
	if !errors.Is(secondCall.err, pgx.ErrNoRows) {
		t.Fatalf("second DeleteAccount error = %v, want %v", secondCall.err, pgx.ErrNoRows)
	}

	wantOrder := []string{
		"user-lock", "goal-lock", "draft-lock", "cycle-lock", "generation-lock",
		"usage-lock",
		"generation-zero", "generation-zero",
		"budget:2026-08-01", "budget:2026-09-01", "user-delete",
	}
	if got := barrier.order(); !reflect.DeepEqual(got, wantOrder) {
		t.Fatalf("DeleteAccount query order = %#v, want %#v", got, wantOrder)
	}

	var userRows, goalRows, draftRows, cycleRows, generationRows int
	if err := pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM goals WHERE user_id=$1),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1),
(SELECT count(*) FROM ai_generations WHERE user_id=$1)`, fixture.userID).Scan(
		&userRows, &goalRows, &draftRows, &cycleRows, &generationRows,
	); err != nil {
		t.Fatal(err)
	}
	if userRows != 0 || goalRows != 0 || draftRows != 0 || cycleRows != 0 || generationRows != 0 {
		t.Fatalf("remaining user/goal/draft/cycle/generation rows = %d/%d/%d/%d/%d",
			userRows, goalRows, draftRows, cycleRows, generationRows)
	}
	assertAccountDeleteBudget(t, ctx, pool, fixture.august, fixture.initialAug-fixture.refineCost, fixture.initialUnat+fixture.refineCost)
	assertAccountDeleteBudget(t, ctx, pool, fixture.september, fixture.initialSep-fixture.actionCost, fixture.initialUnat+fixture.actionCost)
}

func TestAccountRepositoryDeleteAccountRollsBackOnGenerationOrBudgetCASMiss(t *testing.T) {
	t.Run("generation update affects zero rows", func(t *testing.T) {
		pool := integrationPool(t)
		fixture := seedAccountDeleteReservationFixture(t, pool)
		const functionName = "account_delete_suppress_generation_update"
		const triggerName = "account_delete_suppress_generation_update"
		if _, err := pool.Exec(context.Background(), `CREATE FUNCTION account_delete_suppress_generation_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.budget_reserved_cost_usd = 0 AND OLD.budget_reserved_cost_usd <> 0 THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), "DROP TRIGGER IF EXISTS "+triggerName+" ON ai_generations")
			_, _ = pool.Exec(context.Background(), "DROP FUNCTION IF EXISTS "+functionName+"()")
		})
		if _, err := pool.Exec(context.Background(), `CREATE TRIGGER account_delete_suppress_generation_update
BEFORE UPDATE OF budget_reserved_cost_usd ON ai_generations
FOR EACH ROW EXECUTE FUNCTION account_delete_suppress_generation_update()`); err != nil {
			t.Fatal(err)
		}

		err := NewAccountRepository(pool).DeleteAccount(context.Background(), user.ID(fixture.userID), integrationNow().Add(time.Minute))
		if err == nil {
			t.Fatal("DeleteAccount succeeded after a zero-row Generation reservation update")
		}
		assertAccountDeleteRollback(t, pool, fixture)
	})

	t.Run("budget update affects zero rows", func(t *testing.T) {
		pool := integrationPool(t)
		fixture := seedAccountDeleteReservationFixture(t, pool)
		if _, err := pool.Exec(context.Background(), `DELETE FROM ai_budget_monthly WHERE month_utc=$1`, fixture.august); err != nil {
			t.Fatal(err)
		}
		err := NewAccountRepository(pool).DeleteAccount(context.Background(), user.ID(fixture.userID), integrationNow().Add(time.Minute))
		if err == nil {
			t.Fatal("DeleteAccount succeeded after a zero-row Budget reservation update")
		}
		var users, generations int
		if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM ai_generations WHERE user_id=$1)`, fixture.userID).Scan(&users, &generations); err != nil {
			t.Fatal(err)
		}
		if users != 1 || generations != 2 {
			t.Fatalf("rollback user/generation rows = %d/%d, want 1/2", users, generations)
		}
		assertGenerationReservations(t, pool, fixture)
		assertAccountDeleteBudget(t, context.Background(), pool, fixture.september, fixture.initialSep, fixture.initialUnat)
	})
}

func assertAccountDeleteRollback(t *testing.T, pool *pgxpool.Pool, fixture accountDeleteReservationFixture) {
	t.Helper()
	var users, goals, drafts, cycles, generations int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM goals WHERE user_id=$1),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1),
(SELECT count(*) FROM ai_generations WHERE user_id=$1)`, fixture.userID).Scan(
		&users, &goals, &drafts, &cycles, &generations,
	); err != nil {
		t.Fatal(err)
	}
	if users != 1 || goals != 1 || drafts != 1 || cycles != 1 || generations != 2 {
		t.Fatalf("rollback user/goal/draft/cycle/generation rows = %d/%d/%d/%d/%d, want 1/1/1/1/2",
			users, goals, drafts, cycles, generations)
	}
	assertGenerationReservations(t, pool, fixture)
	assertAccountDeleteBudget(t, context.Background(), pool, fixture.august, fixture.initialAug, fixture.initialUnat)
	assertAccountDeleteBudget(t, context.Background(), pool, fixture.september, fixture.initialSep, fixture.initialUnat)
}

func assertGenerationReservations(t *testing.T, pool *pgxpool.Pool, fixture accountDeleteReservationFixture) {
	t.Helper()
	var action, refine float64
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$1),
(SELECT budget_reserved_cost_usd FROM ai_generations WHERE id=$2)`, fixture.actionID, fixture.refineID).Scan(&action, &refine); err != nil {
		t.Fatal(err)
	}
	if action != fixture.actionCost || refine != fixture.refineCost {
		t.Fatalf("Generation reservations = %.8f/%.8f, want %.8f/%.8f", action, refine, fixture.actionCost, fixture.refineCost)
	}
}

func assertAccountDeleteBudget(t *testing.T, ctx context.Context, pool *pgxpool.Pool, month time.Time, wantReserved, wantUnattributed float64) {
	t.Helper()
	var reserved, unattributed float64
	if err := pool.QueryRow(ctx, `SELECT reserved_cost_usd,unattributed_cost_usd
FROM ai_budget_monthly WHERE month_utc=$1`, month).Scan(&reserved, &unattributed); err != nil {
		t.Fatal(err)
	}
	if reserved != wantReserved || unattributed != wantUnattributed {
		t.Fatalf("budget %s reserved/unattributed = %.8f/%.8f, want %.8f/%.8f",
			month.Format("2006-01-02"), reserved, unattributed, wantReserved, wantUnattributed)
	}
}

func newAccountSessionTracedPool(t *testing.T, pool *pgxpool.Pool, tracer pgx.QueryTracer) *pgxpool.Pool {
	t.Helper()
	config := pool.Config()
	config.ConnConfig.Tracer = tracer
	config.MinConns = 0
	config.MaxConns = 2
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)
	return tracedPool
}

func normalizeAccountSessionSQL(sql string) string {
	return normalizeObservedSQL(sql)
}
func TestAccountRepositoryDeleteAccountPartitionsRunningAndReleasedExposureWithDatabaseNumericPrecision(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID         = "10000000-0000-7000-8000-000000000001"
		pendingDraftID = "12000000-0000-7000-8000-000000000001"
		refineID       = "81000000-0000-7000-8000-000000000003"
		refineKey      = "82000000-0000-7000-8000-000000000003"
		reservation    = 0.1
	)
	month := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	goalFixtures := progressingGoalFixtures()[:2]
	store := NewWorkspaceStore(pool)
	for _, fixture := range goalFixtures {
		startProgressingGoal(t, store, userID, fixture, 2, now)
	}
	if _, err := executeGoalDraftCreateUseCase(store, context.Background(), userID, pendingDraftID, "保留中の目標", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_budget_monthly
(month_utc,reserved_cost_usd,actual_cost_usd,unattributed_cost_usd,updated_at)
VALUES($1,0.3,0,0,$2)`, month, now); err != nil {
		t.Fatal(err)
	}
	actionIDs := []string{
		"81000000-0000-7000-8000-000000000001",
		"81000000-0000-7000-8000-000000000002",
	}
	actionKeys := []string{
		"82000000-0000-7000-8000-000000000001",
		"82000000-0000-7000-8000-000000000002",
	}
	for index, fixture := range goalFixtures {
		if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,goal_id,goal_version_id,cycle_id,target_revision,idempotency_key,input_hash,
provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'action_generate','running',$3,$4,$5,0,$6,$7,'fake','test','action-v1',$8,$9,$10,$11)`,
			actionIDs[index], userID, fixture.goalID, fixture.versionID, fixture.cycleID, actionKeys[index],
			integrationAIRequestHash, month, reservation, now.Add(time.Hour), now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_generations
(id,user_id,operation_type,status,source_goal_draft_id,target_revision,idempotency_key,input_hash,source_text,
provider,model,prompt_version,budget_month_utc,budget_reserved_cost_usd,lease_expires_at,started_at)
VALUES($1,$2,'goal_refine','running',$3,0,$4,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','保留中の目標','fake','test','refine-v1',$5,$6,$7,$8)`,
		refineID, userID, pendingDraftID, refineKey, month, reservation, now.Add(time.Hour), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO ai_usage_events
(operation_id,user_id,goal_id,operation_type,status,provider,model,prompt_version,accepted_at,quota_retain_until)
VALUES
($1,$2,$3,'action_generate','accepted','fake','test','action-v1',$7,$8),
($4,$2,$5,'action_generate','accepted','fake','test','action-v1',$7,$8),
($6,$2,NULL,'goal_refine','accepted','fake','test','refine-v1',$7,$8)`,
		actionIDs[0], userID, goalFixtures[0].goalID, actionIDs[1], goalFixtures[1].goalID, refineID,
		now, now.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `DELETE FROM ai_generations WHERE id=$1`, refineID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE ai_budget_monthly SET reserved_cost_usd=0.2 WHERE month_utc=$1`, month); err != nil {
		t.Fatal(err)
	}

	if err := NewAccountRepository(pool).DeleteAccount(context.Background(), user.ID(userID), now.Add(2*time.Minute)); err != nil {
		t.Fatalf("DeleteAccount with three same-month 0.1 reservations error = %v", err)
	}
	var users, usageEvents int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM ai_usage_events WHERE user_id=$1)`, userID).Scan(&users, &usageEvents); err != nil {
		t.Fatal(err)
	}
	if users != 0 || usageEvents != 0 {
		t.Fatalf("remaining users/usage events = %d/%d, want 0/0", users, usageEvents)
	}
	assertAccountDeleteBudget(t, context.Background(), pool, month, 0, 0.3)
}

type accountDeleteAICommandContextKey struct{}

type accountDeleteAIQueryContextKey struct{}

type accountDeleteAICommand uint8

const (
	accountDeleteAIRunningDelete accountDeleteAICommand = iota + 1
	accountDeleteAIReleasedDelete
	accountDeleteAILateFinish
)

type accountDeleteAIQuery struct {
	pid uint32
}

type accountDeleteAIBarrier struct {
	deleteAfterGenerationLock chan uint32
	releaseDelete             chan struct{}
	finishUserLock            chan uint32
	traceErrors               chan error

	deleteOnce  sync.Once
	releaseOnce sync.Once
	finishOnce  sync.Once
}

func newAccountDeleteAIBarrier() *accountDeleteAIBarrier {
	return &accountDeleteAIBarrier{
		deleteAfterGenerationLock: make(chan uint32, 1),
		releaseDelete:             make(chan struct{}),
		finishUserLock:            make(chan uint32, 1),
		traceErrors:               make(chan error, 1),
	}
}

func (barrier *accountDeleteAIBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(accountDeleteAICommandContextKey{}) {
	case accountDeleteAIRunningDelete:
		if isAccountDeleteAIRunningGenerationLock(data.SQL) {
			return context.WithValue(ctx, accountDeleteAIQueryContextKey{}, accountDeleteAIQuery{pid: connection.PgConn().PID()})
		}
	case accountDeleteAIReleasedDelete:
		if isAccountDeleteAIUnfinalizedUsageLock(data.SQL) {
			return context.WithValue(ctx, accountDeleteAIQueryContextKey{}, accountDeleteAIQuery{pid: connection.PgConn().PID()})
		}
	case accountDeleteAILateFinish:
		if isUserLockQuery(data.SQL) {
			barrier.finishOnce.Do(func() { barrier.finishUserLock <- connection.PgConn().PID() })
		}
	}
	return ctx
}

func (barrier *accountDeleteAIBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	query, ok := ctx.Value(accountDeleteAIQueryContextKey{}).(accountDeleteAIQuery)
	if !ok {
		return
	}
	if data.Err != nil {
		barrier.reportTraceError(data.Err)
	}
	if affected := data.CommandTag.RowsAffected(); affected != 1 {
		barrier.reportTraceError(errors.New("Account Delete running Generation lock did not return exactly one row"))
	}
	barrier.deleteOnce.Do(func() {
		barrier.deleteAfterGenerationLock <- query.pid
		select {
		case <-barrier.releaseDelete:
		case <-ctx.Done():
		}
	})
}

func (barrier *accountDeleteAIBarrier) reportTraceError(err error) {
	select {
	case barrier.traceErrors <- err:
	default:
	}
}

func (barrier *accountDeleteAIBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseDelete) })
}

func isAccountDeleteAIRunningGenerationLock(sql string) bool {
	normalized := normalizeAccountSessionSQL(sql)
	return strings.Contains(normalized, "from ai_generations") &&
		strings.Contains(normalized, "where user_id=$1 and status='running'") &&
		strings.Contains(normalized, "order by id for update")
}

func isAccountDeleteAIUnfinalizedUsageLock(sql string) bool {
	normalized := normalizeAccountSessionSQL(sql)
	return strings.Contains(normalized, "from ai_usage_events") &&
		strings.Contains(normalized, "provider_usage_finalized_at is null") &&
		strings.Contains(normalized, "order by operation_id for update")
}

type accountDeleteAIFinishCall struct {
	response workspace.AIResponse
	err      error
}

func accountDeleteAISettings() aiIntegrationApplicationSettings {
	rateHashKey := []byte("test-rate-key")
	return aiIntegrationApplicationSettings{
		Entitlements: workspace.Entitlements{MaxAIOperationsPer24Hours: 20},
		GoalDraft: workspace.GoalDraftUseCaseSettings{
			Provider: "fake", Model: "test", GoalPromptVersion: "goal-refine-v1",
			MonthlyBudgetUSD: 100, ReservationUSD: 0.1, LeaseDuration: time.Minute,
			RateHashKey: append([]byte(nil), rateHashKey...),
		},
		ActionAI: workspace.ActionAIUseCaseSettings{
			Provider: "fake", Model: "test",
			GeneratePromptVersion: "action-generate-v1", RefinePromptVersion: "action-refine-v1",
			MonthlyBudgetUSD: 100, ReservationUSD: 0.1, LeaseDuration: time.Minute,
			RateHashKey: append([]byte(nil), rateHashKey...),
		},
	}
}

func accountDeleteAIContext(_ context.Context, snapshot workspace.AISnapshot) (workspace.AISnapshot, error) {
	snapshot.CanonicalProviderInputHash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	return snapshot, nil
}

func TestAccountRepositoryDeleteAccountWinsAgainstLateActionAIFinalization(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	settings := accountDeleteAISettings()
	seedStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	startProgressingGoal(t, seedStore, userID, fixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',
content_revision=3,plan_revision=1,do_revision=1,check_revision=1 WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := executeActionGenerateBeginUseCaseWithSettings(seedStore, context.Background(), workspace.ActionGenerateInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ExpectedContentRevision: 3,
		IdempotencyKey:          "82000000-0000-7000-8000-000000000001",
		GenerationID:            "83000000-0000-7000-8000-000000000001",
		Now:                     now.Add(time.Minute),
	}, accountDeleteAIContext, settings)
	if err != nil {
		t.Fatal(err)
	}
	month := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	const initialActual = 0.25
	if _, err := pool.Exec(context.Background(), `UPDATE ai_budget_monthly SET actual_cost_usd=$2 WHERE month_utc=$1`, month, initialActual); err != nil {
		t.Fatal(err)
	}

	barrier := newAccountDeleteAIBarrier()
	tracedPool := newAccountSessionTracedPool(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	deleteCalls := make(chan accountDeleteCall, 1)
	deleteCtx := context.WithValue(ctx, accountDeleteAICommandContextKey{}, accountDeleteAIRunningDelete)
	go func() {
		deleteCalls <- accountDeleteCall{err: NewAccountRepository(tracedPool).DeleteAccount(deleteCtx, user.ID(userID), now.Add(2*time.Minute))}
	}()
	var deletePID uint32
	select {
	case deletePID = <-barrier.deleteAfterGenerationLock:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Account Delete barrier error: %v", traceErr)
	case call := <-deleteCalls:
		t.Fatalf("DeleteAccount returned before its Generation barrier: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not reach its Generation barrier: %v", ctx.Err())
	}
	select {
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Account Delete barrier error: %v", traceErr)
	default:
	}

	result := workspace.AIExecutionResult{
		Output: "削除後には適用しない行動", Attempts: 1,
		Usage: workspace.AIUsage{InputTokens: 12, OutputTokens: 5,
			CostUSD: 0.004, ProviderRequestID: "provider-after-account-delete"},
	}
	finishCalls := make(chan accountDeleteAIFinishCall, 1)
	finishCtx := context.WithValue(ctx, accountDeleteAICommandContextKey{}, accountDeleteAILateFinish)
	store := NewWorkspaceStore(tracedPool)
	go func() {
		response, callErr := executeActionFinishUseCaseWithSettings(store, finishCtx, snapshot, result, nil, now.Add(3*time.Minute), settings)
		finishCalls <- accountDeleteAIFinishCall{response: response, err: callErr}
	}()
	var finishPID uint32
	select {
	case finishPID = <-barrier.finishUserLock:
	case call := <-finishCalls:
		t.Fatalf("FinishActionAI returned before issuing its User lock: response=%#v error=%v", call.response, call.err)
	case <-ctx.Done():
		t.Fatalf("FinishActionAI did not issue its User lock: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, finishPID, deletePID); err != nil {
		t.Fatalf("FinishActionAI did not wait for Account Delete: %v", err)
	}
	barrier.release()

	var deleteCall accountDeleteCall
	select {
	case deleteCall = <-deleteCalls:
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not finish: %v", ctx.Err())
	}
	var finishCall accountDeleteAIFinishCall
	select {
	case finishCall = <-finishCalls:
	case <-ctx.Done():
		t.Fatalf("FinishActionAI did not finish: %v", ctx.Err())
	}
	if deleteCall.err != nil {
		t.Fatalf("DeleteAccount error = %v", deleteCall.err)
	}
	if !errors.Is(finishCall.err, workspace.ErrNotFound) || !reflect.DeepEqual(finishCall.response, workspace.AIResponse{}) {
		t.Fatalf("late FinishActionAI = response %#v, error %v; want zero response/%v", finishCall.response, finishCall.err, workspace.ErrNotFound)
	}

	var users, goals, generations, usageEvents int
	var reserved, actual, unattributed float64
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM goals WHERE id=$2),
(SELECT count(*) FROM ai_generations WHERE id=$3),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$3),
(SELECT reserved_cost_usd FROM ai_budget_monthly WHERE month_utc=$4),
(SELECT actual_cost_usd FROM ai_budget_monthly WHERE month_utc=$4),
(SELECT unattributed_cost_usd FROM ai_budget_monthly WHERE month_utc=$4)`,
		userID, fixture.goalID, snapshot.GenerationID, month,
	).Scan(&users, &goals, &generations, &usageEvents, &reserved, &actual, &unattributed); err != nil {
		t.Fatal(err)
	}
	if users != 0 || goals != 0 || generations != 0 || usageEvents != 0 {
		t.Fatalf("post-race user/goal/generation/usage = %d/%d/%d/%d, want 0/0/0/0", users, goals, generations, usageEvents)
	}
	if reserved != 0 || actual != initialActual || unattributed != settings.ActionAI.ReservationUSD {
		t.Fatalf("post-race budget reserved/actual/unattributed = %.8f/%.8f/%.8f, want 0/%.8f/%.8f",
			reserved, actual, unattributed, initialActual, settings.ActionAI.ReservationUSD)
	}
}

func TestAccountRepositoryDeleteAccountWinsAgainstReleasedUsageLateFinalization(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
	settings := accountDeleteAISettings()
	seedStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	startProgressingGoal(t, seedStore, userID, fixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',
content_revision=3,plan_revision=1,do_revision=1,check_revision=1 WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := executeActionGenerateBeginUseCaseWithSettings(seedStore, context.Background(), workspace.ActionGenerateInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ExpectedContentRevision: 3,
		IdempotencyKey:          "82000000-0000-7000-8000-000000000001",
		GenerationID:            "83000000-0000-7000-8000-000000000001",
		Now:                     now.Add(time.Minute),
	}, accountDeleteAIContext, settings)
	if err != nil {
		t.Fatal(err)
	}
	month := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	releaseTx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = releaseTx.Exec(context.Background(), `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2 WHERE month_utc=$1`, month, settings.ActionAI.ReservationUSD); err != nil {
		_ = releaseTx.Rollback(context.Background())
		t.Fatal(err)
	}
	if _, err = releaseTx.Exec(context.Background(), `UPDATE ai_generations SET status='failed',failure_code='goal_deleted',
budget_reserved_cost_usd=0,lease_expires_at=NULL,finished_at=$2 WHERE id=$1`, snapshot.GenerationID, now.Add(2*time.Minute)); err != nil {
		_ = releaseTx.Rollback(context.Background())
		t.Fatal(err)
	}
	if _, err = releaseTx.Exec(context.Background(), `UPDATE ai_usage_events
SET status='failed',goal_id=NULL,content_deleted=true WHERE operation_id=$1`, snapshot.GenerationID); err != nil {
		_ = releaseTx.Rollback(context.Background())
		t.Fatal(err)
	}
	if err = releaseTx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}

	barrier := newAccountDeleteAIBarrier()
	tracedPool := newAccountSessionTracedPool(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()
	deleteCalls := make(chan accountDeleteCall, 1)
	deleteCtx := context.WithValue(ctx, accountDeleteAICommandContextKey{}, accountDeleteAIReleasedDelete)
	go func() {
		deleteCalls <- accountDeleteCall{err: NewAccountRepository(tracedPool).DeleteAccount(deleteCtx, user.ID(userID), now.Add(3*time.Minute))}
	}()
	var deletePID uint32
	select {
	case deletePID = <-barrier.deleteAfterGenerationLock:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Account Delete released Usage barrier error: %v", traceErr)
	case call := <-deleteCalls:
		t.Fatalf("DeleteAccount returned before its released Usage barrier: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not lock released Usage: %v", ctx.Err())
	}

	result := workspace.AIExecutionResult{
		Output: "削除後には適用しない行動", Attempts: 1,
		Usage: workspace.AIUsage{InputTokens: 12, OutputTokens: 5,
			CostUSD: 0.004, ProviderRequestID: "provider-after-released-account-delete"},
	}
	finishCalls := make(chan accountDeleteAIFinishCall, 1)
	finishCtx := context.WithValue(ctx, accountDeleteAICommandContextKey{}, accountDeleteAILateFinish)
	store := NewWorkspaceStore(tracedPool)
	go func() {
		response, callErr := executeActionFinishUseCaseWithSettings(store, finishCtx, snapshot, result, nil, now.Add(4*time.Minute), settings)
		finishCalls <- accountDeleteAIFinishCall{response: response, err: callErr}
	}()
	var finishPID uint32
	select {
	case finishPID = <-barrier.finishUserLock:
	case call := <-finishCalls:
		t.Fatalf("late finalization returned before User lock: response=%#v error=%v", call.response, call.err)
	case <-ctx.Done():
		t.Fatalf("late finalization did not issue User lock: %v", ctx.Err())
	}
	if err = waitForBlockedBackend(ctx, pool, finishPID, deletePID); err != nil {
		t.Fatalf("late finalization did not wait for Account Delete: %v", err)
	}
	barrier.release()
	deleteCall := <-deleteCalls
	finishCall := <-finishCalls
	if deleteCall.err != nil {
		t.Fatalf("DeleteAccount error = %v", deleteCall.err)
	}
	if !errors.Is(finishCall.err, workspace.ErrNotFound) {
		t.Fatalf("late finalization error = %v, want %v", finishCall.err, workspace.ErrNotFound)
	}
	var users, generations, usages int
	var reserved, actual, unattributed string
	if err = pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM ai_generations WHERE id=$2),
(SELECT count(*) FROM ai_usage_events WHERE operation_id=$2),
(SELECT reserved_cost_usd::text FROM ai_budget_monthly WHERE month_utc=$3),
(SELECT actual_cost_usd::text FROM ai_budget_monthly WHERE month_utc=$3),
(SELECT unattributed_cost_usd::text FROM ai_budget_monthly WHERE month_utc=$3)`,
		userID, snapshot.GenerationID, month).Scan(&users, &generations, &usages, &reserved, &actual, &unattributed); err != nil {
		t.Fatal(err)
	}
	if users != 0 || generations != 0 || usages != 0 || reserved != "0.00000000" ||
		actual != "0.00000000" || unattributed != "0.10000000" {
		t.Fatalf("post-race user/gen/usage/budget = %d/%d/%d %s/%s/%s", users, generations, usages,
			reserved, actual, unattributed)
	}
}

type bootstrapDeleteWinsCommandContextKey struct{}

type bootstrapDeleteWinsQueryContextKey struct{}

type bootstrapDeleteWinsCommand uint8

const (
	bootstrapDeleteWinsDelete bootstrapDeleteWinsCommand = iota + 1
	bootstrapDeleteWinsResume
)

type bootstrapDeleteWinsQuery struct {
	pid uint32
}

type bootstrapDeleteWinsBarrier struct {
	deleteAfterUserLock chan uint32
	releaseDelete       chan struct{}
	resumeUserLock      chan uint32
	traceErrors         chan error

	deleteOnce  sync.Once
	releaseOnce sync.Once
	resumeOnce  sync.Once
}

func newBootstrapDeleteWinsBarrier() *bootstrapDeleteWinsBarrier {
	return &bootstrapDeleteWinsBarrier{
		deleteAfterUserLock: make(chan uint32, 1),
		releaseDelete:       make(chan struct{}),
		resumeUserLock:      make(chan uint32, 1),
		traceErrors:         make(chan error, 1),
	}
}

func (barrier *bootstrapDeleteWinsBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(bootstrapDeleteWinsCommandContextKey{}) {
	case bootstrapDeleteWinsDelete:
		if isUserLockQuery(data.SQL) {
			return context.WithValue(ctx, bootstrapDeleteWinsQueryContextKey{}, bootstrapDeleteWinsQuery{pid: connection.PgConn().PID()})
		}
	case bootstrapDeleteWinsResume:
		if isBootstrapResumeUserLockQuery(data.SQL) {
			barrier.resumeOnce.Do(func() { barrier.resumeUserLock <- connection.PgConn().PID() })
		}
	}
	return ctx
}

func (barrier *bootstrapDeleteWinsBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	query, ok := ctx.Value(bootstrapDeleteWinsQueryContextKey{}).(bootstrapDeleteWinsQuery)
	if !ok {
		return
	}
	if data.Err != nil {
		barrier.reportTraceError(data.Err)
	}
	if affected := data.CommandTag.RowsAffected(); affected != 1 {
		barrier.reportTraceError(errors.New("Account Delete User lock did not return exactly one row"))
	}
	barrier.deleteOnce.Do(func() {
		barrier.deleteAfterUserLock <- query.pid
		select {
		case <-barrier.releaseDelete:
		case <-ctx.Done():
		}
	})
}

func (barrier *bootstrapDeleteWinsBarrier) reportTraceError(err error) {
	select {
	case barrier.traceErrors <- err:
	default:
	}
}

func (barrier *bootstrapDeleteWinsBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseDelete) })
}

func isBootstrapResumeUserLockQuery(sql string) bool {
	normalized := normalizeAccountSessionSQL(sql)
	return isUserLockQuery(sql) ||
		(strings.Contains(normalized, "from anonymous_bootstraps bootstrap") &&
			strings.Contains(normalized, "join users u") &&
			strings.Contains(normalized, "for update of u"))
}

func TestSessionRepositoryAnonymousResumeDoesNotRecreateAfterAccountDeleteWins(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		existingUserID  = "10000000-0000-7000-8000-000000000001"
		candidateUserID = "10000000-0000-7000-8000-000000000002"
		newSessionID    = "20000000-0000-7000-8000-000000000001"
	)
	bootstrapHash := []byte("delete-wins-bootstrap")
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, existingUserID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO anonymous_bootstraps(key_hash,user_id,expires_at,created_at)
VALUES($1,$2,$3,$4)`, bootstrapHash, existingUserID, now.Add(10*time.Minute), now); err != nil {
		t.Fatal(err)
	}

	barrier := newBootstrapDeleteWinsBarrier()
	tracedPool := newAccountSessionTracedPool(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	deleteCalls := make(chan accountDeleteCall, 1)
	deleteCtx := context.WithValue(ctx, bootstrapDeleteWinsCommandContextKey{}, bootstrapDeleteWinsDelete)
	go func() {
		deleteCalls <- accountDeleteCall{err: NewAccountRepository(tracedPool).DeleteAccount(deleteCtx, user.ID(existingUserID), now.Add(time.Minute))}
	}()
	var deletePID uint32
	select {
	case deletePID = <-barrier.deleteAfterUserLock:
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Account Delete User barrier error: %v", traceErr)
	case call := <-deleteCalls:
		t.Fatalf("DeleteAccount returned before its User barrier: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not reach its User barrier: %v", ctx.Err())
	}
	select {
	case traceErr := <-barrier.traceErrors:
		t.Fatalf("Account Delete User barrier error: %v", traceErr)
	default:
	}

	resumeCalls := make(chan anonymousResumeCall, 1)
	resumeCtx := context.WithValue(ctx, bootstrapDeleteWinsCommandContextKey{}, bootstrapDeleteWinsResume)
	go func() {
		record, callErr := NewSessionRepository(tracedPool).CreateOrResumeAnonymous(resumeCtx, appsession.CreateAnonymousRecord{
			BootstrapKeyHash:  bootstrapHash,
			BootstrapExpires:  now.Add(10 * time.Minute),
			UserID:            user.ID(candidateUserID),
			SessionID:         newSessionID,
			SessionTokenHash:  []byte("delete-wins-token"),
			CSRFTokenHash:     []byte("delete-wins-csrf"),
			Now:               now,
			IdleExpiresAt:     now.Add(30 * 24 * time.Hour),
			AbsoluteExpiresAt: now.Add(180 * 24 * time.Hour),
		})
		resumeCalls <- anonymousResumeCall{record: record, err: callErr}
	}()
	var resumePID uint32
	select {
	case resumePID = <-barrier.resumeUserLock:
	case call := <-resumeCalls:
		t.Fatalf("anonymous resume returned before issuing its User lock: record=%#v error=%v", call.record, call.err)
	case <-ctx.Done():
		t.Fatalf("anonymous resume did not issue its User lock: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, resumePID, deletePID); err != nil {
		t.Fatalf("anonymous resume did not wait for Account Delete: %v", err)
	}
	barrier.release()

	var deleteCall accountDeleteCall
	select {
	case deleteCall = <-deleteCalls:
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not finish: %v", ctx.Err())
	}
	var resumeCall anonymousResumeCall
	select {
	case resumeCall = <-resumeCalls:
	case <-ctx.Done():
		t.Fatalf("anonymous resume did not finish: %v", ctx.Err())
	}
	if deleteCall.err != nil {
		t.Fatalf("DeleteAccount error = %v", deleteCall.err)
	}
	if !errors.Is(resumeCall.err, pgx.ErrNoRows) || !reflect.DeepEqual(resumeCall.record, appsession.AnonymousRecord{}) {
		t.Fatalf("anonymous resume = record %#v, error %v; want zero record/%v", resumeCall.record, resumeCall.err, pgx.ErrNoRows)
	}

	var existingUsers, candidateUsers, sessions, bootstraps int
	if err := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM users WHERE id=$2),
(SELECT count(*) FROM sessions WHERE id=$3),
(SELECT count(*) FROM anonymous_bootstraps WHERE key_hash=$4)`,
		existingUserID, candidateUserID, newSessionID, bootstrapHash,
	).Scan(&existingUsers, &candidateUsers, &sessions, &bootstraps); err != nil {
		t.Fatal(err)
	}
	if existingUsers != 0 || candidateUsers != 0 || sessions != 0 || bootstraps != 0 {
		t.Fatalf("post-race existing/candidate users, sessions, bootstraps = %d/%d/%d/%d, want 0/0/0/0",
			existingUsers, candidateUsers, sessions, bootstraps)
	}
}
