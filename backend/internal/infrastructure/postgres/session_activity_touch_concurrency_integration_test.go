package postgres

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type sessionActivityTouchContextKey struct{}

type sessionActivityTouchTracer struct {
	started chan uint32
	once    sync.Once
}

func newSessionActivityTouchTracer() *sessionActivityTouchTracer {
	return &sessionActivityTouchTracer{started: make(chan uint32, 1)}
}

func (tracer *sessionActivityTouchTracer) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if ctx.Value(sessionActivityTouchContextKey{}) == true && isSessionActivityTouchQuery(data.SQL) {
		tracer.once.Do(func() { tracer.started <- connection.PgConn().PID() })
	}
	return ctx
}

func (*sessionActivityTouchTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func isSessionActivityTouchQuery(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	return strings.Contains(normalized, "with located_session as materialized") &&
		strings.Contains(normalized, "for update of u") &&
		strings.Contains(normalized, "for update of s") &&
		strings.Contains(normalized, "update users as u")
}

type sessionActivityDeleteContextKey struct{}

type sessionActivityDeleteQueryKey struct{}

type sessionActivityDeleteBarrier struct {
	userLocked  chan uint32
	release     chan struct{}
	lockOnce    sync.Once
	releaseOnce sync.Once
}

func newSessionActivityDeleteBarrier() *sessionActivityDeleteBarrier {
	return &sessionActivityDeleteBarrier{
		userLocked: make(chan uint32, 1),
		release:    make(chan struct{}),
	}
}

func (barrier *sessionActivityDeleteBarrier) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if ctx.Value(sessionActivityDeleteContextKey{}) != true || !isUserLockQuery(data.SQL) {
		return ctx
	}
	return context.WithValue(ctx, sessionActivityDeleteQueryKey{}, connection.PgConn().PID())
}

func (barrier *sessionActivityDeleteBarrier) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	_ pgx.TraceQueryEndData,
) {
	pid, ok := ctx.Value(sessionActivityDeleteQueryKey{}).(uint32)
	if !ok {
		return
	}
	barrier.lockOnce.Do(func() { barrier.userLocked <- pid })
	select {
	case <-barrier.release:
	case <-ctx.Done():
	}
}

func (barrier *sessionActivityDeleteBarrier) releaseDelete() {
	barrier.releaseOnce.Do(func() { close(barrier.release) })
}

type sessionActivityCall struct {
	err error
}

func TestSessionRepositoryTouchOlderConcurrentRequestCannotRegressNewerActivity(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000070"
		sessionID = "20000000-0000-7000-8000-000000000070"
	)
	insertSessionRepositoryUser(t, pool, userID, now)
	insertSessionRepositorySession(t, pool, sessionRepositoryFixture{
		id: sessionID, userID: userID,
		tokenHash: []byte("touch-order-race-token"), csrfHash: []byte("touch-order-race-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(4 * time.Hour),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sessionBlocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sessionBlocker.Rollback(context.Background()) }()
	var ignored string
	if err = sessionBlocker.QueryRow(ctx, `SELECT id::text FROM sessions WHERE id=$1 FOR UPDATE`, sessionID).Scan(&ignored); err != nil {
		t.Fatal(err)
	}
	blockerPID := sessionBlocker.Conn().PgConn().PID()

	newerTracer := newSessionActivityTouchTracer()
	newerPool := newSessionActivityTracedPool(t, pool, newerTracer)
	newerCalls := make(chan sessionActivityCall, 1)
	newerCtx := context.WithValue(ctx, sessionActivityTouchContextKey{}, true)
	go func() {
		newerCalls <- sessionActivityCall{err: NewSessionRepository(newerPool).Touch(
			newerCtx,
			sessionID,
			now.Add(30*time.Minute),
			now.Add(3*time.Hour),
		)}
	}()
	var newerPID uint32
	select {
	case newerPID = <-newerTracer.started:
	case call := <-newerCalls:
		t.Fatalf("newer Touch() returned before issuing its statement: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("newer Touch() did not start: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, newerPID, blockerPID); err != nil {
		t.Fatalf("newer Touch backend %d did not wait for Session lock %d: %v", newerPID, blockerPID, err)
	}

	olderTracer := newSessionActivityTouchTracer()
	olderPool := newSessionActivityTracedPool(t, pool, olderTracer)
	olderCalls := make(chan sessionActivityCall, 1)
	olderCtx := context.WithValue(ctx, sessionActivityTouchContextKey{}, true)
	go func() {
		olderCalls <- sessionActivityCall{err: NewSessionRepository(olderPool).Touch(
			olderCtx,
			sessionID,
			now.Add(10*time.Minute),
			now.Add(2*time.Hour),
		)}
	}()
	var olderPID uint32
	select {
	case olderPID = <-olderTracer.started:
	case call := <-olderCalls:
		t.Fatalf("older Touch() returned before issuing its statement: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("older Touch() did not start: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, olderPID, newerPID); err != nil {
		t.Fatalf("older Touch backend %d did not wait for newer Touch %d: %v", olderPID, newerPID, err)
	}
	if err = sessionBlocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for name, calls := range map[string]<-chan sessionActivityCall{
		"newer": newerCalls,
		"older": olderCalls,
	} {
		select {
		case call := <-calls:
			if call.err != nil {
				t.Fatalf("%s Touch() error = %v", name, call.err)
			}
		case <-ctx.Done():
			t.Fatalf("%s Touch() did not finish: %v", name, ctx.Err())
		}
	}
	assertSessionRepositoryActivityTimes(t, pool, sessionID, userID, sessionRepositoryActivityTimes{
		lastSeenAt:    now.Add(30 * time.Minute),
		idleExpiresAt: now.Add(3 * time.Hour),
		lastActiveAt:  now.Add(30 * time.Minute),
		userUpdatedAt: now.Add(30 * time.Minute),
	})
}

func TestSessionRepositoryTouchRechecksRevocationAfterWaitingForUserLock(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000071"
		sessionID = "20000000-0000-7000-8000-000000000071"
	)
	insertSessionRepositoryUser(t, pool, userID, now)
	insertSessionRepositorySession(t, pool, sessionRepositoryFixture{
		id: sessionID, userID: userID,
		tokenHash: []byte("touch-revoke-race-token"), csrfHash: []byte("touch-revoke-race-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(4 * time.Hour),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	var ignored string
	if err = blocker.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&ignored); err != nil {
		t.Fatal(err)
	}
	blockerPID := blocker.Conn().PgConn().PID()

	touchTracer := newSessionActivityTouchTracer()
	touchPool := newSessionActivityTracedPool(t, pool, touchTracer)
	touchCalls := make(chan sessionActivityCall, 1)
	touchCtx := context.WithValue(ctx, sessionActivityTouchContextKey{}, true)
	go func() {
		touchCalls <- sessionActivityCall{err: NewSessionRepository(touchPool).Touch(
			touchCtx,
			sessionID,
			now.Add(30*time.Minute),
			now.Add(2*time.Hour),
		)}
	}()

	var touchPID uint32
	select {
	case touchPID = <-touchTracer.started:
	case call := <-touchCalls:
		t.Fatalf("Touch() returned before issuing its statement: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("Touch() did not start: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, touchPID, blockerPID); err != nil {
		t.Fatalf("Touch backend %d did not wait for User lock %d: %v", touchPID, blockerPID, err)
	}
	revokedAt := now.Add(5 * time.Minute)
	if _, err = pool.Exec(ctx, `UPDATE sessions SET revoked_at=$2 WHERE id=$1`, sessionID, revokedAt); err != nil {
		t.Fatalf("revoking the unlocked Session: %v", err)
	}
	select {
	case call := <-touchCalls:
		t.Fatalf("Touch() returned while User remained locked: %v", call.err)
	default:
	}
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case call := <-touchCalls:
		if call.err != nil {
			t.Fatalf("Touch() error = %v", call.err)
		}
	case <-ctx.Done():
		t.Fatalf("Touch() did not finish after User lock release: %v", ctx.Err())
	}

	assertSessionRepositoryActivityTimes(t, pool, sessionID, userID, sessionRepositoryActivityTimes{
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), lastActiveAt: now, userUpdatedAt: now,
	})
	var gotRevokedAt time.Time
	if err = pool.QueryRow(ctx, `SELECT revoked_at FROM sessions WHERE id=$1`, sessionID).Scan(&gotRevokedAt); err != nil {
		t.Fatal(err)
	}
	if !gotRevokedAt.Equal(revokedAt) {
		t.Fatalf("revoked_at = %s, want %s", gotRevokedAt, revokedAt)
	}
}

func TestSessionRepositoryTouchConvergesWhenAccountDeleteHoldsUserLock(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000072"
		sessionID = "20000000-0000-7000-8000-000000000072"
	)
	insertSessionRepositoryUser(t, pool, userID, now)
	insertSessionRepositorySession(t, pool, sessionRepositoryFixture{
		id: sessionID, userID: userID,
		tokenHash: []byte("touch-delete-race-token"), csrfHash: []byte("touch-delete-race-csrf"),
		lastSeenAt: now, idleExpiresAt: now.Add(time.Hour), absoluteExpiresAt: now.Add(4 * time.Hour),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deleteBarrier := newSessionActivityDeleteBarrier()
	defer deleteBarrier.releaseDelete()
	deletePool := newSessionActivityTracedPool(t, pool, deleteBarrier)
	deleteCalls := make(chan sessionActivityCall, 1)
	deleteCtx := context.WithValue(ctx, sessionActivityDeleteContextKey{}, true)
	go func() {
		_, deleteErr := NewAccountRepository(deletePool).DeleteAccount(deleteCtx, user.ID(userID), now.Add(time.Minute))
		deleteCalls <- sessionActivityCall{err: deleteErr}
	}()

	var deletePID uint32
	select {
	case deletePID = <-deleteBarrier.userLocked:
	case call := <-deleteCalls:
		t.Fatalf("DeleteAccount returned before its User-lock barrier: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not lock User: %v", ctx.Err())
	}

	touchTracer := newSessionActivityTouchTracer()
	touchPool := newSessionActivityTracedPool(t, pool, touchTracer)
	touchCalls := make(chan sessionActivityCall, 1)
	touchCtx := context.WithValue(ctx, sessionActivityTouchContextKey{}, true)
	go func() {
		touchCalls <- sessionActivityCall{err: NewSessionRepository(touchPool).Touch(
			touchCtx,
			sessionID,
			now.Add(30*time.Minute),
			now.Add(2*time.Hour),
		)}
	}()

	var touchPID uint32
	select {
	case touchPID = <-touchTracer.started:
	case call := <-touchCalls:
		t.Fatalf("Touch() returned before issuing its statement: %v", call.err)
	case <-ctx.Done():
		t.Fatalf("Touch() did not start: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, touchPID, deletePID); err != nil {
		t.Fatalf("Touch backend %d did not wait for Account Delete %d: %v", touchPID, deletePID, err)
	}
	deleteBarrier.releaseDelete()

	select {
	case call := <-deleteCalls:
		if call.err != nil {
			t.Fatalf("DeleteAccount() error = %v", call.err)
		}
	case <-ctx.Done():
		t.Fatalf("DeleteAccount did not finish: %v", ctx.Err())
	}
	select {
	case call := <-touchCalls:
		if call.err != nil {
			t.Fatalf("Touch() error = %v", call.err)
		}
	case <-ctx.Done():
		t.Fatalf("Touch() did not converge after Account Delete: %v", ctx.Err())
	}
	var users, sessions int
	if err := pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM users WHERE id=$1),
(SELECT count(*) FROM sessions WHERE id=$2)`, userID, sessionID).Scan(&users, &sessions); err != nil {
		t.Fatal(err)
	}
	if users != 0 || sessions != 0 {
		t.Fatalf("post-delete users/sessions = %d/%d, want 0/0", users, sessions)
	}
}

func newSessionActivityTracedPool(t *testing.T, pool *pgxpool.Pool, tracer pgx.QueryTracer) *pgxpool.Pool {
	t.Helper()
	config := pool.Config()
	config.ConnConfig.Tracer = tracer
	config.MinConns = 0
	config.MaxConns = 1
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)
	return tracedPool
}
