package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestWorkspaceGoalSuccessSignalPersistsAcrossVersionAndCycleBoundaries(t *testing.T) {
	store, now := newAutosaveTestStore(t)
	fixture := progressingGoalFixtures()[0]
	created, err := executeGoalDraftCreateUseCase(
		store, context.Background(), autosaveTestUserID, fixture.draftID, fixture.body, now,
	)
	if err != nil {
		t.Fatal(err)
	}

	const rawSignal = " 週3回できる\r\n一か月続く "
	const normalizedSignal = " 週3回できる\n一か月続く "
	saved, err := executeGoalDraftSaveInputUseCase(
		store, context.Background(), autosaveTestUserID, fixture.draftID,
		workspace.SaveGoalDraftInput{
			Body: fixture.body, SuccessSignal: workspace.SuccessSignalPatch{Present: true, Value: signalPointer(rawSignal)},
			ExpectedRevision: created.Revision,
		}, now.Add(time.Minute),
	)
	if err != nil || saved.SuccessSignal == nil || *saved.SuccessSignal != normalizedSignal || saved.Revision != 1 {
		t.Fatalf("saved signal Draft = %#v, %v", saved, err)
	}
	replayed, err := executeGoalDraftSaveInputUseCase(
		store, context.Background(), autosaveTestUserID, fixture.draftID,
		workspace.SaveGoalDraftInput{Body: fixture.body, ExpectedRevision: 0}, now.Add(2*time.Minute),
	)
	if err != nil || replayed.Revision != saved.Revision || replayed.SuccessSignal == nil || *replayed.SuccessSignal != normalizedSignal {
		t.Fatalf("missing-field stale no-op = %#v, %v", replayed, err)
	}
	overLimit := strings.Repeat("🌱", goal.MaxSuccessSignalCodePoints+1)
	if _, err = executeGoalDraftSaveInputUseCase(
		store, context.Background(), autosaveTestUserID, fixture.draftID,
		workspace.SaveGoalDraftInput{
			Body: fixture.body, SuccessSignal: workspace.SuccessSignalPatch{Present: true, Value: &overLimit},
			ExpectedRevision: saved.Revision,
		}, now.Add(3*time.Minute),
	); !errors.Is(err, goal.ErrSuccessSignalTooLong) {
		t.Fatalf("oversize signal error = %v", err)
	}

	startInput := fixture.startInput(autosaveTestUserID, now.Add(4*time.Minute))
	startInput.ExpectedDraftRevision = saved.Revision
	started, err := executeGoalStartUseCase(store, context.Background(), startInput, 2)
	if err != nil {
		t.Fatal(err)
	}
	assertSuccessSignal(t, started.Goal.CurrentVersion.SuccessSignal, normalizedSignal)
	assertSuccessSignal(t, started.Cycle.GoalVersion.SuccessSignal, normalizedSignal)
	_, constraintErr := store.pool.Exec(context.Background(), `UPDATE goal_version_success_signals SET success_signal=$2 WHERE goal_version_id=$1`, fixture.versionID, strings.Repeat("🌱", goal.MaxSuccessSignalCodePoints+1))
	assertTextCheckConstraint(t, constraintErr, "goal_version_success_signals_nonempty_max_120")
	loadedCycle, err := store.QueryCycle(context.Background(), autosaveTestUserID, fixture.goalID, fixture.cycleID)
	if err != nil {
		t.Fatal(err)
	}
	assertSuccessSignal(t, loadedCycle.GoalVersion.SuccessSignal, normalizedSignal)

	saveAllAutosaveFrames(t, store, fixture.goalID, fixture.cycleID, now.Add(5*time.Minute))
	const (
		completeID = "71000000-0000-7000-8000-000000000091"
		reviewID   = "61000000-0000-7000-8000-000000000091"
		continueID = "72000000-0000-7000-8000-000000000091"
		version2ID = "31000000-0000-7000-8000-000000000091"
		cycle2ID   = "41000000-0000-7000-8000-000000000091"
	)
	review, err := executeCycleCompleteUseCase(store, context.Background(), workspace.CompleteCycleInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		OperationID: completeID, ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
	}, now.Add(6*time.Minute), reviewID)
	if err != nil {
		t.Fatal(err)
	}
	assertSuccessSignal(t, review.ReviewDraft.SuccessSignal, normalizedSignal)

	cleared, err := executeGoalReviewSaveInputUseCase(
		store, context.Background(), autosaveTestUserID, fixture.goalID, reviewID,
		workspace.SaveGoalDraftInput{
			Body: review.ReviewDraft.Body, SuccessSignal: workspace.SuccessSignalPatch{Present: true},
			ExpectedRevision: review.ReviewDraft.Revision,
		}, now.Add(7*time.Minute),
	)
	if err != nil || cleared.SuccessSignal != nil || cleared.Revision != review.ReviewDraft.Revision+1 {
		t.Fatalf("cleared Review Draft = %#v, %v", cleared, err)
	}
	continued, err := executeContinueReviewUseCase(store, context.Background(), workspace.ContinueReviewInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, OperationID: continueID,
		ExpectedGoalRevision: review.Goal.Revision, ExpectedDraftRevision: cleared.Revision,
		RequestHash: "success-signal-continue", VersionID: version2ID, CycleID: cycle2ID,
		Now: now.Add(8 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !continued.VersionCreated || continued.Goal.CurrentVersion.SuccessSignal != nil ||
		continued.Cycle.GoalVersion.SuccessSignal != nil {
		t.Fatalf("signal-clear continuation = %#v", continued)
	}
	var oldSignal string
	var currentRows int
	if err = store.pool.QueryRow(context.Background(), `SELECT
(SELECT success_signal FROM goal_version_success_signals WHERE goal_version_id=$1),
(SELECT count(*) FROM goal_version_success_signals WHERE goal_version_id=$2)`, fixture.versionID, version2ID).Scan(&oldSignal, &currentRows); err != nil {
		t.Fatal(err)
	}
	if oldSignal != normalizedSignal || currentRows != 0 {
		t.Fatalf("immutable version signals = old:%q current rows:%d", oldSignal, currentRows)
	}
}

func signalPointer(value string) *string { return &value }

func assertSuccessSignal(t *testing.T, actual *string, want string) {
	t.Helper()
	if actual == nil || *actual != want {
		t.Fatalf("success signal = %#v, want %q", actual, want)
	}
}
