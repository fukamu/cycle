package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

const autosaveTestUserID = "10000000-0000-7000-8000-000000000001"

func TestWorkspaceSaveDraftTreatsSamePersistedBodyWithStaleRevisionAsNoOp(t *testing.T) {
	store, now := newAutosaveTestStore(t)
	const creationID = "11000000-0000-7000-8000-000000000010"
	if _, err := store.CreateDraft(context.Background(), autosaveTestUserID, creationID, "初期目標", now); err != nil {
		t.Fatal(err)
	}

	savedAt := now.Add(time.Minute)
	saved, err := store.SaveDraft(context.Background(), autosaveTestUserID, creationID, "保存済み目標", 0, savedAt)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("save = %#v, error = %v", saved, err)
	}
	replayed, err := store.SaveDraft(context.Background(), autosaveTestUserID, creationID, saved.Body, 0, now.Add(2*time.Minute))
	if err != nil || replayed.Body != saved.Body || replayed.Revision != saved.Revision || !replayed.UpdatedAt.Equal(savedAt) {
		t.Fatalf("stale same-body save = %#v, error = %v", replayed, err)
	}
	persisted, err := store.GetDraft(context.Background(), autosaveTestUserID, creationID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Body != saved.Body || persisted.Revision != saved.Revision || !persisted.UpdatedAt.Equal(savedAt) {
		t.Fatalf("persisted draft after stale same-body save = %#v, want body/revision/updatedAt from %#v", persisted, saved)
	}
	if _, err = store.SaveDraft(context.Background(), autosaveTestUserID, creationID, "異なる目標", 0, now.Add(2*time.Minute)); err != workspace.ErrDraftRevisionConflict {
		t.Fatalf("stale different-body error = %v, want %v", err, workspace.ErrDraftRevisionConflict)
	}
}

func TestWorkspaceSaveFrameTreatsSamePersistedContentWithStaleRevisionAsNoOp(t *testing.T) {
	store, now := newAutosaveTestStore(t)
	fixture := progressingGoalFixtures()[0]
	startProgressingGoal(t, store, autosaveTestUserID, fixture, 2, now)

	savedAt := now.Add(time.Minute)
	saved, err := store.SaveFrame(context.Background(), workspace.SaveFrameInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		Frame: cycle.FramePlan, Content: "保存済みPlan", ExpectedFrameRevision: 0, Now: savedAt,
	})
	if err != nil || saved.FrameRevision != 1 || saved.ContentRevision != 1 {
		t.Fatalf("save = %#v, error = %v", saved, err)
	}
	replayed, err := store.SaveFrame(context.Background(), workspace.SaveFrameInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		Frame: cycle.FramePlan, Content: saved.Content, ExpectedFrameRevision: 0, Now: now.Add(2 * time.Minute),
	})
	if err != nil || replayed.Content != saved.Content || replayed.FrameRevision != saved.FrameRevision ||
		replayed.ContentRevision != saved.ContentRevision || !replayed.SavedAt.Equal(savedAt) {
		t.Fatalf("stale same-content save = %#v, error = %v", replayed, err)
	}
	persisted, err := store.GetCycle(context.Background(), autosaveTestUserID, fixture.goalID, fixture.cycleID)
	if err != nil {
		t.Fatal(err)
	}
	var persistedUpdatedAt time.Time
	if err = store.pool.QueryRow(context.Background(), `SELECT updated_at FROM pdca_cycles WHERE id=$1`, mustUUID(fixture.cycleID)).Scan(&persistedUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if persisted.Plan != saved.Content || persisted.FrameRevisions.Plan != saved.FrameRevision ||
		persisted.ContentRevision != saved.ContentRevision || !persistedUpdatedAt.Equal(savedAt) {
		t.Fatalf("persisted cycle after stale same-content save = %#v, updatedAt = %s, want content/frameRevision/contentRevision/updatedAt from %#v", persisted, persistedUpdatedAt, saved)
	}
	if _, err = store.SaveFrame(context.Background(), workspace.SaveFrameInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		Frame: cycle.FramePlan, Content: "異なるPlan", ExpectedFrameRevision: 0, Now: now.Add(2 * time.Minute),
	}); err != cycle.ErrRevisionConflict {
		t.Fatalf("stale different-content error = %v, want %v", err, cycle.ErrRevisionConflict)
	}
}

func TestWorkspaceSaveReviewTreatsSamePersistedBodyWithStaleRevisionAsNoOp(t *testing.T) {
	store, now := newAutosaveTestStore(t)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, autosaveTestUserID, fixture, 2, now)
	for _, frame := range []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		if _, err := store.SaveFrame(context.Background(), workspace.SaveFrameInput{
			UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
			Frame: frame, Content: string(frame), ExpectedFrameRevision: 0, Now: now.Add(time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	const (
		reviewDraftID = "61000000-0000-7000-8000-000000000010"
		completeID    = "71000000-0000-7000-8000-000000000010"
	)
	completed, err := store.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID, ReviewDraftID: reviewDraftID,
		OperationID: completeID, ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		RequestHash: "m6-autosave-complete", Now: now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}

	savedAt := now.Add(3 * time.Minute)
	saved, err := store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, reviewDraftID, "保存済みレビュー目標", completed.ReviewDraft.Revision, savedAt)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("save = %#v, error = %v", saved, err)
	}
	replayed, err := store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, reviewDraftID, saved.Body, completed.ReviewDraft.Revision, now.Add(4*time.Minute))
	if err != nil || replayed.Body != saved.Body || replayed.Revision != saved.Revision || !replayed.UpdatedAt.Equal(savedAt) {
		t.Fatalf("stale same-body save = %#v, error = %v", replayed, err)
	}
	persisted, err := store.GetReview(context.Background(), autosaveTestUserID, fixture.goalID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.ReviewDraft.Body != saved.Body || persisted.ReviewDraft.Revision != saved.Revision || !persisted.ReviewDraft.UpdatedAt.Equal(savedAt) {
		t.Fatalf("persisted review after stale same-body save = %#v, want body/revision/updatedAt from %#v", persisted.ReviewDraft, saved)
	}
	if _, err = store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, reviewDraftID, "異なるレビュー目標", completed.ReviewDraft.Revision, now.Add(4*time.Minute)); err != workspace.ErrReviewRevisionConflict {
		t.Fatalf("stale different-body error = %v, want %v", err, workspace.ErrReviewRevisionConflict)
	}
}

func TestWorkspaceSaveReviewRejectsSupersededDraftGeneration(t *testing.T) {
	store, now := newAutosaveTestStore(t)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, autosaveTestUserID, fixture, 2, now)
	saveAllAutosaveFrames(t, store, fixture.goalID, fixture.cycleID, now.Add(time.Minute))
	const (
		firstReviewDraftID  = "61000000-0000-7000-8000-000000000020"
		firstCompleteID     = "71000000-0000-7000-8000-000000000020"
		continueID          = "72000000-0000-7000-8000-000000000020"
		secondVersionID     = "31000000-0000-7000-8000-000000000020"
		secondCycleID       = "41000000-0000-7000-8000-000000000020"
		secondReviewDraftID = "61000000-0000-7000-8000-000000000021"
		secondCompleteID    = "71000000-0000-7000-8000-000000000021"
	)

	firstReview, err := store.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID, ReviewDraftID: firstReviewDraftID,
		OperationID: firstCompleteID, ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		RequestHash: "m6-first-complete", Now: now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	continued, err := store.ContinueReview(context.Background(), workspace.ContinueReviewInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, OperationID: continueID,
		ExpectedGoalRevision: firstReview.Goal.Revision, ExpectedDraftRevision: firstReview.ReviewDraft.Revision,
		RequestHash: "m6-continue", VersionID: secondVersionID, CycleID: secondCycleID, Now: now.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	saveAllAutosaveFrames(t, store, fixture.goalID, secondCycleID, now.Add(4*time.Minute))
	secondReview, err := store.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: secondCycleID, ReviewDraftID: secondReviewDraftID,
		OperationID: secondCompleteID, ExpectedGoalRevision: continued.Goal.Revision, ExpectedContentRevision: 4,
		RequestHash: "m6-second-complete", Now: now.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if secondReview.ReviewDraft.ID != secondReviewDraftID {
		t.Fatalf("second review draft = %#v", secondReview.ReviewDraft)
	}

	if _, err = store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, firstReviewDraftID,
		secondReview.ReviewDraft.Body, firstReview.ReviewDraft.Revision, now.Add(6*time.Minute)); err != workspace.ErrReviewRevisionConflict {
		t.Fatalf("superseded same-body review draft error = %v, want %v", err, workspace.ErrReviewRevisionConflict)
	}

	if _, err = store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, firstReviewDraftID,
		"遅延した旧世代の本文", firstReview.ReviewDraft.Revision, now.Add(6*time.Minute)); err != workspace.ErrReviewRevisionConflict {
		t.Fatalf("superseded review draft error = %v, want %v", err, workspace.ErrReviewRevisionConflict)
	}
	afterLateSave, err := store.GetReview(context.Background(), autosaveTestUserID, fixture.goalID)
	if err != nil {
		t.Fatal(err)
	}
	if afterLateSave.ReviewDraft.ID != secondReview.ReviewDraft.ID ||
		afterLateSave.ReviewDraft.Body != secondReview.ReviewDraft.Body ||
		afterLateSave.ReviewDraft.Revision != secondReview.ReviewDraft.Revision ||
		!afterLateSave.ReviewDraft.UpdatedAt.Equal(secondReview.ReviewDraft.UpdatedAt) {
		t.Fatalf("second review changed by superseded save: got %#v, want %#v", afterLateSave.ReviewDraft, secondReview.ReviewDraft)
	}

	savedAt := now.Add(7 * time.Minute)
	saved, err := store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, secondReviewDraftID,
		"現世代で保存した本文", secondReview.ReviewDraft.Revision, savedAt)
	if err != nil || saved.Revision != secondReview.ReviewDraft.Revision+1 {
		t.Fatalf("current generation save = %#v, error = %v", saved, err)
	}
	replayed, err := store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, secondReviewDraftID,
		saved.Body, secondReview.ReviewDraft.Revision, now.Add(8*time.Minute))
	if err != nil || replayed.ID != secondReviewDraftID || replayed.Body != saved.Body ||
		replayed.Revision != saved.Revision || !replayed.UpdatedAt.Equal(savedAt) {
		t.Fatalf("current generation stale same-body save = %#v, error = %v", replayed, err)
	}
	if _, err = store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, secondReviewDraftID,
		"現世代の競合本文", secondReview.ReviewDraft.Revision, now.Add(9*time.Minute)); err != workspace.ErrReviewRevisionConflict {
		t.Fatalf("current generation stale different-body error = %v, want %v", err, workspace.ErrReviewRevisionConflict)
	}
	persisted, err := store.GetReview(context.Background(), autosaveTestUserID, fixture.goalID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.ReviewDraft.ID != saved.ID || persisted.ReviewDraft.Body != saved.Body ||
		persisted.ReviewDraft.Revision != saved.Revision || !persisted.ReviewDraft.UpdatedAt.Equal(savedAt) {
		t.Fatalf("persisted current review = %#v, want %#v", persisted.ReviewDraft, saved)
	}
}

func saveAllAutosaveFrames(t *testing.T, store *WorkspaceStore, goalID, cycleID string, now time.Time) {
	t.Helper()
	for _, frame := range []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		if _, err := store.SaveFrame(context.Background(), workspace.SaveFrameInput{
			UserID: autosaveTestUserID, GoalID: goalID, CycleID: cycleID,
			Frame: frame, Content: string(frame), ExpectedFrameRevision: 0, Now: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func newAutosaveTestStore(t *testing.T) (*WorkspaceStore, time.Time) {
	t.Helper()
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, autosaveTestUserID, now); err != nil {
		t.Fatal(err)
	}
	return NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")}), now
}
