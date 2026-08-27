package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

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
		if _, err := store.GetReview(context.Background(), userID, goalID); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
			t.Fatalf("Review without Draft error = %v", err)
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
