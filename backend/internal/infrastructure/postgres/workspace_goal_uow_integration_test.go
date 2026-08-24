package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

func TestWorkspaceStoreWithinGoalTransactionCommitsOnlyNilCallback(t *testing.T) {
	pool := integrationPool(t)
	const userID = "10000000-0000-7000-8000-000000000001"
	now := integrationNow()
	record := workspace.GoalDeleteReceiptRecord{
		UserID:         userID,
		IdempotencyKey: "87000000-0000-7000-8000-000000000001",
		GoalID:         "30000000-0000-7000-8000-000000000001",
		RequestHash:    "goal-uow-test",
		DeletedAt:      now,
		ExpiresAt:      now.Add(24 * time.Hour),
	}

	t.Run("rollback", func(t *testing.T) {
		resetDatabase(t, pool)
		insertAIConcurrencyUser(t, pool, userID, now)
		store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
		sentinel := errors.New("rollback Goal transaction")
		err := store.WithinGoalTransaction(context.Background(), func(tx workspace.GoalTx) error {
			if lockErr := tx.LockUser(context.Background(), userID); lockErr != nil {
				return lockErr
			}
			rows, insertErr := tx.InsertGoalDeleteReceipt(context.Background(), record)
			if insertErr != nil {
				return insertErr
			}
			if rows != 1 {
				t.Fatalf("inserted receipt rows = %d, want 1", rows)
			}
			return sentinel
		})
		if !errors.Is(err, sentinel) {
			t.Fatalf("WithinGoalTransaction error = %v, want sentinel", err)
		}
		assertGoalDeleteReceiptCount(t, pool, userID, record.IdempotencyKey, 0)
	})

	t.Run("commit", func(t *testing.T) {
		resetDatabase(t, pool)
		insertAIConcurrencyUser(t, pool, userID, now)
		store := NewWorkspaceStore(pool, WorkspaceStoreSettings{})
		err := store.WithinGoalTransaction(context.Background(), func(tx workspace.GoalTx) error {
			if lockErr := tx.LockUser(context.Background(), userID); lockErr != nil {
				return lockErr
			}
			rows, insertErr := tx.InsertGoalDeleteReceipt(context.Background(), record)
			if insertErr != nil {
				return insertErr
			}
			if rows != 1 {
				t.Fatalf("inserted receipt rows = %d, want 1", rows)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("WithinGoalTransaction commit: %v", err)
		}
		assertGoalDeleteReceiptCount(t, pool, userID, record.IdempotencyKey, 1)
	})
}

func assertGoalDeleteReceiptCount(
	t *testing.T,
	pool *pgxpool.Pool,
	userID, idempotencyKey string,
	want int,
) {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM goal_delete_receipts
WHERE user_id=$1 AND idempotency_key=$2`, userID, idempotencyKey).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("Goal Delete receipt count = %d, want %d", count, want)
	}
}
