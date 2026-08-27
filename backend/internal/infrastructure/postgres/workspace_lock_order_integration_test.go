package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type lockOrderCommandContextKey struct{}

type lockOrderCommand uint8

const (
	lockOrderComplete lockOrderCommand = iota + 1
	lockOrderTerminate
)

type completeTerminateLockBarrier struct {
	completeAfterCycle chan uint32
	releaseComplete    chan struct{}
	terminatePID       chan uint32

	completeOnce  sync.Once
	releaseOnce   sync.Once
	terminateOnce sync.Once
}

func newCompleteTerminateLockBarrier() *completeTerminateLockBarrier {
	return &completeTerminateLockBarrier{
		completeAfterCycle: make(chan uint32, 1),
		releaseComplete:    make(chan struct{}),
		terminatePID:       make(chan uint32, 1),
	}
}

func (barrier *completeTerminateLockBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(lockOrderCommandContextKey{}) {
	case lockOrderComplete:
		if isCompletePostCycleLockQuery(data.SQL) {
			barrier.completeOnce.Do(func() {
				barrier.completeAfterCycle <- connection.PgConn().PID()
			})
			select {
			case <-barrier.releaseComplete:
			case <-ctx.Done():
			}
		}
	case lockOrderTerminate:
		barrier.terminateOnce.Do(func() {
			barrier.terminatePID <- connection.PgConn().PID()
		})
	}
	return ctx
}

func (*completeTerminateLockBarrier) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
}

func (barrier *completeTerminateLockBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseComplete) })
}

func isCompletePostCycleLockQuery(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	return (strings.Contains(normalized, "select exists(") || strings.Contains(normalized, "select exists (")) &&
		strings.Contains(normalized, "select 1 from ai_generations") &&
		strings.Contains(normalized, "where user_id=$1") &&
		strings.Contains(normalized, "goal_id=$2") &&
		strings.Contains(normalized, "cycle_id=$3") &&
		strings.Contains(normalized, "status='running'")
}

type completeCycleCall struct {
	result workspace.CompleteCycleResult
	err    error
}

type terminateGoalCall struct {
	result workspace.TerminateResult
	err    error
}

type completeReplayAttemptContextKey struct{}

type completeReplayLookupContextKey struct{}

type completeReplayLookupTrace struct {
	state   *completeReplayAttemptTraceState
	ordinal uint32
	pid     uint32
}

type completeReplayLookupObservation struct {
	pid          uint32
	rowsAffected int64
	err          error
}

type completeReplayAttemptTraceState struct {
	lookupStarts   atomic.Uint32
	initialPID     atomic.Uint32
	postLockLookup chan completeReplayLookupObservation
	leader         bool
}

type completeReplayBarrier struct {
	initialLookupsDone   chan struct{}
	releaseInitialLookup chan struct{}
	releaseFollower      chan struct{}
	traceErrors          chan error
	initialLookupEnds    atomic.Uint32
	releaseOnce          sync.Once
	releaseFollowerOnce  sync.Once
}

func newCompleteReplayBarrier() *completeReplayBarrier {
	return &completeReplayBarrier{
		initialLookupsDone:   make(chan struct{}),
		releaseInitialLookup: make(chan struct{}),
		releaseFollower:      make(chan struct{}),
		traceErrors:          make(chan error, 2),
	}
}

func newCompleteReplayAttemptTraceState(leader bool) *completeReplayAttemptTraceState {
	return &completeReplayAttemptTraceState{
		postLockLookup: make(chan completeReplayLookupObservation, 1),
		leader:         leader,
	}
}

func (barrier *completeReplayBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	state, ok := ctx.Value(completeReplayAttemptContextKey{}).(*completeReplayAttemptTraceState)
	if !ok {
		return ctx
	}
	if isUserLockQuery(data.SQL) && !state.leader {
		select {
		case <-barrier.releaseFollower:
		case <-ctx.Done():
		}
	}
	if !isCompleteReplayLookupQuery(data.SQL) {
		return ctx
	}
	ordinal := state.lookupStarts.Add(1)
	if ordinal > 2 {
		barrier.reportTraceError(fmt.Errorf("CompleteCycle replay lookup count exceeded 2"))
		return ctx
	}
	pid := connection.PgConn().PID()
	if ordinal == 1 {
		state.initialPID.Store(pid)
	}
	if ordinal == 2 && state.leader {
		barrier.releaseFollowerOnce.Do(func() { close(barrier.releaseFollower) })
	}
	return context.WithValue(ctx, completeReplayLookupContextKey{}, completeReplayLookupTrace{
		state: state, ordinal: ordinal, pid: pid,
	})
}

func (barrier *completeReplayBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	lookup, ok := ctx.Value(completeReplayLookupContextKey{}).(completeReplayLookupTrace)
	if !ok {
		return
	}
	affected := data.CommandTag.RowsAffected()
	if lookup.ordinal == 2 {
		lookup.state.postLockLookup <- completeReplayLookupObservation{
			pid: lookup.pid, rowsAffected: affected, err: data.Err,
		}
		return
	}
	if data.Err != nil {
		barrier.reportTraceError(fmt.Errorf("initial replay lookup trace error: %w", data.Err))
	}
	if affected != 0 {
		barrier.reportTraceError(fmt.Errorf("initial replay lookup affected %d rows, want 0", affected))
	}
	if barrier.initialLookupEnds.Add(1) == 2 {
		close(barrier.initialLookupsDone)
	}
	select {
	case <-barrier.releaseInitialLookup:
	case <-ctx.Done():
	}
}

func (barrier *completeReplayBarrier) reportTraceError(err error) {
	select {
	case barrier.traceErrors <- err:
	default:
	}
}

func (barrier *completeReplayBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseInitialLookup) })
}

func isCompleteReplayLookupQuery(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	projection := strings.Contains(normalized, "select goal_id,id,completion_request_hash from pdca_cycles") ||
		strings.Contains(normalized, "select goal_id,id as cycle_id,completion_request_hash as request_hash from pdca_cycles")
	return projection &&
		strings.Contains(normalized, "where user_id=$1 and completion_operation_id=$2")
}

func completeCycleCanonicalHashForTest(t *testing.T, input workspace.CompleteCycleInput) string {
	t.Helper()
	body, err := json.Marshal(struct {
		GoalID          string `json:"goalId"`
		CycleID         string `json:"cycleId"`
		GoalRevision    int64  `json:"goalRevision"`
		ContentRevision int64  `json:"contentRevision"`
	}{
		GoalID: input.GoalID, CycleID: input.CycleID,
		GoalRevision: input.ExpectedGoalRevision, ContentRevision: input.ExpectedContentRevision,
	})
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x", sha256.Sum256(body))
}

type concurrentCompleteCycleCall struct {
	input         workspace.CompleteCycleInput
	reviewDraftID string
	result        workspace.CompleteCycleResult
	err           error
}

func TestWorkspaceStoreCompleteCycleAndTerminateUseGoalBeforeCycleLockOrder(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}

	seedStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, seedStore, userID, fixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',action='A',
content_revision=4,plan_revision=1,do_revision=1,check_revision=1,action_revision=1 WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}

	barrier := newCompleteTerminateLockBarrier()
	tracedConfig := pool.Config()
	tracedConfig.ConnConfig.Tracer = barrier
	tracedConfig.MinConns = 0
	tracedConfig.MaxConns = 2
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), tracedConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer tracedPool.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.release()
		cancel()
	}()

	store := NewWorkspaceStore(tracedPool)
	const completeReviewDraftID = "61000000-0000-7000-8000-000000000001"
	completeInput := workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		OperationID:          "62000000-0000-7000-8000-000000000001",
		ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
	}
	cycleRevision := int64(4)
	terminateInput := workspace.TerminateInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID: "71000000-0000-7000-8000-000000000001",
		Outcome:     goal.StatusEnded, ExpectedGoalRevision: started.Goal.Revision,
		ExpectedState: goal.StatusActiveCycle, ActiveCycleID: fixture.cycleID,
		ExpectedCycleContentRevision: &cycleRevision,
		RequestHash:                  "terminate-lock-order-hash", Now: now.Add(2 * time.Minute),
	}

	completeCalls := make(chan completeCycleCall, 1)
	completeCtx := context.WithValue(ctx, lockOrderCommandContextKey{}, lockOrderComplete)
	go func() {
		result, callErr := executeCycleCompleteUseCase(store, completeCtx, completeInput, now.Add(time.Minute), completeReviewDraftID)
		completeCalls <- completeCycleCall{result: result, err: callErr}
	}()

	var completePID uint32
	select {
	case completePID = <-barrier.completeAfterCycle:
	case call := <-completeCalls:
		t.Fatalf("complete returned before reaching the post-cycle-lock barrier: result=%#v error=%v", call.result, call.err)
	case <-ctx.Done():
		t.Fatalf("complete did not reach the post-cycle-lock barrier: %v", ctx.Err())
	}

	terminateCalls := make(chan terminateGoalCall, 1)
	terminateCtx := context.WithValue(ctx, lockOrderCommandContextKey{}, lockOrderTerminate)
	go func() {
		result, callErr := executeTerminateGoalUseCase(store, terminateCtx, terminateInput)
		terminateCalls <- terminateGoalCall{result: result, err: callErr}
	}()

	var terminatePID uint32
	select {
	case terminatePID = <-barrier.terminatePID:
	case call := <-terminateCalls:
		t.Fatalf("terminate returned before issuing a traced query: result=%#v error=%v", call.result, call.err)
	case <-ctx.Done():
		t.Fatalf("terminate did not issue a traced query: %v", ctx.Err())
	}
	if err = waitForBlockedBackend(ctx, pool, terminatePID, completePID); err != nil {
		t.Fatalf("terminate backend did not wait for CompleteCycle's lock: %v", err)
	}

	barrier.release()
	completeCall := receiveCompleteCycleCall(t, ctx, completeCalls)
	terminateCall := receiveTerminateGoalCall(t, ctx, terminateCalls)
	if completeCall.err != nil {
		t.Fatalf("complete error = %v", completeCall.err)
	}
	if !errors.Is(terminateCall.err, workspace.ErrGoalStateConflict) {
		t.Fatalf("terminate error = %v, want %v", terminateCall.err, workspace.ErrGoalStateConflict)
	}
	if completeCall.result.Goal.Status != goal.StatusGoalReview || completeCall.result.CompletedCycle.Status != cycle.StatusCompleted {
		t.Fatalf("complete result = %#v", completeCall.result)
	}

	assertCompleteWonLockOrderRace(t, ctx, pool, completeInput, started.Goal.Revision+1)
}

func TestWorkspaceStoreConcurrentCompleteCyclePreservesUserScopedReplayContract(t *testing.T) {
	tests := []struct {
		name           string
		fixtureIndexes [2]int
		contentOffsets [2]int64
		wantSuccesses  int
		wantFresh      int
		wantReplayed   int
		wantKeyReuse   int
	}{
		{
			name:           "same request on the same Goal",
			fixtureIndexes: [2]int{0, 0},
			wantSuccesses:  2, wantFresh: 1, wantReplayed: 1,
		},
		{
			name:           "different canonical request on the same Goal",
			fixtureIndexes: [2]int{0, 0},
			contentOffsets: [2]int64{0, 1},
			wantSuccesses:  1, wantFresh: 1, wantKeyReuse: 1,
		},
		{
			name:           "same operation on different Goals",
			fixtureIndexes: [2]int{0, 1},
			wantSuccesses:  1, wantFresh: 1, wantKeyReuse: 1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := integrationPool(t)
			resetDatabase(t, pool)
			now := integrationNow()
			const (
				userID      = "10000000-0000-7000-8000-000000000001"
				operationID = "62000000-0000-7000-8000-000000000001"
			)
			if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
				t.Fatal(err)
			}

			seedStore := NewWorkspaceStore(pool)
			fixtures := progressingGoalFixtures()
			startedByFixture := make(map[int]workspace.StartGoalResult)
			for _, fixtureIndex := range test.fixtureIndexes {
				if _, exists := startedByFixture[fixtureIndex]; exists {
					continue
				}
				startedByFixture[fixtureIndex] = startProgressingGoal(
					t,
					seedStore,
					userID,
					fixtures[fixtureIndex],
					2,
					now.Add(time.Duration(fixtureIndex)*time.Minute),
				)
			}
			for fixtureIndex := range startedByFixture {
				if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',action='A',
content_revision=4,plan_revision=1,do_revision=1,check_revision=1,action_revision=1 WHERE id=$1`, fixtures[fixtureIndex].cycleID); err != nil {
					t.Fatal(err)
				}
			}

			barrier := newCompleteReplayBarrier()
			tracedConfig := pool.Config()
			tracedConfig.ConnConfig.Tracer = barrier
			tracedConfig.MinConns = 0
			tracedConfig.MaxConns = 2
			tracedPool, err := pgxpool.NewWithConfig(context.Background(), tracedConfig)
			if err != nil {
				t.Fatal(err)
			}
			defer tracedPool.Close()

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer func() {
				barrier.release()
				cancel()
			}()

			inputs := make([]workspace.CompleteCycleInput, 2)
			reviewDraftIDs := [2]string{
				"61000000-0000-7000-8000-000000000001",
				"61000000-0000-7000-8000-000000000002",
			}
			for attempt := range inputs {
				fixtureIndex := test.fixtureIndexes[attempt]
				fixture := fixtures[fixtureIndex]
				started := startedByFixture[fixtureIndex]
				inputs[attempt] = workspace.CompleteCycleInput{
					UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
					OperationID:             operationID,
					ExpectedGoalRevision:    started.Goal.Revision,
					ExpectedContentRevision: 4 + test.contentOffsets[attempt],
				}
			}

			store := NewWorkspaceStore(tracedPool)
			calls := make(chan concurrentCompleteCycleCall, 2)
			attemptStates := make([]*completeReplayAttemptTraceState, len(inputs))
			for attempt := range inputs {
				input := inputs[attempt]
				operationNow := now.Add(time.Duration(attempt+10) * time.Minute)
				reviewDraftID := reviewDraftIDs[attempt]
				state := newCompleteReplayAttemptTraceState(attempt == 0)
				attemptStates[attempt] = state
				attemptCtx := context.WithValue(ctx, completeReplayAttemptContextKey{}, state)
				go func() {
					result, callErr := executeCycleCompleteUseCase(store, attemptCtx, input, operationNow, reviewDraftID)
					calls <- concurrentCompleteCycleCall{input: input, reviewDraftID: reviewDraftID, result: result, err: callErr}
				}()
			}

			select {
			case <-barrier.initialLookupsDone:
			case traceErr := <-barrier.traceErrors:
				t.Fatalf("initial replay barrier: %v", traceErr)
			case call := <-calls:
				t.Fatalf("CompleteCycle returned before both initial replay lookups completed: input=%#v result=%#v error=%v", call.input, call.result, call.err)
			case <-ctx.Done():
				t.Fatalf("initial replay lookups did not reach the barrier: %v", ctx.Err())
			}
			select {
			case traceErr := <-barrier.traceErrors:
				t.Fatalf("initial replay barrier: %v", traceErr)
			default:
			}
			barrier.release()

			completedCalls := make([]concurrentCompleteCycleCall, 0, 2)
			for len(completedCalls) < 2 {
				select {
				case call := <-calls:
					completedCalls = append(completedCalls, call)
				case <-ctx.Done():
					t.Fatalf("CompleteCycle calls did not finish: %v", ctx.Err())
				}
			}
			select {
			case traceErr := <-barrier.traceErrors:
				t.Fatalf("initial replay barrier: %v", traceErr)
			default:
			}

			var postLockMisses, postLockHits int
			for attempt, state := range attemptStates {
				if lookups := state.lookupStarts.Load(); lookups != 2 {
					t.Fatalf("attempt %d replay lookup count = %d, want 2", attempt, lookups)
				}
				var observation completeReplayLookupObservation
				select {
				case observation = <-state.postLockLookup:
				case <-ctx.Done():
					t.Fatalf("attempt %d post-lock replay lookup was not observed: %v", attempt, ctx.Err())
				}
				if observation.err != nil {
					t.Fatalf("attempt %d post-lock replay lookup error = %v", attempt, observation.err)
				}
				if initialPID := state.initialPID.Load(); initialPID == 0 || observation.pid != initialPID {
					t.Fatalf("attempt %d replay lookup PIDs initial/post-lock = %d/%d, want the same transaction backend", attempt, initialPID, observation.pid)
				}
				switch observation.rowsAffected {
				case 0:
					postLockMisses++
				case 1:
					postLockHits++
				default:
					t.Fatalf("attempt %d post-lock replay lookup rows = %d, want 0 or 1", attempt, observation.rowsAffected)
				}
			}
			if postLockMisses != 1 || postLockHits != 1 {
				t.Fatalf("post-lock replay lookup misses/hits = %d/%d, want 1/1", postLockMisses, postLockHits)
			}

			var successes, fresh, replayed, keyReuse int
			var freshCall, replayCall concurrentCompleteCycleCall
			for _, call := range completedCalls {
				switch {
				case call.err == nil:
					successes++
					if call.result.Replay != nil {
						t.Fatalf("concurrent completion unexpectedly returned a current-workspace replay: %#v", call.result.Replay)
					}
					if call.result.Replayed {
						replayed++
						replayCall = call
					} else {
						fresh++
						freshCall = call
					}
				case errors.Is(call.err, workspace.ErrIdempotencyKeyReused):
					keyReuse++
				default:
					t.Fatalf("CompleteCycle error = %v, want success/replay or %v", call.err, workspace.ErrIdempotencyKeyReused)
				}
			}
			if successes != test.wantSuccesses || fresh != test.wantFresh || replayed != test.wantReplayed || keyReuse != test.wantKeyReuse {
				t.Fatalf("results success/fresh/replayed/key-reuse = %d/%d/%d/%d, want %d/%d/%d/%d; calls=%#v",
					successes, fresh, replayed, keyReuse,
					test.wantSuccesses, test.wantFresh, test.wantReplayed, test.wantKeyReuse, completedCalls)
			}

			if freshCall.result.Goal.ID != freshCall.input.GoalID ||
				freshCall.result.CompletedCycle.ID != freshCall.input.CycleID ||
				freshCall.result.ReviewDraft.ID != freshCall.reviewDraftID {
				t.Fatalf("fresh completion payload = goal %s, cycle %s, draft %s; input = %s/%s/%s",
					freshCall.result.Goal.ID, freshCall.result.CompletedCycle.ID, freshCall.result.ReviewDraft.ID,
					freshCall.input.GoalID, freshCall.input.CycleID, freshCall.reviewDraftID)
			}
			if test.wantReplayed == 1 {
				replayPayload := replayCall.result
				replayPayload.Replayed = false
				if !reflect.DeepEqual(replayPayload, freshCall.result) {
					t.Fatalf("replay payload = %#v, want winner payload %#v except replayed=true", replayCall.result, freshCall.result)
				}
			}

			var storedGoalID, storedCycleID, storedHash string
			if err = pool.QueryRow(ctx, `SELECT goal_id,id,completion_request_hash FROM pdca_cycles
WHERE user_id=$1 AND completion_operation_id=$2`, userID, operationID).Scan(&storedGoalID, &storedCycleID, &storedHash); err != nil {
				t.Fatal(err)
			}
			expectedHash := completeCycleCanonicalHashForTest(t, freshCall.input)
			if storedGoalID != freshCall.input.GoalID || storedCycleID != freshCall.input.CycleID || storedHash != expectedHash {
				t.Fatalf("stored completion = %s/%s/%s, fresh call target/hash = %s/%s/%s",
					storedGoalID, storedCycleID, storedHash,
					freshCall.input.GoalID, freshCall.input.CycleID, expectedHash)
			}
			var completedCycles, reviewGoals, reviewDrafts int
			if err = pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND completion_operation_id=$2),
(SELECT count(*) FROM goals WHERE user_id=$1 AND status='goal_review'),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND draft_type='review')`,
				userID, operationID).Scan(&completedCycles, &reviewGoals, &reviewDrafts); err != nil {
				t.Fatal(err)
			}
			if completedCycles != 1 || reviewGoals != 1 || reviewDrafts != 1 {
				t.Fatalf("committed completion/cycle-review/draft counts = %d/%d/%d, want 1/1/1", completedCycles, reviewGoals, reviewDrafts)
			}
		})
	}
}

func TestWorkspaceStoreTerminatePreservesUserScopedReplayContract(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID      = "10000000-0000-7000-8000-000000000001"
		operationID = "72000000-0000-7000-8000-000000000001"
	)
	if _, err := pool.Exec(context.Background(), "INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)", userID, now); err != nil {
		t.Fatal(err)
	}

	store := NewWorkspaceStore(pool)
	fixtures := progressingGoalFixtures()
	first := startProgressingGoal(t, store, userID, fixtures[0], 2, now)
	second := startProgressingGoal(t, store, userID, fixtures[1], 2, now.Add(time.Minute))
	cycleRevision := int64(0)
	firstInput := workspace.TerminateInput{
		UserID: userID, GoalID: fixtures[0].goalID,
		OperationID: operationID, Outcome: goal.StatusEnded,
		ExpectedGoalRevision: first.Goal.Revision, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: fixtures[0].cycleID, ExpectedCycleContentRevision: &cycleRevision,
		RequestHash: "first-goal-terminate-hash", Now: now.Add(10 * time.Minute),
	}
	result, err := executeTerminateGoalUseCase(store, context.Background(), firstInput)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replayed || result.Goal.ID != fixtures[0].goalID || result.Goal.Status != goal.StatusEnded {
		t.Fatalf("first terminate result = %#v", result)
	}
	replay, err := executeTerminateGoalUseCase(store, context.Background(), firstInput)
	if err != nil || !replay.Replayed || replay.Goal.ID != fixtures[0].goalID || replay.Goal.Status != goal.StatusEnded ||
		replay.CanceledCycle == nil || replay.CanceledCycle.ID != fixtures[0].cycleID ||
		replay.CanceledCycle.Status != cycle.StatusCanceled {
		t.Fatalf("same-request terminate replay = %#v, error = %v", replay, err)
	}
	differentHash := firstInput
	differentHash.Outcome = goal.StatusAchieved
	if _, err = executeTerminateGoalUseCase(store, context.Background(), differentHash); !errors.Is(err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("same-operation different-hash terminate error = %v, want %v", err, workspace.ErrIdempotencyKeyReused)
	}
	differentOperation := firstInput
	differentOperation.OperationID = "72000000-0000-7000-8000-000000000002"
	differentOperation.RequestHash = "different-operation-terminate-hash"
	if _, err = executeTerminateGoalUseCase(store, context.Background(), differentOperation); !errors.Is(err, workspace.ErrGoalAlreadyTerminal) {
		t.Fatalf("different-operation terminal Goal error = %v, want %v", err, workspace.ErrGoalAlreadyTerminal)
	}

	secondInput := workspace.TerminateInput{
		UserID: userID, GoalID: fixtures[1].goalID,
		OperationID: operationID, Outcome: goal.StatusAchieved,
		ExpectedGoalRevision: second.Goal.Revision, ExpectedState: goal.StatusActiveCycle,
		ActiveCycleID: fixtures[1].cycleID, ExpectedCycleContentRevision: &cycleRevision,
		RequestHash: "second-goal-terminate-hash", Now: now.Add(20 * time.Minute),
	}
	if _, err = executeTerminateGoalUseCase(store, context.Background(), secondInput); !errors.Is(err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("second Goal terminate error = %v, want %v", err, workspace.ErrIdempotencyKeyReused)
	}

	var (
		firstGoalStatus   goal.Status
		secondGoalStatus  goal.Status
		firstCycleStatus  cycle.Status
		secondCycleStatus cycle.Status
		terminalCount     int
	)
	if err = pool.QueryRow(context.Background(), "SELECT "+
		"(SELECT status FROM goals WHERE user_id=$1 AND id=$2),"+
		"(SELECT status FROM goals WHERE user_id=$1 AND id=$3),"+
		"(SELECT status FROM pdca_cycles WHERE user_id=$1 AND id=$4),"+
		"(SELECT status FROM pdca_cycles WHERE user_id=$1 AND id=$5),"+
		"(SELECT count(*) FROM goals WHERE user_id=$1 AND terminal_operation_id=$6)",
		userID, fixtures[0].goalID, fixtures[1].goalID, fixtures[0].cycleID, fixtures[1].cycleID, operationID).Scan(
		&firstGoalStatus,
		&secondGoalStatus,
		&firstCycleStatus,
		&secondCycleStatus,
		&terminalCount,
	); err != nil {
		t.Fatal(err)
	}
	if firstGoalStatus != goal.StatusEnded || secondGoalStatus != goal.StatusActiveCycle ||
		firstCycleStatus != cycle.StatusCanceled || secondCycleStatus != cycle.StatusActive || terminalCount != 1 {
		t.Fatalf("post-reuse states goals=%s/%s cycles=%s/%s terminal count=%d",
			firstGoalStatus, secondGoalStatus, firstCycleStatus, secondCycleStatus, terminalCount)
	}
}

func waitForBlockedBackend(ctx context.Context, pool *pgxpool.Pool, blockedPID, blockerPID uint32) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()

	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT cardinality(blockers)=1 AND $2=ANY(blockers)
FROM (SELECT pg_blocking_pids($1) AS blockers) observed`,
			int32(blockedPID), int32(blockerPID)).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func receiveCompleteCycleCall(t *testing.T, ctx context.Context, calls <-chan completeCycleCall) completeCycleCall {
	t.Helper()
	select {
	case call := <-calls:
		return call
	case <-ctx.Done():
		t.Fatalf("complete call did not finish: %v", ctx.Err())
		return completeCycleCall{}
	}
}

func receiveTerminateGoalCall(t *testing.T, ctx context.Context, calls <-chan terminateGoalCall) terminateGoalCall {
	t.Helper()
	select {
	case call := <-calls:
		return call
	case <-ctx.Done():
		t.Fatalf("terminate call did not finish: %v", ctx.Err())
		return terminateGoalCall{}
	}
}

func assertCompleteWonLockOrderRace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, completeInput workspace.CompleteCycleInput, expectedGoalRevision int64) {
	t.Helper()
	var (
		goalStatus          goal.Status
		goalRevision        int64
		terminalAt          *time.Time
		terminalOperationID *string
		terminalRequestHash *string
		cycleStatus         cycle.Status
		cycleCanceledAt     *time.Time
		cycleCancellation   *cycle.CancellationReason
		reviewDraftCount    int
	)
	err := pool.QueryRow(ctx, `SELECT g.status,g.revision,g.terminal_at,g.terminal_operation_id,g.terminal_request_hash,
c.status,c.canceled_at,c.cancellation_reason,
(SELECT count(*) FROM goal_drafts d WHERE d.user_id=g.user_id AND d.goal_id=g.id AND d.draft_type='review')
FROM goals g JOIN pdca_cycles c ON c.user_id=g.user_id AND c.goal_id=g.id
WHERE g.user_id=$1 AND g.id=$2 AND c.id=$3`, completeInput.UserID, completeInput.GoalID, completeInput.CycleID).Scan(
		&goalStatus, &goalRevision, &terminalAt, &terminalOperationID, &terminalRequestHash,
		&cycleStatus, &cycleCanceledAt, &cycleCancellation, &reviewDraftCount,
	)
	if err != nil {
		t.Fatal(err)
	}
	if goalStatus != goal.StatusGoalReview || goalRevision != expectedGoalRevision {
		t.Fatalf("goal state/revision = %s/%d, want %s/%d", goalStatus, goalRevision, goal.StatusGoalReview, expectedGoalRevision)
	}
	if terminalAt != nil || terminalOperationID != nil || terminalRequestHash != nil {
		t.Fatalf("terminate partially mutated goal: terminalAt=%v operation=%v hash=%v", terminalAt, terminalOperationID, terminalRequestHash)
	}
	if cycleStatus != cycle.StatusCompleted || cycleCanceledAt != nil || cycleCancellation != nil {
		t.Fatalf("cycle state = %s, canceledAt=%v cancellation=%v", cycleStatus, cycleCanceledAt, cycleCancellation)
	}
	if reviewDraftCount != 1 {
		t.Fatalf("review draft count = %d, want 1", reviewDraftCount)
	}
}
