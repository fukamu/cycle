package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

func TestGoalDeleteApplicationReceiptExpirySemantics(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	const (
		userID    = "10000000-0000-7000-8000-000000000001"
		deleteKey = "89000000-0000-7000-8000-000000000001"
	)
	insertAIConcurrencyUser(t, pool, userID, now)
	store := NewWorkspaceStore(pool)
	fixture := progressingGoalFixtures()[0]
	started := startProgressingGoal(t, store, userID, fixture, 2, now)

	if err := executeGoalDeleteUseCase(
		store, context.Background(), userID, fixture.goalID, true, started.Goal.Revision, deleteKey, now,
	); err != nil {
		t.Fatalf("initial DeleteGoal: %v", err)
	}
	if err := executeGoalDeleteUseCase(
		store, context.Background(), userID, fixture.goalID, true, started.Goal.Revision, deleteKey,
		now.Add(24*time.Hour-time.Nanosecond),
	); err != nil {
		t.Fatalf("active receipt replay: %v", err)
	}

	expiredAt := now.Add(24 * time.Hour)
	if err := executeGoalDeleteUseCase(
		store, context.Background(), userID, fixture.goalID, true, started.Goal.Revision, deleteKey, expiredAt,
	); !errors.Is(err, workspace.ErrNotFound) {
		t.Fatalf("expired matching receipt error = %v, want %v", err, workspace.ErrNotFound)
	}
	if err := executeGoalDeleteUseCase(
		store, context.Background(), userID, fixture.goalID, true, started.Goal.Revision+1, deleteKey, expiredAt,
	); !errors.Is(err, workspace.ErrIdempotencyKeyReused) {
		t.Fatalf("expired different-hash receipt error = %v, want %v", err, workspace.ErrIdempotencyKeyReused)
	}

	assertGoalDeleteReceiptCount(t, pool, userID, deleteKey, 1)
}
