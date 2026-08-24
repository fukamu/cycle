package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

type reviewTransitionUserLockCall struct {
	name string
	err  error
}

func TestReviewTransitionTxLockUserUsesSharedBlockingRowLock(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const userID = "10000000-0000-7000-8000-000000000001"
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	firstLocked := make(chan uint32, 1)
	secondStarted := make(chan uint32, 1)
	releaseFirst := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(releaseFirst)
		}
	}()
	calls := make(chan reviewTransitionUserLockCall, 2)
	go func() {
		err := store.WithinReviewTransitionTransaction(ctx, func(tx workspace.ReviewTransitionTx) error {
			concrete := tx.(*workspaceReviewTransitionTx)
			if lockErr := tx.LockUser(ctx, userID); lockErr != nil {
				return lockErr
			}
			firstLocked <- concrete.workspaceCycleTx.tx.Conn().PgConn().PID()
			select {
			case <-releaseFirst:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		calls <- reviewTransitionUserLockCall{name: "first", err: err}
	}()

	var firstPID uint32
	select {
	case firstPID = <-firstLocked:
	case call := <-calls:
		t.Fatalf("first LockUser returned before barrier: %#v", call)
	case <-ctx.Done():
		t.Fatalf("first LockUser did not acquire row lock: %v", ctx.Err())
	}

	go func() {
		err := store.WithinReviewTransitionTransaction(ctx, func(tx workspace.ReviewTransitionTx) error {
			concrete := tx.(*workspaceReviewTransitionTx)
			secondStarted <- concrete.workspaceCycleTx.tx.Conn().PgConn().PID()
			return tx.LockUser(ctx, userID)
		})
		calls <- reviewTransitionUserLockCall{name: "second", err: err}
	}()
	var secondPID uint32
	select {
	case secondPID = <-secondStarted:
	case call := <-calls:
		t.Fatalf("second LockUser returned before starting: %#v", call)
	case <-ctx.Done():
		t.Fatalf("second LockUser did not start: %v", ctx.Err())
	}
	if err := waitForBlockedBackend(ctx, pool, secondPID, firstPID); err != nil {
		t.Fatalf("ReviewTransitionTx.LockUser backend %d did not wait for %d: %v",
			secondPID, firstPID, err)
	}
	close(releaseFirst)
	released = true

	for range 2 {
		select {
		case call := <-calls:
			if call.err != nil {
				t.Fatalf("%s LockUser error = %v", call.name, call.err)
			}
		case <-ctx.Done():
			t.Fatalf("LockUser calls did not finish: %v", ctx.Err())
		}
	}
}
