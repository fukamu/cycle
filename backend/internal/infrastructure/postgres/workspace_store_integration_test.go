package postgres

import (
	"context"
	"testing"
)

func TestWorkspaceStoreListGoalsReturnsInitialPageWithoutCursor(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-0000-0000-000000000001"
		goalID    = "20000000-0000-0000-0000-000000000001"
		versionID = "30000000-0000-0000-0000-000000000001"
		cycleID   = "40000000-0000-0000-0000-000000000001"
		operation = "50000000-0000-0000-0000-000000000001"
	)
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,last_active_at,created_at,updated_at) VALUES($1,$2,$2,$2)`, []any{userID, now}},
		{`INSERT INTO goals(id,user_id,status,current_version_number,next_cycle_sequence_number,created_at,updated_at)
VALUES($1,$2,'active_cycle',1,2,$3,$3)`, []any{goalID, userID, now}},
		{`INSERT INTO goal_versions(id,user_id,goal_id,version_number,body,created_by_operation_id,created_at)
VALUES($1,$2,$3,1,'Initial page goal',$4,$5)`, []any{versionID, userID, goalID, operation, now}},
		{`INSERT INTO pdca_cycles(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,1,'active',$5,$6,'request-hash',$5,$5)`, []any{cycleID, userID, goalID, versionID, now, operation}},
	}
	for _, statement := range statements {
		if _, err := pool.Exec(context.Background(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{CursorSigningKey: []byte("test-cursor-key")})
	page, err := store.ListGoals(context.Background(), userID, "all", "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != goalID {
		t.Fatalf("items = %#v", page.Items)
	}
	if page.NextCursor != nil {
		t.Fatalf("next cursor = %q, want nil", *page.NextCursor)
	}

	cycles, err := store.ListCycles(context.Background(), userID, goalID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(cycles.Items) != 1 || cycles.Items[0].ID != cycleID {
		t.Fatalf("cycles = %#v", cycles.Items)
	}
	if cycles.NextCursor != nil {
		t.Fatalf("next cycle cursor = %q, want nil", *cycles.NextCursor)
	}
}
