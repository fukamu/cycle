package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

var _ workspace.CycleQueryRepository = (*WorkspaceStore)(nil)

func (store *WorkspaceStore) QueryCycleRows(
	ctx context.Context,
	query workspace.CycleListQuery,
) (found []workspace.CycleSummary, err error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	queries := store.queries.WithTx(tx)

	goalExists, err := queries.OwnedGoalExistsForCycleRead(ctx, db.OwnedGoalExistsForCycleReadParams{
		GoalID: mustUUID(query.GoalID),
		UserID: mustUUID(query.UserID),
	})
	if err != nil {
		return nil, err
	}
	if !goalExists {
		return nil, workspace.ErrGoalNotFound
	}

	var afterSequence *int32
	var afterCycleID pgtype.UUID
	if query.After != nil {
		afterSequence = &query.After.SequenceNumber
		afterCycleID = mustUUID(query.After.CycleID)
	}
	rows, err := queries.ListCycleSummaries(ctx, db.ListCycleSummariesParams{
		UserID:              mustUUID(query.UserID),
		GoalID:              mustUUID(query.GoalID),
		AfterSequenceNumber: afterSequence,
		AfterCycleID:        afterCycleID,
		FetchLimit:          int32(query.FetchLimit),
	})
	if err != nil {
		return nil, err
	}
	found = make([]workspace.CycleSummary, 0, len(rows))
	for _, row := range rows {
		item, mapErr := cycleSummaryFromReadRow(row)
		if mapErr != nil {
			return nil, mapErr
		}
		found = append(found, item)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return found, nil
}

func (store *WorkspaceStore) QueryCycle(
	ctx context.Context,
	userID, goalID, cycleID string,
) (view workspace.CycleView, err error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return workspace.CycleView{}, err
	}
	defer rollback(ctx, tx)
	queries := store.queries.WithTx(tx)

	goalExists, err := queries.OwnedGoalExistsForCycleRead(ctx, db.OwnedGoalExistsForCycleReadParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if err != nil {
		return workspace.CycleView{}, err
	}
	if !goalExists {
		return workspace.CycleView{}, workspace.ErrGoalNotFound
	}
	view, err = queryCycleView(ctx, tx, userID, goalID, cycleID)
	if err != nil {
		return workspace.CycleView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return workspace.CycleView{}, err
	}
	return view, nil
}

func queryCycleView(
	ctx context.Context,
	query db.DBTX,
	userID, goalID, cycleID string,
) (workspace.CycleView, error) {
	row, err := db.New(query).GetCycleView(ctx, db.GetCycleViewParams{
		CycleID: mustUUID(cycleID),
		GoalID:  mustUUID(goalID),
		UserID:  mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.CycleView{}, workspace.ErrCycleNotFound
	}
	if err != nil {
		return workspace.CycleView{}, err
	}
	return cycleViewFromReadRow(row)
}
