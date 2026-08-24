package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

func TestGoalQueryApplicationFailsClosedWhenCurrentVersionIsMissing(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID          = "10000000-0000-7000-8000-000000000001"
		terminalGoalID  = "20000000-0000-7000-8000-000000000001"
		terminalEventID = "50000000-0000-7000-8000-000000000001"
		activeGoalID    = "20000000-0000-7000-8000-000000000002"
	)
	seedGoalQueryUser(t, pool, userID, now)
	if _, err := pool.Exec(context.Background(), `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,revision,terminal_at,
 terminal_operation_id,terminal_request_hash,created_at,updated_at)
VALUES($1,$2,'ended',1,2,3,$3,$4,'missing-current-version',$3,$3)`,
		terminalGoalID, userID, now, terminalEventID,
	); err != nil {
		t.Fatal(err)
	}

	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
	useCases := newGoalQueryIntegrationUseCases(store)
	if _, err := useCases.ListGoals(context.Background(), userID, "all", "", 20); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("ListGoals missing current Version error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}
	if _, err := useCases.GetGoal(context.Background(), userID, terminalGoalID); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("GetGoal missing current Version error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}
	if _, err := store.GetReview(context.Background(), userID, terminalGoalID); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("GetReview missing current Version error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}

	if _, err := pool.Exec(context.Background(), `INSERT INTO goals
(id,user_id,status,current_version_number,next_cycle_sequence_number,revision,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,0,$3,$3)`, activeGoalID, userID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Home(context.Background(), userID, 2); !errors.Is(err, workspace.ErrGoalPersistenceInvariant) {
		t.Fatalf("Home missing current Version error = %v, want %v", err, workspace.ErrGoalPersistenceInvariant)
	}
}
