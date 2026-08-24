package postgres

import (
	"context"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

type goalApplicationTestClock struct{ now time.Time }

func (clock goalApplicationTestClock) Now() time.Time { return clock.now }

func newGoalApplicationTestUseCases(store *WorkspaceStore, now time.Time) *workspace.GoalUseCases {
	return workspace.NewGoalUseCases(store, store, goalApplicationTestClock{now: now}, workspace.GoalUseCaseSettings{
		CursorSigningKey: []byte("test-cursor-key"),
	})
}

func executeGoalListUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID, scope, cursor string,
	limit int,
	now time.Time,
) (workspace.GoalPage, error) {
	return newGoalApplicationTestUseCases(store, now).ListGoals(ctx, userID, scope, cursor, limit)
}

func executeGoalGetUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID, goalID string,
	now time.Time,
) (workspace.GoalView, error) {
	return newGoalApplicationTestUseCases(store, now).GetGoal(ctx, userID, goalID)
}

func executeGoalDeleteUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID, goalID string,
	confirmed bool,
	expectedRevision int64,
	idempotencyKey string,
	now time.Time,
) error {
	return newGoalApplicationTestUseCases(store, now).DeleteGoal(
		ctx, userID, goalID, confirmed, expectedRevision, idempotencyKey,
	)
}
