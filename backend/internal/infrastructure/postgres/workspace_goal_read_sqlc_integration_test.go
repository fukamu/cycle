package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type goalReadReviewFixture struct {
	goalID            string
	versionID         string
	cycleID           string
	reviewDraftID     string
	startOperationID  string
	finishOperationID string
}

type goalReviewSnapshotContextKey struct{}

type goalReviewSnapshotTracer struct{}

type goalReviewSnapshotBarrier struct {
	draftReadStarted chan struct{}
	releaseDraftRead chan struct{}
	startedOnce      sync.Once
	releaseOnce      sync.Once
}

func newGoalReviewSnapshotBarrier() *goalReviewSnapshotBarrier {
	return &goalReviewSnapshotBarrier{
		draftReadStarted: make(chan struct{}),
		releaseDraftRead: make(chan struct{}),
	}
}

func (*goalReviewSnapshotTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	barrier, ok := ctx.Value(goalReviewSnapshotContextKey{}).(*goalReviewSnapshotBarrier)
	if !ok || barrier == nil || !isGoalReviewSnapshotDraftRead(data.SQL) {
		return ctx
	}
	barrier.startedOnce.Do(func() { close(barrier.draftReadStarted) })
	select {
	case <-barrier.releaseDraftRead:
	case <-ctx.Done():
	}
	return ctx
}

func (*goalReviewSnapshotTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
}

func (barrier *goalReviewSnapshotBarrier) release() {
	barrier.releaseOnce.Do(func() { close(barrier.releaseDraftRead) })
}

func isGoalReviewSnapshotDraftRead(sql string) bool {
	normalized := normalizeObservedSQL(sql)
	return strings.Contains(normalized, "from goal_drafts") &&
		strings.Contains(normalized, "where goal_id=$1 and user_id=$2 and draft_type='review'")
}

func seedGoalReadReviewFixture(
	t *testing.T,
	pool *pgxpool.Pool,
	userID string,
	fixture goalReadReviewFixture,
	createdAt time.Time,
	completedAt time.Time,
) {
	t.Helper()
	statements := []struct {
		query string
		args  []any
	}{
		{
			query: `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,revision,created_at,updated_at)
VALUES($1,$2,'goal_review',1,2,1,$3,$4)`,
			args: []any{fixture.goalID, userID, createdAt, completedAt},
		},
		{
			query: `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'review goal',$4,$5)`,
			args: []any{fixture.versionID, userID, fixture.goalID, fixture.startOperationID, createdAt},
		},
		{
			query: `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,completed_at,
 plan,do_text,check_text,action,start_operation_id,start_request_hash,
 completion_operation_id,completion_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'completed',$5,$6,'P','D','C','A',$7,'start-hash',$8,'complete-hash',$5,$6)`,
			args: []any{
				fixture.cycleID, userID, fixture.goalID, fixture.versionID, createdAt,
				completedAt, fixture.startOperationID, fixture.finishOperationID,
			},
		},
		{
			query: `INSERT INTO goal_drafts
(id,user_id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,created_at,updated_at)
VALUES($1,$2,'review',$3,$4,$5,'review draft',2,$6,$6)`,
			args: []any{fixture.reviewDraftID, userID, fixture.goalID, fixture.versionID, fixture.cycleID, completedAt},
		},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(context.Background(), statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGoalReadModelsPreserveOwnerScopedDraftAndCurrentWork(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		ownerID              = "10000000-0000-7000-8000-000000000001"
		outsiderID           = "10000000-0000-7000-8000-000000000002"
		ownerCreationDraftID = "11000000-0000-7000-8000-000000000001"
		otherCreationDraftID = "11000000-0000-7000-8000-000000000002"
	)
	active := goalQueryFixture{
		goalID: "20000000-0000-7000-8000-000000000001", versionID: "30000000-0000-7000-8000-000000000001",
		cycleID: "40000000-0000-7000-8000-000000000001", operation: "50000000-0000-7000-8000-000000000001",
		status: goal.StatusActiveCycle, sortTime: now,
	}
	review := goalReadReviewFixture{
		goalID: "20000000-0000-7000-8000-000000000002", versionID: "30000000-0000-7000-8000-000000000002",
		cycleID: "40000000-0000-7000-8000-000000000002", reviewDraftID: "60000000-0000-7000-8000-000000000002",
		startOperationID: "50000000-0000-7000-8000-000000000002", finishOperationID: "51000000-0000-7000-8000-000000000002",
	}
	outsider := goalQueryFixture{
		goalID: "20000000-0000-7000-8000-000000000003", versionID: "30000000-0000-7000-8000-000000000003",
		cycleID: "40000000-0000-7000-8000-000000000003", operation: "50000000-0000-7000-8000-000000000003",
		status: goal.StatusActiveCycle, sortTime: now.Add(time.Hour),
	}
	seedGoalQueryUser(t, pool, ownerID, now)
	seedGoalQueryUser(t, pool, outsiderID, now)
	seedGoalQueryFixture(t, pool, ownerID, active, now)
	seedGoalReadReviewFixture(t, pool, ownerID, review, now.Add(-23*time.Hour), now)
	seedGoalQueryFixture(t, pool, outsiderID, outsider, now)
	if _, err := pool.Exec(context.Background(), `INSERT INTO goal_drafts
(id,user_id,draft_type,body,revision,created_at,updated_at)
VALUES($1,$2,'creation',$3,4,$4,$4),($5,$6,'creation','outsider draft',0,$4,$4)`,
		ownerCreationDraftID, ownerID, "owner draft", now, otherCreationDraftID, outsiderID); err != nil {
		t.Fatal(err)
	}

	store := NewWorkspaceStore(pool)
	home, err := store.Home(context.Background(), ownerID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(home.ProgressingGoals) != 2 || home.ProgressingGoals[0].ID != active.goalID || home.ProgressingGoals[1].ID != review.goalID {
		t.Fatalf("owner Home Goal order = %#v", home.ProgressingGoals)
	}
	if current := home.ProgressingGoals[0].CurrentWork; current == nil || current.Kind != "active_cycle" ||
		current.CycleID != active.cycleID || current.CycleSequenceNumber != 1 {
		t.Fatalf("active currentWork = %#v", current)
	}
	if current := home.ProgressingGoals[1].CurrentWork; current == nil || current.Kind != "goal_review" ||
		current.ReviewDraftID != review.reviewDraftID || current.TriggerCycleID != review.cycleID ||
		current.TriggerCycleSequenceNumber != 1 {
		t.Fatalf("review currentWork = %#v", current)
	}
	if home.CreationDraft == nil || home.CreationDraft.ID != ownerCreationDraftID || home.CreationDraft.Body != "owner draft" ||
		home.CanCreateGoalDraft || home.CanStartProgressingGoal || home.ProgressingGoalLimit != 2 {
		t.Fatalf("owner Home draft/limit = %#v", home)
	}
	for _, item := range home.ProgressingGoals {
		if item.ID == outsider.goalID {
			t.Fatalf("owner Home exposed outsider Goal %s", item.ID)
		}
	}

	creation, err := store.GetDraft(context.Background(), ownerID, ownerCreationDraftID)
	if err != nil || creation.ID != ownerCreationDraftID || creation.Revision != 4 {
		t.Fatalf("owner creation Draft = %#v, error = %v", creation, err)
	}
	if _, err = store.GetDraft(context.Background(), ownerID, otherCreationDraftID); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("cross-owner creation Draft error = %v", err)
	}
	if _, err = store.GetDraft(context.Background(), ownerID, review.reviewDraftID); !errors.Is(err, workspace.ErrDraftTypeMismatch) {
		t.Fatalf("review Draft through creation read error = %v", err)
	}

	reviewView, err := store.GetReview(context.Background(), ownerID, review.goalID)
	if err != nil {
		t.Fatal(err)
	}
	if reviewView.Goal.ID != review.goalID || reviewView.ReviewDraft.ID != review.reviewDraftID ||
		reviewView.ReviewDraft.Revision != 2 || reviewView.TriggerCycle.ID != review.cycleID ||
		reviewView.TriggerCycle.Status != "completed" {
		t.Fatalf("owner Review = %#v", reviewView)
	}
	if _, err = store.GetReview(context.Background(), outsiderID, review.goalID); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("cross-owner Review error = %v", err)
	}
}

func TestWorkspaceStoreGetReviewUsesOneSnapshotAcrossNextReviewGeneration(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID                    = "10000000-0000-7000-8000-000000000001"
		firstReviewDraftID        = "61000000-0000-7000-8000-000000000501"
		firstCompleteOperationID  = "71000000-0000-7000-8000-000000000501"
		continueOperationID       = "72000000-0000-7000-8000-000000000501"
		secondCycleID             = "41000000-0000-7000-8000-000000000501"
		secondCompleteOperationID = "71000000-0000-7000-8000-000000000502"
		secondReviewDraftID       = "61000000-0000-7000-8000-000000000502"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	baseStore := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	firstReview := prepareReviewTransitionReview(
		t, baseStore, userID, fixture, 2, firstReviewDraftID, firstCompleteOperationID, now,
	)

	config := pool.Config()
	config.ConnConfig.Tracer = &goalReviewSnapshotTracer{}
	config.MinConns = 0
	config.MaxConns = 1
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)
	tracedStore := NewWorkspaceStore(tracedPool)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	barrier := newGoalReviewSnapshotBarrier()
	defer func() {
		barrier.release()
		cancel()
	}()
	type reviewResult struct {
		view workspace.ReviewView
		err  error
	}
	results := make(chan reviewResult, 1)
	go func() {
		queryCtx := context.WithValue(ctx, goalReviewSnapshotContextKey{}, barrier)
		view, queryErr := tracedStore.GetReview(queryCtx, userID, fixture.goalID)
		results <- reviewResult{view: view, err: queryErr}
	}()

	select {
	case <-barrier.draftReadStarted:
	case <-ctx.Done():
		t.Fatalf("GetReview did not reach its Review Draft read: %v", ctx.Err())
	}

	continued, err := executeContinueReviewUseCase(baseStore, ctx, workspace.ContinueReviewInput{
		UserID: userID, GoalID: fixture.goalID, OperationID: continueOperationID,
		ExpectedGoalRevision: firstReview.Goal.Revision, ExpectedDraftRevision: firstReview.ReviewDraft.Revision,
		CycleID: secondCycleID, Now: now.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if continued.VersionCreated {
		t.Fatal("unchanged Review unexpectedly created a Goal Version")
	}
	saveAllAutosaveFrames(t, baseStore, fixture.goalID, secondCycleID, now.Add(4*time.Minute))
	secondReview, err := executeCycleCompleteUseCase(baseStore, ctx, workspace.CompleteCycleInput{
		UserID: userID, GoalID: fixture.goalID, CycleID: secondCycleID,
		OperationID: secondCompleteOperationID, ExpectedGoalRevision: continued.Goal.Revision,
		ExpectedContentRevision: 4,
	}, now.Add(5*time.Minute), secondReviewDraftID)
	if err != nil {
		t.Fatal(err)
	}
	barrier.release()

	select {
	case result := <-results:
		if result.err != nil {
			t.Fatalf("in-flight Review A error = %v", result.err)
		}
		assertGoalReviewMatchesCompletion(t, result.view, firstReview)
	case <-ctx.Done():
		t.Fatalf("GetReview did not finish after releasing its Draft read: %v", ctx.Err())
	}

	fresh, err := baseStore.GetReview(ctx, userID, fixture.goalID)
	if err != nil {
		t.Fatal(err)
	}
	assertGoalReviewMatchesCompletion(t, fresh, secondReview)
	if fresh.ReviewDraft.ID == firstReview.ReviewDraft.ID || fresh.TriggerCycle.ID == firstReview.CompletedCycle.ID {
		t.Fatalf("fresh Review did not advance generations: %#v", fresh)
	}
}

func assertGoalReviewMatchesCompletion(
	t *testing.T,
	view workspace.ReviewView,
	completed workspace.CompleteCycleResult,
) {
	t.Helper()
	if view.Goal.ID != completed.Goal.ID || view.Goal.Status != completed.Goal.Status ||
		view.Goal.Revision != completed.Goal.Revision ||
		view.Goal.CurrentVersion.ID != completed.Goal.CurrentVersion.ID ||
		view.Goal.NextCycleSequenceNumber != completed.Goal.NextCycleSequenceNumber ||
		view.Goal.CurrentWork == nil || completed.Goal.CurrentWork == nil ||
		*view.Goal.CurrentWork != *completed.Goal.CurrentWork {
		t.Fatalf("Review Goal = %#v, want completion Goal %#v", view.Goal, completed.Goal)
	}
	if view.ReviewDraft.ID != completed.ReviewDraft.ID ||
		view.ReviewDraft.DraftType != completed.ReviewDraft.DraftType ||
		view.ReviewDraft.Body != completed.ReviewDraft.Body ||
		view.ReviewDraft.Revision != completed.ReviewDraft.Revision ||
		!sameOptionalString(view.ReviewDraft.GoalID, completed.ReviewDraft.GoalID) ||
		!sameOptionalString(view.ReviewDraft.BaseGoalVersionID, completed.ReviewDraft.BaseGoalVersionID) ||
		!sameOptionalString(view.ReviewDraft.ReviewCycleID, completed.ReviewDraft.ReviewCycleID) {
		t.Fatalf("Review Draft = %#v, want completion Draft %#v", view.ReviewDraft, completed.ReviewDraft)
	}
	if view.TriggerCycle.ID != completed.CompletedCycle.ID ||
		view.TriggerCycle.GoalID != completed.CompletedCycle.GoalID ||
		view.TriggerCycle.GoalVersion.ID != completed.CompletedCycle.GoalVersion.ID ||
		view.TriggerCycle.SequenceNumber != completed.CompletedCycle.SequenceNumber ||
		view.TriggerCycle.Status != completed.CompletedCycle.Status {
		t.Fatalf("Trigger Cycle = %#v, want completed Cycle %#v", view.TriggerCycle, completed.CompletedCycle)
	}
}

func sameOptionalString(first, second *string) bool {
	if first == nil || second == nil {
		return first == nil && second == nil
	}
	return *first == *second
}

func TestGoalReadModelsFailClosedOnIncompleteLeftJoinState(t *testing.T) {
	t.Run("active Goal without active Cycle", func(t *testing.T) {
		pool := integrationPool(t)
		resetDatabase(t, pool)
		now := integrationNow()
		const (
			userID    = "10000000-0000-7000-8000-000000000001"
			goalID    = "20000000-0000-7000-8000-000000000001"
			versionID = "30000000-0000-7000-8000-000000000001"
			operation = "50000000-0000-7000-8000-000000000001"
		)
		seedGoalQueryUser(t, pool, userID, now)
		if _, err := pool.Exec(context.Background(), `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,$3,$3)`, goalID, userID, now); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(context.Background(), `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'active goal',$4,$5)`, versionID, userID, goalID, operation, now); err != nil {
			t.Fatal(err)
		}
		store := NewWorkspaceStore(pool)
		if _, err := store.Home(context.Background(), userID, 2); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
			t.Fatalf("Home incomplete active Goal error = %v", err)
		}
		if _, err := store.QueryGoal(context.Background(), userID, goalID); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
			t.Fatalf("Get incomplete active Goal error = %v", err)
		}
	})

	t.Run("review Goal without review Draft", func(t *testing.T) {
		pool := integrationPool(t)
		resetDatabase(t, pool)
		now := integrationNow()
		const (
			userID    = "10000000-0000-7000-8000-000000000001"
			goalID    = "20000000-0000-7000-8000-000000000001"
			versionID = "30000000-0000-7000-8000-000000000001"
			operation = "50000000-0000-7000-8000-000000000001"
		)
		seedGoalQueryUser(t, pool, userID, now)
		if _, err := pool.Exec(context.Background(), `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'goal_review',1,2,$3,$3)`, goalID, userID, now); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(context.Background(), `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'review goal',$4,$5)`, versionID, userID, goalID, operation, now); err != nil {
			t.Fatal(err)
		}
		store := NewWorkspaceStore(pool)
		_, err := store.GetReview(context.Background(), userID, goalID)
		if !errors.Is(err, workspace.ErrGoalReviewInvariant) || !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
			t.Fatalf("Review without Draft error = %v, want Review and Goal persistence invariants", err)
		}
	})

	t.Run("terminal Goal with active Cycle", func(t *testing.T) {
		pool := integrationPool(t)
		resetDatabase(t, pool)
		now := integrationNow()
		const (
			userID      = "10000000-0000-7000-8000-000000000001"
			goalID      = "20000000-0000-7000-8000-000000000001"
			versionID   = "30000000-0000-7000-8000-000000000001"
			cycleID     = "40000000-0000-7000-8000-000000000001"
			operationID = "50000000-0000-7000-8000-000000000001"
			termination = "51000000-0000-7000-8000-000000000001"
		)
		seedGoalQueryUser(t, pool, userID, now)
		seedGoalQueryFixture(t, pool, userID, goalQueryFixture{
			goalID: goalID, versionID: versionID, operation: termination,
			status: goal.StatusEnded, sortTime: now,
		}, now)
		if _, err := pool.Exec(context.Background(), `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,$6,'start-hash',$5,$5)`,
			cycleID, userID, goalID, versionID, now, operationID); err != nil {
			t.Fatal(err)
		}
		useCases := newGoalQueryIntegrationUseCases(NewWorkspaceStore(pool))
		if _, err := useCases.ListGoals(context.Background(), userID, "history", "", 20); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
			t.Fatalf("List terminal Goal with active Cycle error = %v", err)
		}
	})
}
