package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

func TestCycleViewUsesExactScopedPreviousCompletedActionAndNeverFallsBack(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		ownerID    = "10000000-0000-7000-8000-000000000001"
		outsiderID = "10000000-0000-7000-8000-000000000002"
	)
	insertAIConcurrencyUser(t, pool, ownerID, now)
	insertAIConcurrencyUser(t, pool, outsiderID, now)
	store := NewWorkspaceStore(pool)
	fixtures := progressingGoalFixtures()

	firstReview := prepareReviewTransitionReview(t, store, ownerID, fixtures[0], 2,
		"61000000-0000-7000-8000-000000000501",
		"71000000-0000-7000-8000-000000000501", now)
	if firstReview.CompletedCycle.PreviousCompletedCycleAction != nil {
		t.Fatalf("completed Cycle 1 previous Action = %#v", firstReview.CompletedCycle.PreviousCompletedCycleAction)
	}
	reviewView, err := store.GetReview(context.Background(), ownerID, fixtures[0].goalID)
	if err != nil || reviewView.TriggerCycle.PreviousCompletedCycleAction != nil {
		t.Fatalf("Review trigger previous Action = %#v, error = %v", reviewView.TriggerCycle.PreviousCompletedCycleAction, err)
	}
	firstSaved, err := executeGoalReviewSaveUseCase(
		store,
		context.Background(),
		ownerID,
		fixtures[0].goalID,
		firstReview.ReviewDraft.ID,
		"変更した目標",
		firstReview.ReviewDraft.Revision,
		now.Add(3*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	firstContinue := workspace.ContinueReviewInput{
		UserID: ownerID, GoalID: fixtures[0].goalID,
		OperationID:           "72000000-0000-7000-8000-000000000501",
		ExpectedGoalRevision:  firstReview.Goal.Revision,
		ExpectedDraftRevision: firstSaved.Revision,
		VersionID:             "51000000-0000-7000-8000-000000000501",
		CycleID:               "41000000-0000-7000-8000-000000000501",
		Now:                   now.Add(4 * time.Minute),
	}
	secondCycle, err := executeContinueReviewUseCase(store, context.Background(), firstContinue)
	if err != nil {
		t.Fatal(err)
	}
	if !secondCycle.VersionCreated || secondCycle.Goal.CurrentVersion.VersionNumber != 2 {
		t.Fatalf("first changed Continue = %#v", secondCycle)
	}
	assertPreviousCompletedCycleAction(t, secondCycle.Cycle, fixtures[0].cycleID, 1, 1, "action")
	firstReplay, err := executeContinueReviewUseCase(store, context.Background(), firstContinue)
	if err != nil || !firstReplay.Replayed {
		t.Fatalf("first Continue replay = %#v, error = %v", firstReplay, err)
	}
	assertPreviousCompletedCycleAction(t, firstReplay.Cycle, fixtures[0].cycleID, 1, 1, "action")

	for _, frame := range []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		content := "second " + string(frame)
		if _, err = executeCycleSaveUseCase(store, context.Background(), workspace.SaveFrameInput{
			UserID: ownerID, GoalID: fixtures[0].goalID, CycleID: firstContinue.CycleID,
			Frame: frame, Content: content, ExpectedFrameRevision: 0,
		}, now.Add(5*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	secondReview, err := executeCycleCompleteUseCase(store, context.Background(), workspace.CompleteCycleInput{
		UserID: ownerID, GoalID: fixtures[0].goalID, CycleID: firstContinue.CycleID,
		OperationID:          "71000000-0000-7000-8000-000000000502",
		ExpectedGoalRevision: secondCycle.Goal.Revision, ExpectedContentRevision: 4,
	}, now.Add(6*time.Minute), "61000000-0000-7000-8000-000000000502")
	if err != nil {
		t.Fatal(err)
	}
	if secondReview.CompletedCycle.PreviousCompletedCycleAction != nil {
		t.Fatalf("terminal Cycle 2 previous Action = %#v", secondReview.CompletedCycle.PreviousCompletedCycleAction)
	}
	secondSaved, err := executeGoalReviewSaveUseCase(
		store,
		context.Background(),
		ownerID,
		fixtures[0].goalID,
		secondReview.ReviewDraft.ID,
		"さらに変更した目標",
		secondReview.ReviewDraft.Revision,
		now.Add(7*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	secondContinue := workspace.ContinueReviewInput{
		UserID: ownerID, GoalID: fixtures[0].goalID,
		OperationID:           "72000000-0000-7000-8000-000000000502",
		ExpectedGoalRevision:  secondReview.Goal.Revision,
		ExpectedDraftRevision: secondSaved.Revision,
		VersionID:             "51000000-0000-7000-8000-000000000502",
		CycleID:               "41000000-0000-7000-8000-000000000502",
		Now:                   now.Add(8 * time.Minute),
	}
	thirdCycle, err := executeContinueReviewUseCase(store, context.Background(), secondContinue)
	if err != nil {
		t.Fatal(err)
	}
	assertPreviousCompletedCycleAction(t, thirdCycle.Cycle, firstContinue.CycleID, 2, 2, "second action")

	ownerDecoy := prepareReviewTransitionReview(t, store, ownerID, fixtures[1], 2,
		"61000000-0000-7000-8000-000000000503",
		"71000000-0000-7000-8000-000000000503", now.Add(9*time.Minute))
	ownerDecoyCycle := completeSecondCycleDecoy(
		t, store, ownerID, fixtures[1].goalID, ownerDecoy,
		"72000000-0000-7000-8000-000000000503",
		"41000000-0000-7000-8000-000000000503",
		"71000000-0000-7000-8000-000000000505",
		"61000000-0000-7000-8000-000000000505",
		"OWNER_DECOY_SECRET", now.Add(10*time.Minute),
	)
	outsiderDecoy := prepareReviewTransitionReview(t, store, outsiderID, fixtures[2], 2,
		"61000000-0000-7000-8000-000000000504",
		"71000000-0000-7000-8000-000000000504", now.Add(11*time.Minute))
	outsiderDecoyCycle := completeSecondCycleDecoy(
		t, store, outsiderID, fixtures[2].goalID, outsiderDecoy,
		"72000000-0000-7000-8000-000000000504",
		"41000000-0000-7000-8000-000000000504",
		"71000000-0000-7000-8000-000000000506",
		"61000000-0000-7000-8000-000000000506",
		"OUTSIDER_DECOY_SECRET", now.Add(12*time.Minute),
	)
	if ownerDecoyCycle.SequenceNumber != 2 || outsiderDecoyCycle.SequenceNumber != 2 {
		t.Fatalf("decoy sequences = %d/%d, want target predecessor sequence 2",
			ownerDecoyCycle.SequenceNumber, outsiderDecoyCycle.SequenceNumber)
	}
	view, err := executeCycleGetUseCase(
		store, context.Background(), ownerID, fixtures[0].goalID, secondContinue.CycleID, now,
	)
	if err != nil {
		t.Fatal(err)
	}
	assertPreviousCompletedCycleAction(t, view, firstContinue.CycleID, 2, 2, "second action")
	if view.PreviousCompletedCycleAction.Action == ownerDecoyCycle.Action ||
		view.PreviousCompletedCycleAction.Action == outsiderDecoyCycle.Action {
		t.Fatalf("scoped predecessor selected decoy Action %q", view.PreviousCompletedCycleAction.Action)
	}
	if _, err = executeCycleGetUseCase(
		store, context.Background(), outsiderID, fixtures[0].goalID, secondContinue.CycleID, now,
	); !errors.Is(err, workspace.ErrGoalNotFound) {
		t.Fatalf("cross-user GET error = %v, want %v", err, workspace.ErrGoalNotFound)
	}

	if _, err = pool.Exec(context.Background(), `UPDATE pdca_cycles SET action='   ' WHERE id=$1`, firstContinue.CycleID); err != nil {
		t.Fatal(err)
	}
	assertCycleViewInvariantError(t, store, ownerID, fixtures[0].goalID, secondContinue.CycleID)
	if _, err = pool.Exec(context.Background(), `UPDATE pdca_cycles SET action='second action' WHERE id=$1`, firstContinue.CycleID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(context.Background(), `UPDATE pdca_cycles SET goal_version_id=$2 WHERE id=$1`,
		firstContinue.CycleID, fixtures[0].versionID); err != nil {
		t.Fatal(err)
	}
	assertCycleViewInvariantError(t, store, ownerID, fixtures[0].goalID, secondContinue.CycleID)
	if _, err = pool.Exec(context.Background(), `UPDATE pdca_cycles SET goal_version_id=$2 WHERE id=$1`,
		firstContinue.CycleID, firstContinue.VersionID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(context.Background(), `UPDATE pdca_cycles SET
status='canceled',completed_at=NULL,canceled_at=$2,cancellation_reason='goal_ended',
	completion_operation_id=NULL,completion_request_hash=NULL WHERE id=$1`, firstContinue.CycleID, now.Add(13*time.Minute)); err != nil {
		t.Fatal(err)
	}
	assertCycleViewInvariantError(t, store, ownerID, fixtures[0].goalID, secondContinue.CycleID)
	if _, err = pool.Exec(context.Background(), `DELETE FROM pdca_cycles WHERE id=$1`, firstContinue.CycleID); err != nil {
		t.Fatal(err)
	}
	assertCycleViewInvariantError(t, store, ownerID, fixtures[0].goalID, secondContinue.CycleID)
}

func completeSecondCycleDecoy(
	t *testing.T,
	store *WorkspaceStore,
	userID, goalID string,
	review workspace.CompleteCycleResult,
	continueOperationID, cycleID, completeOperationID, reviewDraftID, action string,
	now time.Time,
) workspace.CycleView {
	t.Helper()
	continued, err := executeContinueReviewUseCase(store, context.Background(), workspace.ContinueReviewInput{
		UserID: userID, GoalID: goalID, OperationID: continueOperationID,
		ExpectedGoalRevision: review.Goal.Revision, ExpectedDraftRevision: review.ReviewDraft.Revision,
		CycleID: cycleID, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		content := "decoy " + string(frame)
		if frame == cycle.FrameAction {
			content = action
		}
		if _, err = executeCycleSaveUseCase(store, context.Background(), workspace.SaveFrameInput{
			UserID: userID, GoalID: goalID, CycleID: cycleID,
			Frame: frame, Content: content, ExpectedFrameRevision: 0,
		}, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	completed, err := executeCycleCompleteUseCase(store, context.Background(), workspace.CompleteCycleInput{
		UserID: userID, GoalID: goalID, CycleID: cycleID,
		OperationID: completeOperationID, ExpectedGoalRevision: continued.Goal.Revision, ExpectedContentRevision: 4,
	}, now.Add(2*time.Minute), reviewDraftID)
	if err != nil {
		t.Fatal(err)
	}
	return completed.CompletedCycle
}

func TestCycleViewPreviousActionUsesRepeatableReadSnapshot(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	baseStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, baseStore, userID, fixture, 2,
		"61000000-0000-7000-8000-000000000511",
		"71000000-0000-7000-8000-000000000511", now)
	continued, err := executeContinueReviewUseCase(baseStore, context.Background(), workspace.ContinueReviewInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID:          "72000000-0000-7000-8000-000000000511",
		ExpectedGoalRevision: review.Goal.Revision, ExpectedDraftRevision: review.ReviewDraft.Revision,
		CycleID: "41000000-0000-7000-8000-000000000511", Now: now.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}

	config := pool.Config()
	config.ConnConfig.Tracer = &cycleQuerySnapshotTracer{}
	config.MinConns = 0
	config.MaxConns = 1
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)
	barrier := newCycleQuerySnapshotBarrier()
	defer barrier.release()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, cycleQuerySnapshotContextKey{}, barrier)

	type readResult struct {
		view workspace.CycleView
		err  error
	}
	result := make(chan readResult, 1)
	go func() {
		view, readErr := executeCycleGetUseCase(
			NewWorkspaceStore(tracedPool), ctx, userID, fixture.goalID, continued.Cycle.ID, now,
		)
		result <- readResult{view: view, err: readErr}
	}()
	select {
	case <-barrier.secondReadStarted:
	case <-ctx.Done():
		t.Fatalf("Cycle view second read did not start: %v", ctx.Err())
	}
	if _, err = pool.Exec(context.Background(), `DELETE FROM pdca_cycles WHERE id=$1`, fixture.cycleID); err != nil {
		t.Fatal(err)
	}
	barrier.release()
	select {
	case call := <-result:
		if call.err != nil {
			t.Fatal(call.err)
		}
		assertPreviousCompletedCycleAction(t, call.view, fixture.cycleID, 1, 1, "action")
	case <-ctx.Done():
		t.Fatalf("Cycle view did not finish: %v", ctx.Err())
	}
	assertCycleViewInvariantError(t, baseStore, userID, fixture.goalID, continued.Cycle.ID)
}

type corruptPreviousActionReviewUOW struct {
	store *WorkspaceStore
}

func (uow *corruptPreviousActionReviewUOW) WithinReviewTransitionTransaction(
	ctx context.Context,
	operation func(workspace.ReviewTransitionTx) error,
) error {
	return uow.store.WithinReviewTransitionTransaction(ctx, func(tx workspace.ReviewTransitionTx) error {
		return operation(&corruptPreviousActionReviewTx{ReviewTransitionTx: tx})
	})
}

type corruptPreviousActionReviewTx struct {
	workspace.ReviewTransitionTx
}

func (tx *corruptPreviousActionReviewTx) LoadCycleView(
	ctx context.Context,
	userID, goalID, cycleID string,
) (workspace.CycleView, error) {
	view, err := tx.ReviewTransitionTx.LoadCycleView(ctx, userID, goalID, cycleID)
	if err != nil || view.PreviousCompletedCycleAction == nil {
		return view, err
	}
	previous := *view.PreviousCompletedCycleAction
	previous.CycleID = "49000000-0000-7000-8000-000000000599"
	view.PreviousCompletedCycleAction = &previous
	return view, nil
}

func TestContinueReviewRollsBackWhenMaterializedPredecessorDoesNotMatchLockedDraft(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, store, userID, fixture, 2,
		"61000000-0000-7000-8000-000000000521",
		"71000000-0000-7000-8000-000000000521", now)
	const candidateCycleID = "41000000-0000-7000-8000-000000000521"
	useCases := workspace.NewReviewTransitionUseCases(
		&corruptPreviousActionReviewUOW{store: store},
		reviewTransitionIntegrationClock{now: now.Add(3 * time.Minute)},
		&cycleApplicationTestIDs{items: []string{candidateCycleID}},
	)
	_, err := useCases.ContinueReview(context.Background(), workspace.ContinueReviewInput{
		UserID: userID, GoalID: fixture.goalID,
		OperationID:          "72000000-0000-7000-8000-000000000521",
		ExpectedGoalRevision: review.Goal.Revision, ExpectedDraftRevision: review.ReviewDraft.Revision,
	})
	if !errors.Is(err, workspace.ErrReviewTransitionPersistenceInvariant) {
		t.Fatalf("Continue error = %v, want %v", err, workspace.ErrReviewTransitionPersistenceInvariant)
	}
	var status string
	var revision int64
	var draftCount, cycleCount int
	if err = pool.QueryRow(context.Background(), `SELECT g.status,g.revision,
(SELECT count(*) FROM goal_drafts WHERE user_id=$1 AND goal_id=$2 AND draft_type='review'),
(SELECT count(*) FROM pdca_cycles WHERE user_id=$1 AND goal_id=$2 AND id=$3)
FROM goals g WHERE g.user_id=$1 AND g.id=$2`, userID, fixture.goalID, candidateCycleID).Scan(
		&status, &revision, &draftCount, &cycleCount,
	); err != nil {
		t.Fatal(err)
	}
	if status != "goal_review" || revision != review.Goal.Revision || draftCount != 1 || cycleCount != 0 {
		t.Fatalf("rolled-back Goal/Draft/Cycle = %s/%d/%d/%d", status, revision, draftCount, cycleCount)
	}
}

func assertCycleViewInvariantError(
	t *testing.T,
	store *WorkspaceStore,
	userID, goalID, cycleID string,
) {
	t.Helper()
	_, err := executeCycleGetUseCase(store, context.Background(), userID, goalID, cycleID, integrationNow())
	if !errors.Is(err, workspace.ErrCyclePersistenceInvariant) {
		t.Fatalf("Cycle view error = %v, want %v", err, workspace.ErrCyclePersistenceInvariant)
	}
}
