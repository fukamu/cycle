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

type goalQueryFixture struct {
	goalID    string
	versionID string
	cycleID   string
	operation string
	status    goal.Status
	sortTime  time.Time
}

func seedGoalQueryUser(t *testing.T, pool *pgxpool.Pool, userID string, now time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, userID, now); err != nil {
		t.Fatal(err)
	}
}

func seedGoalQueryFixture(t *testing.T, pool *pgxpool.Pool, userID string, fixture goalQueryFixture, now time.Time) {
	t.Helper()
	if fixture.status == goal.StatusActiveCycle {
		if _, err := pool.Exec(context.Background(), `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,$3,$4)`,
			fixture.goalID, userID, now.Add(-24*time.Hour), fixture.sortTime); err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err := pool.Exec(context.Background(), `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,terminal_at,terminal_operation_id,
 terminal_request_hash,created_at,updated_at)
VALUES($1,$2,$3,1,2,$4,$5,$6,$7,$4)`,
			fixture.goalID, userID, fixture.status, fixture.sortTime, fixture.operation,
			"terminal-"+fixture.goalID, now.Add(-24*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,$4,$5,$6)`,
		fixture.versionID, userID, fixture.goalID, "goal-"+fixture.goalID, fixture.operation, now.Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if fixture.status == goal.StatusActiveCycle {
		if _, err := pool.Exec(context.Background(), `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,$6,$7,$5,$5)`,
			fixture.cycleID, userID, fixture.goalID, fixture.versionID, now.Add(-24*time.Hour),
			fixture.operation, "start-"+fixture.goalID); err != nil {
			t.Fatal(err)
		}
	}
}

func newGoalQueryIntegrationUseCases(store *WorkspaceStore) *workspace.GoalUseCases {
	return workspace.NewGoalUseCases(store, nil, nil, workspace.GoalUseCaseSettings{
		CursorSigningKey: []byte("test-cursor-key"),
	})
}

func goalQueryPageIDs(page workspace.GoalPage) []string {
	ids := make([]string, len(page.Items))
	for index := range page.Items {
		ids[index] = page.Items[index].ID
	}
	return ids
}

func assertGoalQueryIDs(t *testing.T, actual []string, expected ...string) {
	t.Helper()
	if len(actual) != len(expected) {
		t.Fatalf("ids = %v, want %v", actual, expected)
	}
	for index := range expected {
		if actual[index] != expected[index] {
			t.Fatalf("ids = %v, want %v", actual, expected)
		}
	}
}

func TestGoalQueryApplicationOwnsAllScopePaginationAndOwnerBoundary(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		ownerID    = "10000000-0000-7000-8000-000000000001"
		outsiderID = "10000000-0000-7000-8000-000000000002"
	)
	seedGoalQueryUser(t, pool, ownerID, now)
	seedGoalQueryUser(t, pool, outsiderID, now)
	fixtures := []struct {
		userID  string
		fixture goalQueryFixture
	}{
		{ownerID, goalQueryFixture{
			goalID: "20000000-0000-7000-8000-000000000005", versionID: "30000000-0000-7000-8000-000000000005",
			cycleID: "40000000-0000-7000-8000-000000000005", operation: "50000000-0000-7000-8000-000000000005",
			status: goal.StatusActiveCycle, sortTime: now,
		}},
		{ownerID, goalQueryFixture{
			goalID: "20000000-0000-7000-8000-000000000004", versionID: "30000000-0000-7000-8000-000000000004",
			cycleID: "40000000-0000-7000-8000-000000000004", operation: "50000000-0000-7000-8000-000000000004",
			status: goal.StatusActiveCycle, sortTime: now,
		}},
		{ownerID, goalQueryFixture{
			goalID: "20000000-0000-7000-8000-000000000002", versionID: "30000000-0000-7000-8000-000000000002",
			operation: "50000000-0000-7000-8000-000000000002", status: goal.StatusEnded, sortTime: now.Add(-time.Hour),
		}},
		{ownerID, goalQueryFixture{
			goalID: "20000000-0000-7000-8000-000000000001", versionID: "30000000-0000-7000-8000-000000000001",
			operation: "50000000-0000-7000-8000-000000000001", status: goal.StatusAchieved, sortTime: now.Add(-time.Hour),
		}},
		{outsiderID, goalQueryFixture{
			goalID: "20000000-0000-7000-8000-000000000006", versionID: "30000000-0000-7000-8000-000000000006",
			cycleID: "40000000-0000-7000-8000-000000000006", operation: "50000000-0000-7000-8000-000000000006",
			status: goal.StatusActiveCycle, sortTime: now.Add(time.Hour),
		}},
	}
	for _, fixture := range fixtures {
		seedGoalQueryFixture(t, pool, fixture.userID, fixture.fixture, now)
	}

	useCases := newGoalQueryIntegrationUseCases(NewWorkspaceStore(pool, WorkspaceStoreSettings{}))
	first, err := useCases.ListGoals(context.Background(), ownerID, "all", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	assertGoalQueryIDs(t, goalQueryPageIDs(first),
		"20000000-0000-7000-8000-000000000005",
		"20000000-0000-7000-8000-000000000004",
	)
	if first.NextCursor == nil {
		t.Fatal("first all page has no next cursor")
	}
	second, err := useCases.ListGoals(context.Background(), ownerID, "all", *first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	assertGoalQueryIDs(t, goalQueryPageIDs(second),
		"20000000-0000-7000-8000-000000000002",
		"20000000-0000-7000-8000-000000000001",
	)
	if second.NextCursor != nil {
		t.Fatalf("second all page next cursor = %q", *second.NextCursor)
	}

	progressingFirst, err := useCases.ListGoals(context.Background(), ownerID, "progressing", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	assertGoalQueryIDs(t, goalQueryPageIDs(progressingFirst), "20000000-0000-7000-8000-000000000005")
	if progressingFirst.NextCursor == nil {
		t.Fatal("first progressing page has no next cursor")
	}
	progressingSecond, err := useCases.ListGoals(
		context.Background(), ownerID, "progressing", *progressingFirst.NextCursor, 1,
	)
	if err != nil {
		t.Fatal(err)
	}
	assertGoalQueryIDs(t, goalQueryPageIDs(progressingSecond), "20000000-0000-7000-8000-000000000004")

	historyFirst, err := useCases.ListGoals(context.Background(), ownerID, "history", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	assertGoalQueryIDs(t, goalQueryPageIDs(historyFirst), "20000000-0000-7000-8000-000000000002")
	if historyFirst.NextCursor == nil {
		t.Fatal("first history page has no next cursor")
	}
	historySecond, err := useCases.ListGoals(context.Background(), ownerID, "history", *historyFirst.NextCursor, 1)
	if err != nil {
		t.Fatal(err)
	}
	assertGoalQueryIDs(t, goalQueryPageIDs(historySecond), "20000000-0000-7000-8000-000000000001")

	if _, err = useCases.GetGoal(
		context.Background(), ownerID, "20000000-0000-7000-8000-000000000006",
	); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("cross-user GetGoal error = %v", err)
	}
	ownerGoal, err := useCases.GetGoal(
		context.Background(), ownerID, "20000000-0000-7000-8000-000000000005",
	)
	if err != nil || ownerGoal.CurrentWork == nil || ownerGoal.CurrentWork.Kind != "active_cycle" {
		t.Fatalf("owner Goal = %#v, error = %v", ownerGoal, err)
	}
}

func TestGoalQueryApplicationRejectsDatabaseCurrentWorkUnionViolation(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID      = "10000000-0000-7000-8000-000000000001"
		goalID      = "20000000-0000-7000-8000-000000000001"
		versionID   = "30000000-0000-7000-8000-000000000001"
		triggerID   = "40000000-0000-7000-8000-000000000001"
		activeID    = "40000000-0000-7000-8000-000000000002"
		startID     = "50000000-0000-7000-8000-000000000001"
		activeStart = "50000000-0000-7000-8000-000000000002"
		completeID  = "51000000-0000-7000-8000-000000000001"
		draftID     = "60000000-0000-7000-8000-000000000001"
	)
	seedGoalQueryUser(t, pool, userID, now)
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,revision,created_at,updated_at)
VALUES($1,$2,'goal_review',1,2,1,$3,$3)`, []any{goalID, userID, now}},
		{`INSERT INTO goal_versions
(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'review goal',$4,$5)`, []any{versionID, userID, goalID, startID, now}},
		{`INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,completed_at,
 plan,do_text,check_text,action,start_operation_id,start_request_hash,
 completion_operation_id,completion_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'completed',$5,$6,'P','D','C','A',$7,'start-hash',$8,'complete-hash',$5,$6)`,
			[]any{triggerID, userID, goalID, versionID, now.Add(-time.Hour), now, startID, completeID}},
		{`INSERT INTO goal_drafts
(id,user_id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,created_at,updated_at)
VALUES($1,$2,'review',$3,$4,$5,'review goal',0,$6,$6)`,
			[]any{draftID, userID, goalID, versionID, triggerID, now}},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(context.Background(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	useCases := newGoalQueryIntegrationUseCases(NewWorkspaceStore(pool, WorkspaceStoreSettings{}))
	valid, err := useCases.GetGoal(context.Background(), userID, goalID)
	if err != nil || valid.CurrentWork == nil || valid.CurrentWork.Kind != "goal_review" {
		t.Fatalf("valid review Goal = %#v, error = %v", valid, err)
	}

	if _, err = pool.Exec(context.Background(), `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,2,'active',$5,$6,'active-start-hash',$5,$5)`,
		activeID, userID, goalID, versionID, now, activeStart); err != nil {
		t.Fatal(err)
	}
	if _, err = useCases.GetGoal(context.Background(), userID, goalID); err == nil ||
		!errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("invalid currentWork union error = %v", err)
	}
}
