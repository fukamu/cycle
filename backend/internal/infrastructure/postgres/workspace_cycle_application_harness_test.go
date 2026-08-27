package postgres

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

type cycleApplicationTestClock struct {
	now time.Time
}

func (clock cycleApplicationTestClock) Now() time.Time { return clock.now }

type cycleApplicationTestIDs struct {
	mu    sync.Mutex
	items []string
	next  int
}

func (ids *cycleApplicationTestIDs) NewID() (string, error) {
	ids.mu.Lock()
	defer ids.mu.Unlock()
	if ids.next >= len(ids.items) {
		return "", errors.New("cycle application test ID sequence exhausted")
	}
	value := ids.items[ids.next]
	ids.next++
	return value, nil
}

func newCycleApplicationTestUseCases(
	store *WorkspaceStore,
	now time.Time,
	generatedIDs ...string,
) *workspace.CycleUseCases {
	return workspace.NewCycleUseCases(
		store,
		store,
		cycleApplicationTestClock{now: now},
		&cycleApplicationTestIDs{items: append([]string(nil), generatedIDs...)},
		workspace.CycleUseCaseSettings{CursorSigningKey: []byte("cycle-test-cursor-key")},
	)
}

func executeCycleListUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID, goalID, cursor string,
	limit int,
	now time.Time,
) (workspace.CyclePage, error) {
	return newCycleApplicationTestUseCases(store, now).ListCycles(ctx, userID, goalID, cursor, limit)
}

func executeCycleGetUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	userID, goalID, cycleID string,
	now time.Time,
) (workspace.CycleView, error) {
	return newCycleApplicationTestUseCases(store, now).GetCycle(ctx, userID, goalID, cycleID)
}

func executeCycleSaveUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.SaveFrameInput,
	now time.Time,
) (workspace.SaveFrameResult, error) {
	return newCycleApplicationTestUseCases(store, now).SaveFrame(ctx, input)
}

func executeCycleCompleteUseCase(
	store *WorkspaceStore,
	ctx context.Context,
	input workspace.CompleteCycleInput,
	now time.Time,
	reviewDraftID string,
) (workspace.CompleteCycleResult, error) {
	return newCycleApplicationTestUseCases(store, now, reviewDraftID).CompleteCycle(ctx, input)
}
