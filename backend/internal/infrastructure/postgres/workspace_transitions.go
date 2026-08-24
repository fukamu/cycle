package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

// loadCycleForUpdate centralizes the owner-scoped Cycle lock shared by the
// Action AI transaction adapter.
func loadCycleForUpdate(ctx context.Context, tx pgx.Tx, userID, goalID, cycleID string) (cycle.PDCACycle, error) {
	row, err := db.New(tx).LockCycleForTransition(ctx, db.LockCycleForTransitionParams{
		CycleID: mustUUID(cycleID),
		GoalID:  mustUUID(goalID),
		UserID:  mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return cycle.PDCACycle{}, workspace.ErrNotFound
	}
	if err != nil {
		return cycle.PDCACycle{}, err
	}
	return cycleFromSQLC(row)
}
