package postgres

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type continueContentionContextKey struct{}
type continueContentionTraceKey struct{}

type continueContentionTraceKind uint8

const (
	continueInitialReceiptTrace continueContentionTraceKind = iota + 1
	continueBlockedQueryTrace
)

type continueContentionTrace struct {
	kind continueContentionTraceKind
	pid  uint32
}

type continueContentionAttempt struct {
	receiptStarts atomic.Uint32
	blockedOnce   sync.Once
}

type continueContentionBarrier struct {
	blockQuery func(string) bool

	initialLookupsDone chan struct{}
	releaseInitial     chan struct{}
	blockedStarts      chan uint32
	leaderPID          chan uint32
	releaseLeader      chan struct{}

	initialEnds      atomic.Uint32
	leaderOnce       sync.Once
	releaseInitialDo sync.Once
	releaseLeaderDo  sync.Once
}

func newContinueContentionBarrier(blockQuery func(string) bool) *continueContentionBarrier {
	return &continueContentionBarrier{
		blockQuery:         blockQuery,
		initialLookupsDone: make(chan struct{}),
		releaseInitial:     make(chan struct{}),
		blockedStarts:      make(chan uint32, 2),
		leaderPID:          make(chan uint32, 1),
		releaseLeader:      make(chan struct{}),
	}
}

func (barrier *continueContentionBarrier) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	attempt, ok := ctx.Value(continueContentionContextKey{}).(*continueContentionAttempt)
	if !ok {
		return ctx
	}
	if isContinueReceiptQuery(data.SQL) && attempt.receiptStarts.Add(1) == 1 {
		return context.WithValue(ctx, continueContentionTraceKey{}, continueContentionTrace{
			kind: continueInitialReceiptTrace, pid: connection.PgConn().PID(),
		})
	}
	if barrier.blockQuery(data.SQL) {
		traced := false
		attempt.blockedOnce.Do(func() {
			traced = true
			barrier.blockedStarts <- connection.PgConn().PID()
		})
		if traced {
			return context.WithValue(ctx, continueContentionTraceKey{}, continueContentionTrace{
				kind: continueBlockedQueryTrace, pid: connection.PgConn().PID(),
			})
		}
	}
	return ctx
}

func (barrier *continueContentionBarrier) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	_ pgx.TraceQueryEndData,
) {
	trace, ok := ctx.Value(continueContentionTraceKey{}).(continueContentionTrace)
	if !ok {
		return
	}
	switch trace.kind {
	case continueInitialReceiptTrace:
		if barrier.initialEnds.Add(1) == 2 {
			close(barrier.initialLookupsDone)
		}
		select {
		case <-barrier.releaseInitial:
		case <-ctx.Done():
		}
	case continueBlockedQueryTrace:
		leader := false
		barrier.leaderOnce.Do(func() {
			leader = true
			barrier.leaderPID <- trace.pid
		})
		if leader {
			select {
			case <-barrier.releaseLeader:
			case <-ctx.Done():
			}
		}
	}
}

func (barrier *continueContentionBarrier) releaseInitialLookups() {
	barrier.releaseInitialDo.Do(func() { close(barrier.releaseInitial) })
}

func (barrier *continueContentionBarrier) releaseLeaderQuery() {
	barrier.releaseLeaderDo.Do(func() { close(barrier.releaseLeader) })
}

func isContinueReceiptQuery(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	return strings.Contains(normalized, "select c.goal_id,c.id,c.start_request_hash") &&
		strings.Contains(normalized, "from pdca_cycles c") &&
		strings.Contains(normalized, "where c.user_id=$1 and c.start_operation_id=$2")
}

func isContinueGoalLockQuery(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	return strings.Contains(normalized, "from goals") &&
		strings.Contains(normalized, "where id=$1 and user_id=$2") &&
		strings.Contains(normalized, "for update")
}

func isContinueClaimQuery(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	return strings.Contains(normalized, "insert into pdca_cycles") &&
		strings.Contains(normalized, "on conflict (user_id,start_operation_id) do nothing")
}

func newContinueContentionStore(
	t *testing.T,
	pool *pgxpool.Pool,
	barrier *continueContentionBarrier,
) (*WorkspaceStore, *pgxpool.Pool) {
	t.Helper()
	config := pool.Config()
	config.ConnConfig.Tracer = barrier
	config.MinConns = 0
	config.MaxConns = 2
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	return NewWorkspaceStore(tracedPool), tracedPool
}

func waitForContinueContention(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	barrier *continueContentionBarrier,
) {
	t.Helper()
	select {
	case <-barrier.initialLookupsDone:
	case <-ctx.Done():
		t.Fatalf("Continue attempts did not finish both initial receipt lookups: %v", ctx.Err())
	}
	barrier.releaseInitialLookups()
	starts := make([]uint32, 0, 2)
	for len(starts) < 2 {
		select {
		case pid := <-barrier.blockedStarts:
			starts = append(starts, pid)
		case <-ctx.Done():
			t.Fatalf("Continue attempts did not both reach contention query: %v", ctx.Err())
		}
	}
	var leader uint32
	select {
	case leader = <-barrier.leaderPID:
	case <-ctx.Done():
		t.Fatalf("Continue contention leader was not observed: %v", ctx.Err())
	}
	follower := starts[0]
	if follower == leader {
		follower = starts[1]
	}
	if err := waitForBlockedBackend(ctx, pool, follower, leader); err != nil {
		t.Fatalf("Continue backend %d did not block behind %d: %v", follower, leader, err)
	}
	barrier.releaseLeaderQuery()
}

type reviewTransitionRaceContextKey struct{}
type reviewTransitionRaceTraceKey struct{}

type reviewTransitionRaceCommand uint8

const (
	reviewTransitionRaceContinue reviewTransitionRaceCommand = iota + 1
	reviewTransitionRaceTerminate
	reviewTransitionRaceStart
)

type reviewTransitionRaceLock struct {
	pid uint32
	err error
}

// reviewTransitionRaceBarrier pauses the selected winner after PostgreSQL has
// granted its Goal row lock. The loser is then allowed to enter PostgreSQL and
// must be observed waiting on that exact backend before the winner is released.
type reviewTransitionRaceBarrier struct {
	winner    reviewTransitionRaceCommand
	lockQuery func(string) bool

	winnerLocked   chan reviewTransitionRaceLock
	loserLockStart chan uint32
	releaseWinner  chan struct{}

	winnerStartOnce sync.Once
	winnerEndOnce   sync.Once
	loserOnce       sync.Once
	releaseOnce     sync.Once
}

func newReviewTransitionRaceBarrier(winner reviewTransitionRaceCommand) *reviewTransitionRaceBarrier {
	return newReviewTransitionRaceBarrierAtQuery(winner, isContinueGoalLockQuery)
}

func newReviewTransitionRaceBarrierAtQuery(
	winner reviewTransitionRaceCommand,
	lockQuery func(string) bool,
) *reviewTransitionRaceBarrier {
	return &reviewTransitionRaceBarrier{
		winner:         winner,
		lockQuery:      lockQuery,
		winnerLocked:   make(chan reviewTransitionRaceLock, 1),
		loserLockStart: make(chan uint32, 1),
		releaseWinner:  make(chan struct{}),
	}
}

func (barrier *reviewTransitionRaceBarrier) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	command, ok := ctx.Value(reviewTransitionRaceContextKey{}).(reviewTransitionRaceCommand)
	if !ok || !barrier.lockQuery(data.SQL) {
		return ctx
	}
	pid := connection.PgConn().PID()
	if command == barrier.winner {
		traced := false
		barrier.winnerStartOnce.Do(func() { traced = true })
		if traced {
			return context.WithValue(ctx, reviewTransitionRaceTraceKey{}, pid)
		}
		return ctx
	}
	barrier.loserOnce.Do(func() { barrier.loserLockStart <- pid })
	return ctx
}

func (barrier *reviewTransitionRaceBarrier) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryEndData,
) {
	pid, ok := ctx.Value(reviewTransitionRaceTraceKey{}).(uint32)
	if !ok {
		return
	}
	barrier.winnerEndOnce.Do(func() {
		barrier.winnerLocked <- reviewTransitionRaceLock{pid: pid, err: data.Err}
	})
	select {
	case <-barrier.releaseWinner:
	case <-ctx.Done():
	}
}

func (barrier *reviewTransitionRaceBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseWinner) })
}

func newReviewTransitionRaceStore(
	t *testing.T,
	pool *pgxpool.Pool,
	barrier *reviewTransitionRaceBarrier,
) (*WorkspaceStore, *pgxpool.Pool) {
	t.Helper()
	config := pool.Config()
	config.ConnConfig.Tracer = barrier
	config.MinConns = 0
	config.MaxConns = 2
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	return NewWorkspaceStore(tracedPool), tracedPool
}
