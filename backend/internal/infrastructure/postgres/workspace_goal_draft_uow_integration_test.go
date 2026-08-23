package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestWorkspaceStoreWithinGoalDraftTransactionCommitsOnlyNilCallback(t *testing.T) {
	ctx := context.Background()
	pool := integrationPool(t)
	resetDatabase(t, pool)

	now := integrationNow()
	const (
		userID  = "10000000-0000-7000-8000-000000000099"
		draftID = "11000000-0000-7000-8000-000000000099"
	)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,$2,$2,$2)`, mustUUID(userID), now); err != nil {
		t.Fatal(err)
	}

	draft, err := goal.NewDraft(draftID, userID, "transaction sentinel", now)
	if err != nil {
		t.Fatal(err)
	}
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})

	sentinelError := errors.New("rollback Goal Draft transaction")
	var rollbackRows int64
	err = store.WithinGoalDraftTransaction(ctx, func(tx workspace.GoalDraftTx) error {
		var insertErr error
		rollbackRows, insertErr = tx.InsertCreationDraft(ctx, draft)
		if insertErr != nil {
			return insertErr
		}
		return sentinelError
	})
	if !errors.Is(err, sentinelError) {
		t.Fatalf("transaction error = %v, want %v", err, sentinelError)
	}
	if rollbackRows != 1 {
		t.Fatalf("rollback callback affected rows = %d, want 1", rollbackRows)
	}

	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM goal_drafts WHERE id=$1 AND user_id=$2`,
		mustUUID(draftID), mustUUID(userID),
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("draft count after callback error = %d, want 0", count)
	}

	var commitRows int64
	err = store.WithinGoalDraftTransaction(ctx, func(tx workspace.GoalDraftTx) error {
		var insertErr error
		commitRows, insertErr = tx.InsertCreationDraft(ctx, draft)
		return insertErr
	})
	if err != nil {
		t.Fatal(err)
	}
	if commitRows != 1 {
		t.Fatalf("commit callback affected rows = %d, want 1", commitRows)
	}

	var (
		body     string
		revision int64
	)
	if err = pool.QueryRow(ctx, `SELECT body,revision FROM goal_drafts WHERE id=$1 AND user_id=$2`,
		mustUUID(draftID), mustUUID(userID),
	).Scan(&body, &revision); err != nil {
		t.Fatal(err)
	}
	if body != draft.Body || revision != draft.Revision {
		t.Fatalf("committed draft body/revision = %q/%d, want %q/%d",
			body, revision, draft.Body, draft.Revision)
	}
}
