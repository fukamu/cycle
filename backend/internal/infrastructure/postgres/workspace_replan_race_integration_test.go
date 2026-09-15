package postgres

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type replanRaceRole uint8

const (
	replanRaceWinner replanRaceRole = iota + 1
	replanRaceLoser
)

type replanRaceRoleContextKey struct{}
type replanRaceWinnerLockContextKey struct{}

type replanRaceWinnerLock struct {
	pid uint32
	err error
}

// replanRaceUserLockBarrier pauses the selected winner immediately after it
// acquires the canonical User lock. The loser can then be observed waiting on
// that exact backend before the winner is released.
type replanRaceUserLockBarrier struct {
	winnerLocked   chan replanRaceWinnerLock
	loserLockStart chan uint32
	releaseWinner  chan struct{}

	winnerStartOnce sync.Once
	winnerEndOnce   sync.Once
	loserStartOnce  sync.Once
	releaseOnce     sync.Once
}

func newReplanRaceUserLockBarrier() *replanRaceUserLockBarrier {
	return &replanRaceUserLockBarrier{
		winnerLocked:   make(chan replanRaceWinnerLock, 1),
		loserLockStart: make(chan uint32, 1),
		releaseWinner:  make(chan struct{}),
	}
}

func (barrier *replanRaceUserLockBarrier) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if !isUserLockQuery(data.SQL) {
		return ctx
	}
	pid := connection.PgConn().PID()
	switch ctx.Value(replanRaceRoleContextKey{}) {
	case replanRaceWinner:
		barrier.winnerStartOnce.Do(func() {
			ctx = context.WithValue(ctx, replanRaceWinnerLockContextKey{}, pid)
		})
	case replanRaceLoser:
		barrier.loserStartOnce.Do(func() { barrier.loserLockStart <- pid })
	}
	return ctx
}

func (barrier *replanRaceUserLockBarrier) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryEndData,
) {
	pid, ok := ctx.Value(replanRaceWinnerLockContextKey{}).(uint32)
	if !ok {
		return
	}
	barrier.winnerEndOnce.Do(func() {
		barrier.winnerLocked <- replanRaceWinnerLock{pid: pid, err: data.Err}
	})
	select {
	case <-barrier.releaseWinner:
	case <-ctx.Done():
	}
}

func (barrier *replanRaceUserLockBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseWinner) })
}

type replanRaceCall struct {
	result workspace.ReplanCycleResult
	err    error
}

type replanTerminalRaceCall struct {
	replanResult    workspace.ReplanCycleResult
	terminateResult workspace.TerminateResult
	err             error
}

func TestWorkspaceReplanConcurrentSameOperationConvergesToFreshAndReplay(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)

	now := integrationNow()
	const (
		userID      = "10000000-0000-7000-8000-000000000001"
		successorID = "41000000-0000-7000-8000-000000000701"
		operationID = "61000000-0000-7000-8000-000000000701"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, NewWorkspaceStore(pool), userID, fixture, 2, now)
	input := workspace.ReplanCycleInput{
		UserID:                         userID,
		GoalID:                         fixture.goalID,
		CycleID:                        fixture.cycleID,
		OperationID:                    operationID,
		ExpectedGoalRevision:           started.Goal.Revision,
		ExpectedContentRevision:        started.Cycle.ContentRevision,
		ExpectedReviewScheduleRevision: started.Cycle.ReviewScheduleRevision,
		Confirmed:                      true,
	}

	barrier := newReplanRaceUserLockBarrier()
	store := newReplanRaceTracedStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	defer barrier.release()

	leaderCalls := make(chan replanRaceCall, 1)
	go func() {
		result, err := newCycleApplicationTestUseCases(store, now.Add(time.Minute), successorID).ReplanCycle(
			context.WithValue(ctx, replanRaceRoleContextKey{}, replanRaceWinner),
			input,
		)
		leaderCalls <- replanRaceCall{result: result, err: err}
	}()
	winnerLock := receiveReplanRaceWinnerLock(t, ctx, barrier.winnerLocked)
	if winnerLock.err != nil {
		t.Fatalf("winner User lock error = %v", winnerLock.err)
	}

	followerCalls := make(chan replanRaceCall, 1)
	go func() {
		// A valid replay must not consume a fresh successor ID.
		result, err := newCycleApplicationTestUseCases(store, now.Add(2*time.Minute)).ReplanCycle(
			context.WithValue(ctx, replanRaceRoleContextKey{}, replanRaceLoser),
			input,
		)
		followerCalls <- replanRaceCall{result: result, err: err}
	}()
	loserPID := receiveReplanRacePID(t, ctx, barrier.loserLockStart)
	if err := waitForBlockedBackend(ctx, pool, loserPID, winnerLock.pid); err != nil {
		t.Fatalf("same-operation follower did not wait for leader User lock: %v", err)
	}
	barrier.release()

	leader := receiveReplanRaceCall(t, ctx, leaderCalls)
	follower := receiveReplanRaceCall(t, ctx, followerCalls)
	if leader.err != nil || follower.err != nil {
		t.Fatalf("same-operation Replan errors leader/follower = %v/%v", leader.err, follower.err)
	}
	if leader.result.Replayed || !follower.result.Replayed {
		t.Fatalf("same-operation replay flags leader/follower = %t/%t, want fresh/replay",
			leader.result.Replayed, follower.result.Replayed)
	}
	for name, result := range map[string]workspace.ReplanCycleResult{
		"fresh":  leader.result,
		"replay": follower.result,
	} {
		if result.Goal.ID != fixture.goalID || result.CanceledCycle.ID != fixture.cycleID ||
			result.Cycle.ID != successorID || result.Goal.Revision != started.Goal.Revision+1 {
			t.Fatalf("%s Replan result = %#v, want the same committed tuple", name, result)
		}
	}

	state := loadReplanRaceDatabaseState(t, pool, userID, fixture.goalID, fixture.cycleID, successorID, operationID)
	assertReplanRaceDatabaseState(t, state, replanRaceDatabaseState{
		goalStatus:          string(goal.StatusActiveCycle),
		goalRevision:        started.Goal.Revision + 1,
		nextCycleSequence:   int32(started.Goal.NextCycleSequenceNumber + 1),
		totalCycles:         2,
		activeSuccessors:    1,
		replannedSources:    1,
		replanReceiptCycles: 1,
	})
}

func TestWorkspaceReplanAndTerminateSerializeWithoutDeadlock(t *testing.T) {
	tests := []struct {
		name       string
		replanWins bool
	}{
		{name: "Replan commits before Terminate", replanWins: true},
		{name: "Terminate commits before Replan", replanWins: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := integrationPool(t)
			resetDatabase(t, pool)

			now := integrationNow()
			const (
				userID               = "10000000-0000-7000-8000-000000000001"
				successorID          = "41000000-0000-7000-8000-000000000702"
				replanOperationID    = "61000000-0000-7000-8000-000000000702"
				terminateOperationID = "71000000-0000-7000-8000-000000000702"
			)
			insertAIConcurrencyUser(t, pool, userID, now)
			fixture := progressingGoalFixtures()[0]
			started := startProgressingGoal(t, NewWorkspaceStore(pool), userID, fixture, 2, now)
			replanInput := workspace.ReplanCycleInput{
				UserID:                         userID,
				GoalID:                         fixture.goalID,
				CycleID:                        fixture.cycleID,
				OperationID:                    replanOperationID,
				ExpectedGoalRevision:           started.Goal.Revision,
				ExpectedContentRevision:        started.Cycle.ContentRevision,
				ExpectedReviewScheduleRevision: started.Cycle.ReviewScheduleRevision,
				Confirmed:                      true,
			}
			cycleRevision := started.Cycle.ContentRevision
			terminateInput := workspace.TerminateInput{
				UserID:                       userID,
				GoalID:                       fixture.goalID,
				OperationID:                  terminateOperationID,
				Outcome:                      goal.StatusEnded,
				ExpectedGoalRevision:         started.Goal.Revision,
				ExpectedState:                goal.StatusActiveCycle,
				ActiveCycleID:                fixture.cycleID,
				ExpectedCycleContentRevision: &cycleRevision,
				Now:                          now.Add(2 * time.Minute),
			}

			barrier := newReplanRaceUserLockBarrier()
			store := newReplanRaceTracedStore(t, pool, barrier)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			defer barrier.release()

			winnerCalls := make(chan replanTerminalRaceCall, 1)
			go runReplanTerminalRaceCall(
				ctx, store, replanRaceWinner, test.replanWins,
				replanInput, terminateInput, successorID, winnerCalls,
			)
			winnerLock := receiveReplanRaceWinnerLock(t, ctx, barrier.winnerLocked)
			if winnerLock.err != nil {
				t.Fatalf("winner User lock error = %v", winnerLock.err)
			}

			loserCalls := make(chan replanTerminalRaceCall, 1)
			go runReplanTerminalRaceCall(
				ctx, store, replanRaceLoser, !test.replanWins,
				replanInput, terminateInput, "", loserCalls,
			)
			loserPID := receiveReplanRacePID(t, ctx, barrier.loserLockStart)
			if err := waitForBlockedBackend(ctx, pool, loserPID, winnerLock.pid); err != nil {
				t.Fatalf("losing transition did not wait for winner User lock: %v", err)
			}
			barrier.release()

			winner := receiveReplanTerminalRaceCall(t, ctx, winnerCalls)
			loser := receiveReplanTerminalRaceCall(t, ctx, loserCalls)
			if winner.err != nil {
				t.Fatalf("winning transition error = %v", winner.err)
			}
			if !errors.Is(loser.err, workspace.ErrGoalStateConflict) {
				t.Fatalf("losing transition error = %v, want %v", loser.err, workspace.ErrGoalStateConflict)
			}

			state := loadReplanRaceDatabaseState(
				t, pool, userID, fixture.goalID, fixture.cycleID, successorID, replanOperationID,
			)
			if test.replanWins {
				if winner.replanResult.Replayed || winner.replanResult.Cycle.ID != successorID ||
					winner.replanResult.CanceledCycle.ID != fixture.cycleID {
					t.Fatalf("winning Replan result = %#v, want fresh successor", winner.replanResult)
				}
				assertReplanRaceDatabaseState(t, state, replanRaceDatabaseState{
					goalStatus:          string(goal.StatusActiveCycle),
					goalRevision:        started.Goal.Revision + 1,
					nextCycleSequence:   int32(started.Goal.NextCycleSequenceNumber + 1),
					totalCycles:         2,
					activeSuccessors:    1,
					replannedSources:    1,
					replanReceiptCycles: 1,
				})
				return
			}

			if winner.terminateResult.Goal.Status != goal.StatusEnded ||
				winner.terminateResult.CanceledCycle == nil ||
				winner.terminateResult.CanceledCycle.ID != fixture.cycleID {
				t.Fatalf("winning Terminate result = %#v, want coherent terminal tuple", winner.terminateResult)
			}
			assertReplanRaceDatabaseState(t, state, replanRaceDatabaseState{
				goalStatus:        string(goal.StatusEnded),
				goalRevision:      started.Goal.Revision + 1,
				nextCycleSequence: int32(started.Goal.NextCycleSequenceNumber),
				terminalOperation: terminateOperationID,
				totalCycles:       1,
				goalEndedSources:  1,
			})
		})
	}
}

func newReplanRaceTracedStore(
	t *testing.T,
	pool *pgxpool.Pool,
	tracer pgx.QueryTracer,
) *WorkspaceStore {
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
	return NewWorkspaceStore(tracedPool)
}

func runReplanTerminalRaceCall(
	ctx context.Context,
	store *WorkspaceStore,
	role replanRaceRole,
	runReplan bool,
	replanInput workspace.ReplanCycleInput,
	terminateInput workspace.TerminateInput,
	successorID string,
	calls chan<- replanTerminalRaceCall,
) {
	callCtx := context.WithValue(ctx, replanRaceRoleContextKey{}, role)
	if runReplan {
		generatedIDs := []string(nil)
		if successorID != "" {
			generatedIDs = append(generatedIDs, successorID)
		}
		result, err := newCycleApplicationTestUseCases(
			store,
			terminateInput.Now.Add(-time.Minute),
			generatedIDs...,
		).ReplanCycle(callCtx, replanInput)
		calls <- replanTerminalRaceCall{replanResult: result, err: err}
		return
	}
	result, err := executeTerminateGoalUseCase(store, callCtx, terminateInput)
	calls <- replanTerminalRaceCall{terminateResult: result, err: err}
}

func receiveReplanRaceWinnerLock(
	t *testing.T,
	ctx context.Context,
	locks <-chan replanRaceWinnerLock,
) replanRaceWinnerLock {
	t.Helper()
	select {
	case lock := <-locks:
		return lock
	case <-ctx.Done():
		t.Fatalf("winning transition did not acquire User lock: %v", ctx.Err())
		return replanRaceWinnerLock{}
	}
}

func receiveReplanRacePID(t *testing.T, ctx context.Context, pids <-chan uint32) uint32 {
	t.Helper()
	select {
	case pid := <-pids:
		return pid
	case <-ctx.Done():
		t.Fatalf("losing transition did not attempt User lock: %v", ctx.Err())
		return 0
	}
}

func receiveReplanRaceCall(t *testing.T, ctx context.Context, calls <-chan replanRaceCall) replanRaceCall {
	t.Helper()
	select {
	case call := <-calls:
		return call
	case <-ctx.Done():
		t.Fatalf("Replan race call did not finish: %v", ctx.Err())
		return replanRaceCall{}
	}
}

func receiveReplanTerminalRaceCall(
	t *testing.T,
	ctx context.Context,
	calls <-chan replanTerminalRaceCall,
) replanTerminalRaceCall {
	t.Helper()
	select {
	case call := <-calls:
		return call
	case <-ctx.Done():
		t.Fatalf("Replan/Terminate race call did not finish: %v", ctx.Err())
		return replanTerminalRaceCall{}
	}
}

type replanRaceDatabaseState struct {
	goalStatus          string
	goalRevision        int64
	nextCycleSequence   int32
	terminalOperation   string
	totalCycles         int64
	activeSuccessors    int64
	replannedSources    int64
	goalEndedSources    int64
	replanReceiptCycles int64
}

func loadReplanRaceDatabaseState(
	t *testing.T,
	pool *pgxpool.Pool,
	userID, goalID, sourceCycleID, successorID, replanOperationID string,
) replanRaceDatabaseState {
	t.Helper()
	var state replanRaceDatabaseState
	if err := pool.QueryRow(t.Context(), `SELECT
    g.status,g.revision,g.next_cycle_sequence_number,COALESCE(g.terminal_operation_id::text,''),
    (SELECT count(*) FROM public.pdca_cycles WHERE user_id=$1 AND goal_id=$2),
    (SELECT count(*) FROM public.pdca_cycles
        WHERE user_id=$1 AND goal_id=$2 AND id=$4 AND status='active'),
    (SELECT count(*) FROM public.pdca_cycles
        WHERE user_id=$1 AND goal_id=$2 AND id=$3 AND status='canceled' AND cancellation_reason='replanned'),
    (SELECT count(*) FROM public.pdca_cycles
        WHERE user_id=$1 AND goal_id=$2 AND id=$3 AND status='canceled' AND cancellation_reason='goal_ended'),
    (SELECT count(*) FROM public.pdca_cycles
        WHERE user_id=$1 AND goal_id=$2 AND start_operation_id=$5)
FROM public.goals AS g
WHERE g.user_id=$1 AND g.id=$2`,
		userID, goalID, sourceCycleID, successorID, replanOperationID,
	).Scan(
		&state.goalStatus,
		&state.goalRevision,
		&state.nextCycleSequence,
		&state.terminalOperation,
		&state.totalCycles,
		&state.activeSuccessors,
		&state.replannedSources,
		&state.goalEndedSources,
		&state.replanReceiptCycles,
	); err != nil {
		t.Fatal(err)
	}
	return state
}

func assertReplanRaceDatabaseState(t *testing.T, got, want replanRaceDatabaseState) {
	t.Helper()
	if got != want {
		t.Fatalf("Replan race database state = %#v, want %#v", got, want)
	}
}
