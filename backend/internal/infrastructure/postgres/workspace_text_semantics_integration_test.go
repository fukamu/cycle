package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestWorkspaceTextSemanticsUseCodePointsAndPreserveNormalizedWhitespace(t *testing.T) {
	store, now := newAutosaveTestStore(t)
	fixture := progressingGoalFixtures()[0]

	goalAtLimit := strings.Repeat("🌱", goal.MaxGoalCodePoints)
	if _, err := store.CreateDraft(context.Background(), autosaveTestUserID, fixture.draftID, goalAtLimit+"🌱", now); !errors.Is(err, goal.ErrTextTooLong) {
		t.Fatalf("81-code-point creation draft error = %v, want %v", err, goal.ErrTextTooLong)
	}

	const rawGoal = "  目標\r\n本文\r末尾 \t"
	const normalizedGoal = "  目標\n本文\n末尾 \t"
	created, err := store.CreateDraft(context.Background(), autosaveTestUserID, fixture.draftID, rawGoal, now)
	if err != nil {
		t.Fatal(err)
	}
	if created.Body != normalizedGoal {
		t.Fatalf("created draft body = %q, want %q", created.Body, normalizedGoal)
	}
	persistedDraft, err := store.GetDraft(context.Background(), autosaveTestUserID, fixture.draftID)
	if err != nil || persistedDraft.Body != normalizedGoal {
		t.Fatalf("persisted normalized draft = %#v, error = %v", persistedDraft, err)
	}

	saved, err := store.SaveDraft(context.Background(), autosaveTestUserID, fixture.draftID, goalAtLimit, created.Revision, now.Add(time.Minute))
	if err != nil || saved.Body != goalAtLimit || saved.Revision != created.Revision+1 {
		t.Fatalf("80-code-point saved draft = %#v, error = %v", saved, err)
	}
	startInput := fixture.startInput(autosaveTestUserID, now.Add(2*time.Minute))
	startInput.ExpectedDraftRevision = saved.Revision
	started, err := store.StartGoal(context.Background(), startInput, 2)
	if err != nil {
		t.Fatal(err)
	}
	if started.Goal.CurrentVersion.Body != goalAtLimit {
		t.Fatalf("started Goal body = %q", started.Goal.CurrentVersion.Body)
	}

	frameAtLimit := strings.Repeat("🌱", cycle.MaxFrameCodePoints)
	if _, err = store.SaveFrame(context.Background(), workspace.SaveFrameInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		Frame: cycle.FramePlan, Content: frameAtLimit + "🌱", ExpectedFrameRevision: 0, Now: now.Add(3 * time.Minute),
	}); !errors.Is(err, cycle.ErrFrameTextTooLong) {
		t.Fatalf("201-code-point Frame error = %v, want %v", err, cycle.ErrFrameTextTooLong)
	}
	frameSaved, err := store.SaveFrame(context.Background(), workspace.SaveFrameInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		Frame: cycle.FramePlan, Content: frameAtLimit, ExpectedFrameRevision: 0, Now: now.Add(3 * time.Minute),
	})
	if err != nil || frameSaved.Content != frameAtLimit || frameSaved.FrameRevision != 1 {
		t.Fatalf("200-code-point Frame = %#v, error = %v", frameSaved, err)
	}

	var goalLength, frameLength int
	if err = store.pool.QueryRow(context.Background(), `SELECT
(SELECT char_length(body) FROM goal_versions WHERE id=$1),
(SELECT char_length(plan) FROM pdca_cycles WHERE id=$2)`, mustUUID(fixture.versionID), mustUUID(fixture.cycleID)).Scan(&goalLength, &frameLength); err != nil {
		t.Fatal(err)
	}
	if goalLength != goal.MaxGoalCodePoints || frameLength != cycle.MaxFrameCodePoints {
		t.Fatalf("PostgreSQL char_length Goal/Frame = %d/%d", goalLength, frameLength)
	}

	const rawFrame = "  P\r\nD\rA \t"
	const normalizedFrame = "  P\nD\nA \t"
	frameSaved, err = store.SaveFrame(context.Background(), workspace.SaveFrameInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID,
		Frame: cycle.FramePlan, Content: rawFrame, ExpectedFrameRevision: frameSaved.FrameRevision, Now: now.Add(4 * time.Minute),
	})
	if err != nil || frameSaved.Content != normalizedFrame {
		t.Fatalf("normalized Frame = %#v, error = %v", frameSaved, err)
	}
	var persistedFrame string
	if err = store.pool.QueryRow(context.Background(), `SELECT plan FROM pdca_cycles WHERE id=$1`, mustUUID(fixture.cycleID)).Scan(&persistedFrame); err != nil {
		t.Fatal(err)
	}
	if persistedFrame != normalizedFrame {
		t.Fatalf("persisted Frame = %q, want %q", persistedFrame, normalizedFrame)
	}

	_, err = store.pool.Exec(context.Background(), `INSERT INTO goal_drafts
(id,user_id,draft_type,body,revision,created_at,updated_at)
VALUES($1,$2,'creation',$3,0,$4,$4)`, "11000000-0000-7000-8000-000000000099", autosaveTestUserID, goalAtLimit+"🌱", now)
	assertTextCheckConstraint(t, err, "goal_drafts_body_max_80")

	_, err = store.pool.Exec(context.Background(), `UPDATE pdca_cycles SET plan=$2 WHERE id=$1`, fixture.cycleID, frameAtLimit+"🌱")
	assertTextCheckConstraint(t, err, "pdca_cycles_plan_max_200")
	if err = store.pool.QueryRow(context.Background(), `SELECT plan FROM pdca_cycles WHERE id=$1`, mustUUID(fixture.cycleID)).Scan(&persistedFrame); err != nil {
		t.Fatal(err)
	}
	if persistedFrame != normalizedFrame {
		t.Fatalf("failed direct oversize update changed Frame to %q", persistedFrame)
	}
}

func TestWorkspaceContinueReviewUsesNormalizedExactBodyComparison(t *testing.T) {
	store, now := newAutosaveTestStore(t)
	fixture := progressingGoalFixtures()[0]
	fixture.body = "\t目標\n本文\n"
	started := startProgressingGoal(t, store, autosaveTestUserID, fixture, 2, now)
	saveAllAutosaveFrames(t, store, fixture.goalID, fixture.cycleID, now.Add(time.Minute))

	const (
		firstReviewDraftID = "61000000-0000-7000-8000-000000000031"
		firstCompleteID    = "71000000-0000-7000-8000-000000000031"
		firstContinueID    = "72000000-0000-7000-8000-000000000031"
		unusedVersionID    = "31000000-0000-7000-8000-000000000031"
		secondCycleID      = "41000000-0000-7000-8000-000000000031"
		secondReviewID     = "61000000-0000-7000-8000-000000000032"
		secondCompleteID   = "71000000-0000-7000-8000-000000000032"
		secondContinueID   = "72000000-0000-7000-8000-000000000032"
		secondVersionID    = "31000000-0000-7000-8000-000000000032"
		thirdCycleID       = "41000000-0000-7000-8000-000000000032"
	)

	firstReview, err := store.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: fixture.cycleID, ReviewDraftID: firstReviewDraftID,
		OperationID: firstCompleteID, ExpectedGoalRevision: started.Goal.Revision, ExpectedContentRevision: 4,
		RequestHash: "m7-first-complete", Now: now.Add(2 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	firstSaved, err := store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, firstReviewDraftID,
		"\t目標\r\n本文\r", firstReview.ReviewDraft.Revision, now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if firstSaved.Body != fixture.body || firstSaved.Revision != firstReview.ReviewDraft.Revision {
		t.Fatalf("newline-only Review save = %#v, want body %q and no revision increment", firstSaved, fixture.body)
	}
	firstContinued, err := store.ContinueReview(context.Background(), workspace.ContinueReviewInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, OperationID: firstContinueID,
		ExpectedGoalRevision: firstReview.Goal.Revision, ExpectedDraftRevision: firstSaved.Revision,
		RequestHash: "m7-first-continue", VersionID: unusedVersionID, CycleID: secondCycleID, Now: now.Add(4 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstContinued.VersionCreated || firstContinued.Goal.CurrentVersion.VersionNumber != 1 ||
		firstContinued.Cycle.GoalVersion.ID != fixture.versionID {
		t.Fatalf("newline-only Review continue = %#v", firstContinued)
	}

	saveAllAutosaveFrames(t, store, fixture.goalID, secondCycleID, now.Add(5*time.Minute))
	secondReview, err := store.CompleteCycle(context.Background(), workspace.CompleteCycleInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, CycleID: secondCycleID, ReviewDraftID: secondReviewID,
		OperationID: secondCompleteID, ExpectedGoalRevision: firstContinued.Goal.Revision, ExpectedContentRevision: 4,
		RequestHash: "m7-second-complete", Now: now.Add(6 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	changedBody := fixture.body + " "
	secondSaved, err := store.SaveReview(context.Background(), autosaveTestUserID, fixture.goalID, secondReviewID,
		changedBody, secondReview.ReviewDraft.Revision, now.Add(7*time.Minute))
	if err != nil || secondSaved.Body != changedBody || secondSaved.Revision != secondReview.ReviewDraft.Revision+1 {
		t.Fatalf("trailing-whitespace Review save = %#v, error = %v", secondSaved, err)
	}
	secondContinued, err := store.ContinueReview(context.Background(), workspace.ContinueReviewInput{
		UserID: autosaveTestUserID, GoalID: fixture.goalID, OperationID: secondContinueID,
		ExpectedGoalRevision: secondReview.Goal.Revision, ExpectedDraftRevision: secondSaved.Revision,
		RequestHash: "m7-second-continue", VersionID: secondVersionID, CycleID: thirdCycleID, Now: now.Add(8 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !secondContinued.VersionCreated || secondContinued.Goal.CurrentVersion.VersionNumber != 2 ||
		secondContinued.Goal.CurrentVersion.ID != secondVersionID || secondContinued.Goal.CurrentVersion.Body != changedBody ||
		secondContinued.Cycle.GoalVersion.ID != secondVersionID {
		t.Fatalf("trailing-whitespace Review continue = %#v", secondContinued)
	}

	var versionCount int
	var currentBody string
	if err = store.pool.QueryRow(context.Background(), `SELECT count(*),
(SELECT body FROM goal_versions WHERE goal_id=$1 AND version_number=2)
FROM goal_versions WHERE goal_id=$1`, mustUUID(fixture.goalID)).Scan(&versionCount, &currentBody); err != nil {
		t.Fatal(err)
	}
	if versionCount != 2 || currentBody != changedBody {
		t.Fatalf("persisted versions count/body = %d/%q, want 2/%q", versionCount, currentBody, changedBody)
	}
}

func assertTextCheckConstraint(t *testing.T, err error, constraint string) {
	t.Helper()
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23514" || postgresError.ConstraintName != constraint {
		t.Fatalf("constraint error = %v, want 23514 %s", err, constraint)
	}
}
