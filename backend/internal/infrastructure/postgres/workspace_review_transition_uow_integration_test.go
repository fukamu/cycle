package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

func TestWorkspaceStoreWithinReviewTransitionTransactionIsReadCommittedAndAtomic(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})

	committedAt := now.Add(time.Minute)
	if err := store.WithinReviewTransitionTransaction(context.Background(), func(port workspace.ReviewTransitionTx) error {
		transaction, ok := port.(*workspaceReviewTransitionTx)
		if !ok {
			t.Fatalf("Review transition type = %T", port)
		}
		var isolation string
		if queryErr := transaction.workspaceCycleTx.tx.QueryRow(context.Background(), "SHOW transaction_isolation").Scan(&isolation); queryErr != nil {
			return queryErr
		}
		if isolation != "read committed" {
			t.Fatalf("Review transition isolation = %q", isolation)
		}
		_, execErr := transaction.workspaceCycleTx.tx.Exec(context.Background(),
			`UPDATE users SET last_active_at=$2 WHERE id=$1`, userID, committedAt)
		return execErr
	}); err != nil {
		t.Fatal(err)
	}
	assertCycleTestUserLastActiveAt(t, pool, userID, committedAt)

	sentinel := errors.New("rollback Review transition")
	rolledBackAt := now.Add(2 * time.Minute)
	if err := store.WithinReviewTransitionTransaction(context.Background(), func(port workspace.ReviewTransitionTx) error {
		transaction := port.(*workspaceReviewTransitionTx)
		if _, execErr := transaction.workspaceCycleTx.tx.Exec(context.Background(),
			`UPDATE users SET last_active_at=$2 WHERE id=$1`, userID, rolledBackAt); execErr != nil {
			return execErr
		}
		return sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("rollback error = %v", err)
	}
	assertCycleTestUserLastActiveAt(t, pool, userID, committedAt)
}

func TestReviewTransitionTxOwnerScopesParentLocks(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		ownerID    = "10000000-0000-7000-8000-000000000001"
		outsiderID = "10000000-0000-7000-8000-000000000002"
	)
	insertAIConcurrencyUser(t, pool, ownerID, now)
	insertAIConcurrencyUser(t, pool, outsiderID, now)
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
	fixture := progressingGoalFixtures()[0]
	_ = startProgressingGoal(t, store, ownerID, fixture, 2, now)

	if err := store.WithinReviewTransitionTransaction(context.Background(), func(tx workspace.ReviewTransitionTx) error {
		if _, lockErr := tx.LockGoal(context.Background(), outsiderID, fixture.goalID); !errors.Is(lockErr, workspace.ErrGoalNotFound) {
			t.Fatalf("cross-user LockGoal error = %v", lockErr)
		}
		if _, lockErr := tx.LockCycle(context.Background(), outsiderID, fixture.goalID, fixture.cycleID); !errors.Is(lockErr, workspace.ErrCycleNotFound) {
			t.Fatalf("cross-user LockCycle error = %v", lockErr)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
