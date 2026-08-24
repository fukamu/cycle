package postgres

import (
	"context"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

type reviewTransitionIntegrationClock struct{ now time.Time }

func (clock reviewTransitionIntegrationClock) Now() time.Time { return clock.now }

func newReviewTransitionIntegrationUseCases(
	store *WorkspaceStore,
	now time.Time,
	generatedIDs ...string,
) *workspace.ReviewTransitionUseCases {
	return workspace.NewReviewTransitionUseCases(
		store,
		reviewTransitionIntegrationClock{now: now},
		&cycleApplicationTestIDs{items: append([]string(nil), generatedIDs...)},
	)
}

func executeContinueReviewUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.ContinueReviewInput,
) (workspace.ContinueReviewResult, error) {
	generatedIDs := make([]string, 0, 2)
	if input.VersionID != "" {
		generatedIDs = append(generatedIDs, input.VersionID)
	}
	if input.CycleID != "" {
		generatedIDs = append(generatedIDs, input.CycleID)
	}
	return newReviewTransitionIntegrationUseCases(store, input.Now, generatedIDs...).ContinueReview(ctx, input)
}

func executeTerminateGoalUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.TerminateInput,
) (workspace.TerminateResult, error) {
	return newReviewTransitionIntegrationUseCases(store, input.Now).Terminate(ctx, input)
}
