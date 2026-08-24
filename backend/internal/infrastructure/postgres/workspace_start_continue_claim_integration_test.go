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

type startContinueClaimCall struct {
	command        reviewTransitionRaceCommand
	startResult    workspace.StartGoalResult
	continueResult workspace.ContinueReviewResult
	err            error
}

type startContinueClaimFixture struct {
	pool            *pgxpool.Pool
	store           *WorkspaceStore
	barrier         *reviewTransitionRaceBarrier
	ctx             context.Context
	userID          string
	reviewGoalID    string
	reviewDraftID   string
	reviewDraftBody string
	review          workspace.CompleteCycleResult
	creationDraft   workspace.DraftView
	startInput      workspace.StartGoalInput
	continueInput   workspace.ContinueReviewInput
}

func newStartContinueClaimFixture(
	t *testing.T,
	winner reviewTransitionRaceCommand,
) startContinueClaimFixture {
	t.Helper()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID          = "10000000-0000-7000-8000-000000000001"
		reviewDraftID   = "61000000-0000-7000-8000-000000000501"
		creationDraftID = "11000000-0000-7000-8000-000000000501"
		reviewDraftBody = "changed review body written before the shared Cycle claim"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	seedStore := NewWorkspaceStore(pool)
	reviewGoal := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, seedStore, userID, reviewGoal, 2,
		reviewDraftID, "71000000-0000-7000-8000-000000000501", now)
	command, err := pool.Exec(context.Background(), `UPDATE goal_drafts
SET body=$3,revision=revision+1,updated_at=$4
WHERE id=$1 AND user_id=$2 AND draft_type='review'`,
		reviewDraftID, userID, reviewDraftBody, now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if command.RowsAffected() != 1 {
		t.Fatalf("changed Review Draft rows = %d, want 1", command.RowsAffected())
	}
	creationDraft, err := executeGoalDraftCreateUseCase(
		seedStore, context.Background(), userID, creationDraftID,
		"creation Draft competing for the shared Cycle claim", now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}

	barrier := newReviewTransitionRaceBarrierAtQuery(winner, isContinueClaimQuery)
	store, tracedPool := newReviewTransitionRaceStore(t, pool, barrier)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(func() {
		barrier.release()
		cancel()
		tracedPool.Close()
	})
	const operationID = "72000000-0000-7000-8000-000000000501"
	return startContinueClaimFixture{
		pool:            pool,
		store:           store,
		barrier:         barrier,
		ctx:             ctx,
		userID:          userID,
		reviewGoalID:    reviewGoal.goalID,
		reviewDraftID:   reviewDraftID,
		reviewDraftBody: reviewDraftBody,
		review:          review,
		creationDraft:   creationDraft,
		startInput: workspace.StartGoalInput{
			UserID: userID, DraftID: creationDraftID, OperationID: operationID,
			ExpectedDraftRevision: creationDraft.Revision,
			GoalID:                "22000000-0000-7000-8000-000000000501",
			VersionID:             "32000000-0000-7000-8000-000000000501",
			CycleID:               "42000000-0000-7000-8000-000000000501",
			Now:                   now.Add(4 * time.Minute),
		},
		continueInput: workspace.ContinueReviewInput{
			UserID: userID, GoalID: reviewGoal.goalID, OperationID: operationID,
			ExpectedGoalRevision:  review.Goal.Revision,
			ExpectedDraftRevision: review.ReviewDraft.Revision + 1,
			VersionID:             "51000000-0000-7000-8000-000000000501",
			CycleID:               "41000000-0000-7000-8000-000000000501",
			Now:                   now.Add(4 * time.Minute),
		},
	}
}

func startSharedCycleClaimCall(
	fixture startContinueClaimFixture,
	command reviewTransitionRaceCommand,
) <-chan startContinueClaimCall {
	calls := make(chan startContinueClaimCall, 1)
	callCtx := context.WithValue(fixture.ctx, reviewTransitionRaceContextKey{}, command)
	go func() {
		call := startContinueClaimCall{command: command}
		switch command {
		case reviewTransitionRaceStart:
			call.startResult, call.err = executeGoalStartUseCase(
				fixture.store, callCtx, fixture.startInput, 2)
		case reviewTransitionRaceContinue:
			call.continueResult, call.err = executeContinueReviewUseCase(
				fixture.store, callCtx, fixture.continueInput)
		}
		calls <- call
	}()
	return calls
}

func runStartContinueClaimRace(
	t *testing.T,
	winnerCommand reviewTransitionRaceCommand,
) (startContinueClaimFixture, startContinueClaimCall, startContinueClaimCall) {
	t.Helper()
	fixture := newStartContinueClaimFixture(t, winnerCommand)
	winnerCalls := startSharedCycleClaimCall(fixture, winnerCommand)
	var winnerLock reviewTransitionRaceLock
	select {
	case winnerLock = <-fixture.barrier.winnerLocked:
		if winnerLock.err != nil {
			t.Fatalf("winner Cycle claim error = %v", winnerLock.err)
		}
	case call := <-winnerCalls:
		t.Fatalf("winner returned before holding Cycle claim: %#v", call)
	case <-fixture.ctx.Done():
		t.Fatalf("winner did not acquire Cycle claim: %v", fixture.ctx.Err())
	}

	loserCommand := reviewTransitionRaceStart
	if winnerCommand == reviewTransitionRaceStart {
		loserCommand = reviewTransitionRaceContinue
	}
	loserCalls := startSharedCycleClaimCall(fixture, loserCommand)
	var loserPID uint32
	select {
	case loserPID = <-fixture.barrier.loserLockStart:
	case call := <-loserCalls:
		t.Fatalf("loser returned before waiting for Cycle claim: %#v", call)
	case <-fixture.ctx.Done():
		t.Fatalf("loser did not reach Cycle claim: %v", fixture.ctx.Err())
	}
	if err := waitForBlockedBackend(fixture.ctx, fixture.pool, loserPID, winnerLock.pid); err != nil {
		t.Fatalf("backend %d did not wait for shared Cycle-claim winner %d: %v",
			loserPID, winnerLock.pid, err)
	}
	fixture.barrier.release()

	var winner, loser startContinueClaimCall
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

type startContinueClaimState struct {
	operationReceipts int
	startGoals        int
	startVersions     int
	startCycles       int
	creationDrafts    int

	reviewStatus        string
	reviewRevision      int64
	reviewVersionNumber int32
	reviewDrafts        int
	reviewVersions      int
	continueVersions    int
	reviewCycles        int
	continueCycles      int
	reviewDraftBody     string
	reviewDraftRevision int64
}

func loadStartContinueClaimState(
	t *testing.T,
	fixture startContinueClaimFixture,
) startContinueClaimState {
	t.Helper()
	var state startContinueClaimState
	if err := fixture.pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND start_operation_id=$2),
(SELECT count(*) FROM goals WHERE user_id=$1 AND id=$3),
(SELECT count(*) FROM goal_versions WHERE user_id=$1 AND id=$4),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND id=$5),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND id=$6),
g.status::text,g.revision,g.current_version_number,
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND goal_id=$7),
(SELECT count(*) FROM goal_versions WHERE user_id=$1 AND goal_id=$7),
(SELECT count(*) FROM goal_versions WHERE user_id=$1 AND id=$8),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND goal_id=$7),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND id=$9),
COALESCE((SELECT body FROM goal_drafts WHERE user_id=$1 AND goal_id=$7),''),
COALESCE((SELECT revision FROM goal_drafts WHERE user_id=$1 AND goal_id=$7),-1)
FROM goals g WHERE g.user_id=$1 AND g.id=$7`,
		fixture.userID, fixture.startInput.OperationID, fixture.startInput.GoalID,
		fixture.startInput.VersionID, fixture.startInput.CycleID, fixture.startInput.DraftID,
		fixture.reviewGoalID, fixture.continueInput.VersionID, fixture.continueInput.CycleID).Scan(
		&state.operationReceipts, &state.startGoals, &state.startVersions,
		&state.startCycles, &state.creationDrafts, &state.reviewStatus,
		&state.reviewRevision, &state.reviewVersionNumber, &state.reviewDrafts,
		&state.reviewVersions, &state.continueVersions, &state.reviewCycles,
		&state.continueCycles, &state.reviewDraftBody, &state.reviewDraftRevision); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestStartAndContinueSharedCycleClaimStartWins(t *testing.T) {
	fixture, winner, loser := runStartContinueClaimRace(t, reviewTransitionRaceStart)
	if winner.command != reviewTransitionRaceStart || winner.err != nil ||
		winner.startResult.Replayed ||
		winner.startResult.Goal.ID != fixture.startInput.GoalID ||
		winner.startResult.Goal.Status != goal.StatusActiveCycle ||
		winner.startResult.Cycle.ID != fixture.startInput.CycleID ||
		winner.startResult.Cycle.Status != cycle.StatusActive {
		t.Fatalf("winning Start = %#v", winner)
	}
	if loser.command != reviewTransitionRaceContinue ||
		!errors.Is(loser.err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("losing Continue = %#v, want %v", loser, workspace.ErrIdempotencyKeyReused)
	}
	state := loadStartContinueClaimState(t, fixture)
	if state.operationReceipts != 1 || state.startGoals != 1 ||
		state.startVersions != 1 || state.startCycles != 1 ||
		state.creationDrafts != 0 ||
		state.reviewStatus != string(goal.StatusGoalReview) ||
		state.reviewRevision != fixture.review.Goal.Revision ||
		state.reviewVersionNumber != fixture.review.Goal.CurrentVersion.VersionNumber ||
		state.reviewDrafts != 1 || state.reviewVersions != 1 ||
		state.continueVersions != 0 || state.reviewCycles != 1 ||
		state.continueCycles != 0 ||
		state.reviewDraftBody != fixture.reviewDraftBody ||
		state.reviewDraftRevision != fixture.continueInput.ExpectedDraftRevision {
		t.Fatalf("Start-won shared claim state = %#v", state)
	}
}

func TestStartAndContinueSharedCycleClaimContinueWins(t *testing.T) {
	fixture, winner, loser := runStartContinueClaimRace(t, reviewTransitionRaceContinue)
	if winner.command != reviewTransitionRaceContinue || winner.err != nil ||
		winner.continueResult.Replayed || !winner.continueResult.VersionCreated ||
		winner.continueResult.Goal.Status != goal.StatusActiveCycle ||
		winner.continueResult.Goal.CurrentVersion.ID != fixture.continueInput.VersionID ||
		winner.continueResult.Cycle.ID != fixture.continueInput.CycleID ||
		winner.continueResult.Cycle.Status != cycle.StatusActive {
		t.Fatalf("winning Continue = %#v", winner)
	}
	if loser.command != reviewTransitionRaceStart ||
		!errors.Is(loser.err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("losing Start = %#v, want %v", loser, workspace.ErrIdempotencyKeyReused)
	}
	state := loadStartContinueClaimState(t, fixture)
	if state.operationReceipts != 1 || state.startGoals != 0 ||
		state.startVersions != 0 || state.startCycles != 0 ||
		state.creationDrafts != 1 ||
		state.reviewStatus != string(goal.StatusActiveCycle) ||
		state.reviewRevision != fixture.review.Goal.Revision+1 ||
		state.reviewVersionNumber != fixture.review.Goal.CurrentVersion.VersionNumber+1 ||
		state.reviewDrafts != 0 || state.reviewVersions != 2 ||
		state.continueVersions != 1 || state.reviewCycles != 2 ||
		state.continueCycles != 1 || state.reviewDraftBody != "" ||
		state.reviewDraftRevision != -1 {
		t.Fatalf("Continue-won shared claim state = %#v", state)
	}
}
