package postgres

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestReviewTransitionContinueReplaysCurrentReviewAfterCreatedCycleCompleted(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, store, userID, fixture, 2,
		"61000000-0000-7000-8000-000000000451",
		"71000000-0000-7000-8000-000000000451", now)
	continueInput := workspace.ContinueReviewInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID:           "72000000-0000-7000-8000-000000000451",
		ExpectedGoalRevision:  review.Goal.Revision,
		ExpectedDraftRevision: review.ReviewDraft.Revision,
		CycleID:               "41000000-0000-7000-8000-000000000451",
		Now:                   now.Add(3 * time.Minute),
	}
	continued, err := executeContinueReviewUseCase(store, context.Background(), continueInput)
	if err != nil {
		t.Fatal(err)
	}
	if continued.Replayed || continued.VersionCreated ||
		continued.Goal.Status != goal.StatusActiveCycle ||
		continued.Cycle.Status != cycle.StatusActive {
		t.Fatalf("fresh Continue = %#v", continued)
	}
	for _, frame := range []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		if _, err = executeCycleSaveUseCase(store, context.Background(), workspace.SaveFrameInput{
			UserID: userID, GoalID: fixture.goalID, CycleID: continued.Cycle.ID,
			Frame: frame, Content: string(frame), ExpectedFrameRevision: 0,
			Now: now.Add(4 * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	const completionOperationID = "73000000-0000-7000-8000-000000000451"
	completed, err := executeCycleCompleteUseCase(store, context.Background(), workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: continued.Cycle.ID,
		ReviewDraftID: "61000000-0000-7000-8000-000000000452",
		OperationID:   completionOperationID, ExpectedGoalRevision: continued.Goal.Revision,
		ExpectedContentRevision: 4, Now: now.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Goal.Status != goal.StatusGoalReview ||
		completed.CompletedCycle.Status != cycle.StatusCompleted {
		t.Fatalf("completed continued Cycle = %#v", completed)
	}

	readCounts := func() [5]int {
		t.Helper()
		var counts [5]int
		if queryErr := pool.QueryRow(context.Background(), `SELECT
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM goal_versions WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND goal_id=$2),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND start_operation_id=$3),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND completion_operation_id=$4)`,
			userID, fixture.goalID, continueInput.OperationID, completionOperationID).Scan(
			&counts[0], &counts[1], &counts[2], &counts[3], &counts[4]); queryErr != nil {
			t.Fatal(queryErr)
		}
		return counts
	}
	before := readCounts()
	if before != [5]int{2, 1, 1, 1, 1} {
		t.Fatalf("pre-replay Cycle/Version/Draft/start receipt/completion receipt = %v", before)
	}

	replayInput := continueInput
	replayInput.Now = now.Add(10 * time.Minute)
	replayed, err := executeContinueReviewUseCase(store, context.Background(), replayInput)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed.Replayed || replayed.VersionCreated ||
		!reflect.DeepEqual(replayed.Goal, completed.Goal) ||
		!reflect.DeepEqual(replayed.Cycle, completed.CompletedCycle) ||
		replayed.Goal.Status != goal.StatusGoalReview ||
		replayed.Cycle.ID != continued.Cycle.ID ||
		replayed.Cycle.Status != cycle.StatusCompleted {
		t.Fatalf("response-loss Continue replay = %#v, want Goal %#v and Cycle %#v",
			replayed, completed.Goal, completed.CompletedCycle)
	}
	if after := readCounts(); after != before {
		t.Fatalf("response-loss replay changed Cycle/Version/Draft/receipts = %v -> %v", before, after)
	}
}
