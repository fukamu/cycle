package postgres

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type completeReplayContinueCommandContextKey struct{}

type completeReplayContinueQueryContextKey struct{}

type completeReplayContinueCommand uint8

const (
	completeReplayCommand completeReplayContinueCommand = iota + 1
	continueReviewCommand
)

type completeReplayContinueQuery struct {
	pid uint32
}

type completeReplayContinueBarrier struct {
	replayAfterGoalView chan uint32
	releaseReplay       chan struct{}
	continuePID         chan uint32

	replayOnce   sync.Once
	releaseOnce  sync.Once
	continueOnce sync.Once
}

func newCompleteReplayContinueBarrier() *completeReplayContinueBarrier {
	return &completeReplayContinueBarrier{
		replayAfterGoalView: make(chan uint32, 1),
		releaseReplay:       make(chan struct{}),
		continuePID:         make(chan uint32, 1),
	}
}

func (barrier *completeReplayContinueBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch ctx.Value(completeReplayContinueCommandContextKey{}) {
	case completeReplayCommand:
		if isGoalViewLookupQuery(data.SQL) {
			return context.WithValue(ctx, completeReplayContinueQueryContextKey{}, completeReplayContinueQuery{
				pid: connection.PgConn().PID(),
			})
		}
	case continueReviewCommand:
		barrier.continueOnce.Do(func() {
			barrier.continuePID <- connection.PgConn().PID()
		})
	}
	return ctx
}

func (barrier *completeReplayContinueBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	query, ok := ctx.Value(completeReplayContinueQueryContextKey{}).(completeReplayContinueQuery)
	if !ok {
		return
	}
	barrier.replayOnce.Do(func() {
		barrier.replayAfterGoalView <- query.pid
	})
	select {
	case <-barrier.releaseReplay:
	case <-ctx.Done():
	}
}

func (barrier *completeReplayContinueBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseReplay) })
}

func isGoalViewLookupQuery(sql string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(sql), " "))
	return strings.Contains(normalized, "from goals g left join goal_versions gv on gv.goal_id=g.id and gv.version_number=g.current_version_number") &&
		strings.Contains(normalized, "where g.id=$1 and g.user_id=$2")
}

type continueReviewCall struct {
	result workspace.ContinueReviewResult
	err    error
}

func TestWorkspaceStoreCompleteReplaySerializesWithContinueReview(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}

	settings := WorkspaceStoreSettings{}
	seedStore := NewWorkspaceStore(pool, settings)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, seedStore, userID, fixture, 2, now)
	if _, err := pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan='P',do_text='D',check_text='C',action='A',
content_revision=4,plan_revision=1,do_revision=1,check_revision=1,action_revision=1 WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}

	completeInput := workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		ReviewDraftID:        "61000000-0000-7000-8000-000000000001",
		OperationID:          "62000000-0000-7000-8000-000000000001",
		ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		RequestHash: "complete-replay-continue-hash", Now: now.Add(time.Minute),
	}
	completed, err := executeCycleCompleteUseCase(seedStore, context.Background(), completeInput)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Replayed || completed.Goal.Status != goal.StatusGoalReview {
		t.Fatalf("initial complete result = %#v", completed)
	}

	barrier := newCompleteReplayContinueBarrier()
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
	store := NewWorkspaceStore(tracedPool, settings)

	replayCalls := make(chan completeCycleCall, 1)
	replayCtx := context.WithValue(ctx, completeReplayContinueCommandContextKey{}, completeReplayCommand)
	go func() {
		result, callErr := executeCycleCompleteUseCase(store, replayCtx, completeInput)
		replayCalls <- completeCycleCall{result: result, err: callErr}
	}()

	var replayPID uint32
	select {
	case replayPID = <-barrier.replayAfterGoalView:
	case call := <-replayCalls:
		t.Fatalf("Complete replay returned before the Goal view barrier: result=%#v error=%v", call.result, call.err)
	case <-ctx.Done():
		t.Fatalf("Complete replay did not reach the Goal view barrier: %v", ctx.Err())
	}

	continueInput := workspace.ContinueReviewInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID:          "63000000-0000-7000-8000-000000000001",
		ExpectedGoalRevision: completed.Goal.Revision, ExpectedDraftRevision: 0,
		RequestHash: "continue-after-complete-replay-hash",
		VersionID:   "64000000-0000-7000-8000-000000000001",
		CycleID:     "65000000-0000-7000-8000-000000000001",
		Now:         now.Add(2 * time.Minute),
	}
	continueCalls := make(chan continueReviewCall, 1)
	continueCtx := context.WithValue(ctx, completeReplayContinueCommandContextKey{}, continueReviewCommand)
	go func() {
		result, callErr := store.ContinueReview(continueCtx, continueInput)
		continueCalls <- continueReviewCall{result: result, err: callErr}
	}()

	var continuePID uint32
	select {
	case continuePID = <-barrier.continuePID:
	case call := <-continueCalls:
		t.Fatalf("Continue returned before issuing a traced query: result=%#v error=%v", call.result, call.err)
	case <-ctx.Done():
		t.Fatalf("Continue did not issue a traced query: %v", ctx.Err())
	}
	blocked := make(chan error, 1)
	go func() {
		blocked <- waitForBlockedBackend(ctx, pool, continuePID, replayPID)
	}()
	select {
	case call := <-continueCalls:
		t.Fatalf("Continue completed before the replay released its Goal lock: result=%#v error=%v", call.result, call.err)
	case blockErr := <-blocked:
		if blockErr != nil {
			t.Fatalf("Continue did not wait for the replay Goal lock: %v", blockErr)
		}
	case <-ctx.Done():
		t.Fatalf("Continue blocking state was not observed: %v", ctx.Err())
	}

	barrier.release()
	replayCall := receiveCompleteCycleCall(t, ctx, replayCalls)
	if replayCall.err != nil || !replayCall.result.Replayed || replayCall.result.Replay != nil {
		t.Fatalf("Complete replay = %#v, error = %v", replayCall.result, replayCall.err)
	}
	if replayCall.result.Goal.Status != goal.StatusGoalReview ||
		replayCall.result.CompletedCycle.Status != cycle.StatusCompleted ||
		replayCall.result.ReviewDraft.ID != completeInput.ReviewDraftID {
		t.Fatalf("Complete replay payload = %#v", replayCall.result)
	}

	var continueCall continueReviewCall
	select {
	case continueCall = <-continueCalls:
	case <-ctx.Done():
		t.Fatalf("Continue did not finish after replay release: %v", ctx.Err())
	}
	if continueCall.err != nil {
		t.Fatal(continueCall.err)
	}
	if continueCall.result.Goal.Status != goal.StatusActiveCycle || continueCall.result.Cycle.ID != continueInput.CycleID {
		t.Fatalf("Continue result = %#v", continueCall.result)
	}

	var goalStatus goal.Status
	var completedStatus, nextStatus cycle.Status
	var reviewDraftCount int
	err = pool.QueryRow(ctx, `SELECT g.status,completed.status,next.status,
(SELECT count(*) FROM goal_drafts d WHERE d.user_id=g.user_id AND d.goal_id=g.id AND d.draft_type='review')
FROM goals g
JOIN pdca_cycles completed ON completed.user_id=g.user_id AND completed.goal_id=g.id AND completed.id=$3
JOIN pdca_cycles next ON next.user_id=g.user_id AND next.goal_id=g.id AND next.id=$4
WHERE g.user_id=$1 AND g.id=$2`,
		userID, fixture.goalID, fixture.cycleID, continueInput.CycleID).Scan(
		&goalStatus, &completedStatus, &nextStatus, &reviewDraftCount,
	)
	if err != nil {
		t.Fatal(err)
	}
	if goalStatus != goal.StatusActiveCycle || completedStatus != cycle.StatusCompleted ||
		nextStatus != cycle.StatusActive || reviewDraftCount != 0 {
		t.Fatalf("final state goal=%s completed=%s next=%s review drafts=%d",
			goalStatus, completedStatus, nextStatus, reviewDraftCount)
	}
}
