package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type reviewTransitionRaceCall struct {
	command         reviewTransitionRaceCommand
	continueResult  workspace.ContinueReviewResult
	terminateResult workspace.TerminateResult
	err             error
}

type continueTerminateRaceFixture struct {
	pool           *pgxpool.Pool
	store          *WorkspaceStore
	barrier        *reviewTransitionRaceBarrier
	ctx            context.Context
	userID         string
	goalID         string
	review         workspace.CompleteCycleResult
	continueInput  workspace.ContinueReviewInput
	terminateInput workspace.TerminateInput
}

func newContinueTerminateRaceFixture(
	t *testing.T,
	winner reviewTransitionRaceCommand,
) continueTerminateRaceFixture {
	t.Helper()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	seedStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, seedStore, userID, fixture, 2,
		"61000000-0000-7000-8000-000000000401",
		"71000000-0000-7000-8000-000000000401", now)
	barrier := newReviewTransitionRaceBarrier(winner)
	store, tracedPool := newReviewTransitionRaceStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(func() {
		barrier.release()
		cancel()
		tracedPool.Close()
	})
	return continueTerminateRaceFixture{
		pool:    pool,
		store:   store,
		barrier: barrier,
		ctx:     ctx,
		userID:  userID,
		goalID:  fixture.goalID,
		review:  review,
		continueInput: workspace.ContinueReviewInput{
			UserID: userID, GoalID: fixture.goalID,
			OperationID:           "72000000-0000-7000-8000-000000000401",
			ExpectedGoalRevision:  review.Goal.Revision,
			ExpectedDraftRevision: review.ReviewDraft.Revision,
			CycleID:               "41000000-0000-7000-8000-000000000401",
			Now:                   now.Add(3 * time.Minute),
		},
		terminateInput: workspace.TerminateInput{
			UserID: userID, GoalID: fixture.goalID,
			OperationID: "73000000-0000-7000-8000-000000000401",
			Outcome:     goal.StatusEnded, ExpectedGoalRevision: review.Goal.Revision,
			ExpectedState: goal.StatusGoalReview, Now: now.Add(4 * time.Minute),
		},
	}
}

func startReviewTransitionRaceCall(
	fixture continueTerminateRaceFixture,
	command reviewTransitionRaceCommand,
) <-chan reviewTransitionRaceCall {
	calls := make(chan reviewTransitionRaceCall, 1)
	callCtx := context.WithValue(fixture.ctx, reviewTransitionRaceContextKey{}, command)
	go func() {
		call := reviewTransitionRaceCall{command: command}
		switch command {
		case reviewTransitionRaceContinue:
			call.continueResult, call.err = executeContinueReviewUseCase(
				fixture.store, callCtx, fixture.continueInput)
		case reviewTransitionRaceTerminate:
			call.terminateResult, call.err = executeTerminateGoalUseCase(
				fixture.store, callCtx, fixture.terminateInput)
		}
		calls <- call
	}()
	return calls
}

func runContinueTerminateRace(
	t *testing.T,
	winnerCommand reviewTransitionRaceCommand,
) (continueTerminateRaceFixture, reviewTransitionRaceCall, reviewTransitionRaceCall) {
	t.Helper()
	fixture := newContinueTerminateRaceFixture(t, winnerCommand)
	winnerCalls := startReviewTransitionRaceCall(fixture, winnerCommand)
	var winnerLock reviewTransitionRaceLock
	select {
	case winnerLock = <-fixture.barrier.winnerLocked:
		if winnerLock.err != nil {
			t.Fatalf("winner Goal lock error = %v", winnerLock.err)
		}
	case call := <-winnerCalls:
		t.Fatalf("winner returned before holding Goal lock: %#v", call)
	case <-fixture.ctx.Done():
		t.Fatalf("winner did not acquire Goal lock: %v", fixture.ctx.Err())
	}

	loserCommand := reviewTransitionRaceContinue
	if winnerCommand == reviewTransitionRaceContinue {
		loserCommand = reviewTransitionRaceTerminate
	}
	loserCalls := startReviewTransitionRaceCall(fixture, loserCommand)
	var loserPID uint32
	select {
	case loserPID = <-fixture.barrier.loserLockStart:
	case call := <-loserCalls:
		t.Fatalf("loser returned before waiting for Goal lock: %#v", call)
	case <-fixture.ctx.Done():
		t.Fatalf("loser did not reach Goal lock: %v", fixture.ctx.Err())
	}
	if err := waitForBlockedBackend(fixture.ctx, fixture.pool, loserPID, winnerLock.pid); err != nil {
		t.Fatalf("backend %d did not wait for Goal-lock winner %d: %v", loserPID, winnerLock.pid, err)
	}
	fixture.barrier.release()

	var winner, loser reviewTransitionRaceCall
	select {
	case winner = <-winnerCalls:
	case <-fixture.ctx.Done():
		t.Fatalf("winner did not finish: %v", fixture.ctx.Err())
	}
	select {
	case loser = <-loserCalls:
	case <-fixture.ctx.Done():
		t.Fatalf("loser did not finish: %v", fixture.ctx.Err())
	}
	return fixture, winner, loser
}

type reviewTransitionRaceState struct {
	status               string
	revision             int64
	terminalOperationID  string
	draftCount           int
	versionCount         int
	cycleCount           int
	activeCycleCount     int
	completedCycleCount  int
	continueReceiptCount int
}

func loadReviewTransitionRaceState(
	t *testing.T,
	fixture continueTerminateRaceFixture,
) reviewTransitionRaceState {
	t.Helper()
	var state reviewTransitionRaceState
	if err := fixture.pool.QueryRow(context.Background(), `SELECT
g.status::text,g.revision,COALESCE(g.terminal_operation_id::text,''),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM goal_versions WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND goal_id=$2 AND status='active'),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND goal_id=$2 AND status='completed'),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND start_operation_id=$3)
FROM goals g WHERE g.user_id=$1 AND g.id=$2`,
		fixture.userID, fixture.goalID, fixture.continueInput.OperationID).Scan(
		&state.status, &state.revision, &state.terminalOperationID,
		&state.draftCount, &state.versionCount, &state.cycleCount,
		&state.activeCycleCount, &state.completedCycleCount, &state.continueReceiptCount); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestReviewTransitionContinueWinsGoalLockAgainstTerminate(t *testing.T) {
	fixture, winner, loser := runContinueTerminateRace(t, reviewTransitionRaceContinue)
	if winner.command != reviewTransitionRaceContinue || winner.err != nil ||
		winner.continueResult.Replayed || winner.continueResult.VersionCreated ||
		winner.continueResult.Goal.Status != goal.StatusActiveCycle ||
		winner.continueResult.Cycle.ID != fixture.continueInput.CycleID ||
		winner.continueResult.Cycle.Status != cycle.StatusActive {
		t.Fatalf("winning Continue = %#v", winner)
	}
	if loser.command != reviewTransitionRaceTerminate ||
		!errors.Is(loser.err, workspace.ErrGoalStateConflict) {
		t.Fatalf("blocked Terminate = %#v, want %v", loser, workspace.ErrGoalStateConflict)
	}

	state := loadReviewTransitionRaceState(t, fixture)
	if state.status != string(goal.StatusActiveCycle) ||
		state.revision != fixture.review.Goal.Revision+1 ||
		state.terminalOperationID != "" || state.draftCount != 0 ||
		state.versionCount != 1 || state.cycleCount != 2 ||
		state.activeCycleCount != 1 || state.completedCycleCount != 1 ||
		state.continueReceiptCount != 1 {
		t.Fatalf("Continue-won state = %#v", state)
	}
}

func TestReviewTransitionTerminateWinsGoalLockAgainstContinue(t *testing.T) {
	fixture, winner, loser := runContinueTerminateRace(t, reviewTransitionRaceTerminate)
	if winner.command != reviewTransitionRaceTerminate || winner.err != nil ||
		winner.terminateResult.Replayed ||
		winner.terminateResult.Goal.Status != goal.StatusEnded ||
		winner.terminateResult.CanceledCycle != nil {
		t.Fatalf("winning Terminate = %#v", winner)
	}
	if loser.command != reviewTransitionRaceContinue ||
		!errors.Is(loser.err, workspace.ErrGoalReviewNotActive) {
		t.Fatalf("blocked Continue = %#v, want %v", loser, workspace.ErrGoalReviewNotActive)
	}

	state := loadReviewTransitionRaceState(t, fixture)
	if state.status != string(goal.StatusEnded) ||
		state.revision != fixture.review.Goal.Revision+1 ||
		state.terminalOperationID != fixture.terminateInput.OperationID ||
		state.draftCount != 0 || state.versionCount != 1 ||
		state.cycleCount != 1 || state.activeCycleCount != 0 ||
		state.completedCycleCount != 1 || state.continueReceiptCount != 0 {
		t.Fatalf("Terminate-won state = %#v", state)
	}
}
