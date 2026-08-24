package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWorkspaceStoreWithinCycleTransactionIsReadCommittedAndAtomic(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})

	committedAt := now.Add(time.Minute)
	if err := store.WithinCycleTransaction(context.Background(), func(port workspace.CycleTx) error {
		transaction, ok := port.(*workspaceCycleTx)
		if !ok {
			t.Fatalf("Cycle transaction type = %T", port)
		}
		var isolation string
		if err := transaction.tx.QueryRow(context.Background(), "SHOW transaction_isolation").Scan(&isolation); err != nil {
			return err
		}
		if isolation != "read committed" {
			t.Fatalf("Cycle transaction isolation = %q", isolation)
		}
		_, err := transaction.tx.Exec(context.Background(), `UPDATE users SET last_active_at=$2 WHERE id=$1`, userID, committedAt)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	assertCycleTestUserLastActiveAt(t, pool, userID, committedAt)

	sentinel := errors.New("rollback Cycle transaction")
	rolledBackAt := now.Add(2 * time.Minute)
	if err := store.WithinCycleTransaction(context.Background(), func(port workspace.CycleTx) error {
		transaction := port.(*workspaceCycleTx)
		if _, execErr := transaction.tx.Exec(context.Background(), `UPDATE users SET last_active_at=$2 WHERE id=$1`, userID, rolledBackAt); execErr != nil {
			return execErr
		}
		return sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("rollback error = %v", err)
	}
	assertCycleTestUserLastActiveAt(t, pool, userID, committedAt)
}

func TestCycleTxSeparatesGoalAndCycleNotFound(t *testing.T) {
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
	fixtures := progressingGoalFixtures()
	_ = startProgressingGoal(t, store, ownerID, fixtures[0], 2, now)
	_ = startProgressingGoal(t, store, ownerID, fixtures[1], 2, now)

	if err := store.WithinCycleTransaction(context.Background(), func(tx workspace.CycleTx) error {
		if _, lockErr := tx.LockGoal(context.Background(), outsiderID, fixtures[0].goalID); !errors.Is(lockErr, workspace.ErrGoalNotFound) {
			t.Fatalf("cross-user LockGoal error = %v", lockErr)
		}
		if _, lockErr := tx.LockCycle(context.Background(), ownerID, fixtures[0].goalID, fixtures[1].cycleID); !errors.Is(lockErr, workspace.ErrCycleNotFound) {
			t.Fatalf("mismatched LockCycle error = %v", lockErr)
		}
		if _, lockErr := tx.LockCycle(context.Background(), outsiderID, fixtures[0].goalID, fixtures[0].cycleID); !errors.Is(lockErr, workspace.ErrCycleNotFound) {
			t.Fatalf("cross-user LockCycle error = %v", lockErr)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func assertCycleTestUserLastActiveAt(t *testing.T, pool *pgxpool.Pool, userID string, expected time.Time) {
	t.Helper()
	var actual time.Time
	if err := pool.QueryRow(context.Background(), `SELECT last_active_at FROM users WHERE id=$1`, userID).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	if !actual.Equal(expected) {
		t.Fatalf("last_active_at = %v, want %v", actual, expected)
	}
}
