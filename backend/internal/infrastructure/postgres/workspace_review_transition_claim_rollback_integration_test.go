package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type continueClaimRollbackCall struct {
	input  workspace.ContinueReviewInput
	result workspace.ContinueReviewResult
	err    error
}

func TestReviewTransitionContinueRollsBackChangedVersionAfterLosingDifferentGoalClaim(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
	fixtures := progressingGoalFixtures()
	first := prepareReviewTransitionReview(t, store, userID, fixtures[0], 2,
		"61000000-0000-7000-8000-000000000251",
		"71000000-0000-7000-8000-000000000251", now)
	second := prepareReviewTransitionReview(t, store, userID, fixtures[1], 2,
		"61000000-0000-7000-8000-000000000252",
		"71000000-0000-7000-8000-000000000252", now.Add(time.Minute))
	reviews := map[string]workspace.CompleteCycleResult{
		fixtures[0].goalID: first,
		fixtures[1].goalID: second,
	}
	draftIDs := map[string]string{
		fixtures[0].goalID: "61000000-0000-7000-8000-000000000251",
		fixtures[1].goalID: "61000000-0000-7000-8000-000000000252",
	}
	draftBodies := map[string]string{
		fixtures[0].goalID: "first changed body inserted before the Cycle claim",
		fixtures[1].goalID: "second changed body inserted before the Cycle claim",
	}
	for _, fixture := range fixtures[:2] {
		command, err := pool.Exec(context.Background(), `UPDATE goal_drafts
SET body=$3,revision=revision+1,updated_at=$4
WHERE id=$1 AND user_id=$2 AND draft_type='review'`,
			draftIDs[fixture.goalID], userID, draftBodies[fixture.goalID], now.Add(3*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if command.RowsAffected() != 1 {
			t.Fatalf("changed Review Draft %s rows = %d, want 1", fixture.goalID, command.RowsAffected())
		}
	}

	const operationID = "72000000-0000-7000-8000-000000000251"
	inputs := []workspace.ContinueReviewInput{
		{UserID: userID, GoalID: fixtures[0].goalID, OperationID: operationID,
			ExpectedGoalRevision: first.Goal.Revision, ExpectedDraftRevision: first.ReviewDraft.Revision + 1,
			VersionID: "51000000-0000-7000-8000-000000000251",
			CycleID:   "41000000-0000-7000-8000-000000000251", Now: now.Add(4 * time.Minute)},
		{UserID: userID, GoalID: fixtures[1].goalID, OperationID: operationID,
			ExpectedGoalRevision: second.Goal.Revision, ExpectedDraftRevision: second.ReviewDraft.Revision + 1,
			VersionID: "51000000-0000-7000-8000-000000000252",
			CycleID:   "41000000-0000-7000-8000-000000000252", Now: now.Add(4 * time.Minute)},
	}
	barrier := newContinueContentionBarrier(isContinueClaimQuery)
	store, tracedPool := newContinueContentionStore(t, pool, barrier)
	defer tracedPool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer func() {
		barrier.releaseInitialLookups()
		barrier.releaseLeaderQuery()
		cancel()
	}()
	calls := make(chan continueClaimRollbackCall, 2)
	for _, input := range inputs {
		input := input
		attemptCtx := context.WithValue(ctx, continueContentionContextKey{}, &continueContentionAttempt{})
		go func() {
			result, err := executeContinueReviewUseCase(store, attemptCtx, input)
			calls <- continueClaimRollbackCall{input: input, result: result, err: err}
		}()
	}
	waitForContinueContention(t, ctx, pool, barrier)

	var winnerInput, loserInput workspace.ContinueReviewInput
	for range 2 {
		call := <-calls
		switch {
		case call.err == nil:
			winnerInput = call.input
			if !call.result.VersionCreated ||
				call.result.Goal.CurrentVersion.ID != call.input.VersionID ||
				call.result.Cycle.ID != call.input.CycleID {
				t.Fatalf("winning changed Continue = %#v", call)
			}
		case errors.Is(call.err, workspace.ErrIdempotencyKeyReused):
			loserInput = call.input
		default:
			t.Fatalf("changed different-Goal Continue = %#v", call)
		}
	}
	if winnerInput.GoalID == "" || loserInput.GoalID == "" ||
		winnerInput.GoalID == loserInput.GoalID {
		t.Fatalf("winner/loser Goal IDs = %q/%q, want distinct", winnerInput.GoalID, loserInput.GoalID)
	}

	var operationCycles int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pdca_cycles
WHERE user_id=$1 AND start_operation_id=$2`, userID, operationID).Scan(&operationCycles); err != nil {
		t.Fatal(err)
	}
	if operationCycles != 1 {
		t.Fatalf("operation Cycle receipts = %d, want 1", operationCycles)
	}
	for _, input := range inputs {
		review := reviews[input.GoalID]
		var status, draftBody string
		var revision, draftRevision int64
		var currentVersionNumber int32
		var draftCount, versionCount, candidateVersionCount, candidateCycleCount int
		if err := pool.QueryRow(context.Background(), `SELECT
g.status::text,g.revision,g.current_version_number,
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM goal_versions WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM goal_versions WHERE user_id=$1 AND goal_id=$2 AND id=$3),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND goal_id=$2 AND id=$4),
COALESCE((SELECT body FROM goal_drafts WHERE user_id=$1 AND goal_id=$2),''),
COALESCE((SELECT revision FROM goal_drafts WHERE user_id=$1 AND goal_id=$2),-1)
FROM goals g WHERE g.user_id=$1 AND g.id=$2`,
			userID, input.GoalID, input.VersionID, input.CycleID).Scan(
			&status, &revision, &currentVersionNumber, &draftCount, &versionCount,
			&candidateVersionCount, &candidateCycleCount, &draftBody, &draftRevision); err != nil {
			t.Fatal(err)
		}
		if input.GoalID == winnerInput.GoalID {
			if status != string(goal.StatusActiveCycle) || revision != review.Goal.Revision+1 ||
				currentVersionNumber != review.Goal.CurrentVersion.VersionNumber+1 ||
				draftCount != 0 || versionCount != 2 || candidateVersionCount != 1 ||
				candidateCycleCount != 1 || draftBody != "" || draftRevision != -1 {
				t.Fatalf("winning claim state for %s = %s/%d/%d Draft %d Version %d/%d Cycle %d body/revision %q/%d",
					input.GoalID, status, revision, currentVersionNumber, draftCount, versionCount,
					candidateVersionCount, candidateCycleCount, draftBody, draftRevision)
			}
			continue
		}
		if input.GoalID != loserInput.GoalID ||
			status != string(goal.StatusGoalReview) || revision != review.Goal.Revision ||
			currentVersionNumber != review.Goal.CurrentVersion.VersionNumber ||
			draftCount != 1 || versionCount != 1 || candidateVersionCount != 0 ||
			candidateCycleCount != 0 || draftBody != draftBodies[input.GoalID] ||
			draftRevision != input.ExpectedDraftRevision {
			t.Fatalf("rolled-back claim state for %s = %s/%d/%d Draft %d Version %d/%d Cycle %d body/revision %q/%d",
				input.GoalID, status, revision, currentVersionNumber, draftCount, versionCount,
				candidateVersionCount, candidateCycleCount, draftBody, draftRevision)
		}
	}
}
