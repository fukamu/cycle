package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type workspaceGoalTx struct {
	tx      pgx.Tx
	queries *db.Queries
}

func (store *WorkspaceStore) WithinGoalTransaction(
	ctx context.Context,
	operation func(workspace.GoalTx) error,
) error {
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	if err = operation(&workspaceGoalTx{tx: tx, queries: store.queries.WithTx(tx)}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (transaction *workspaceGoalTx) LockUser(ctx context.Context, userID string) error {
	if err := lockUser(ctx, transaction.tx, user.ID(userID)); errors.Is(err, pgx.ErrNoRows) {
		return workspace.ErrNotFound
	} else {
		return err
	}
}

func (transaction *workspaceGoalTx) FindGoalDeleteReceipt(
	ctx context.Context,
	userID, idempotencyKey string,
) (*workspace.GoalDeleteReceipt, error) {
	row, err := transaction.queries.FindGoalDeleteReceipt(ctx, db.FindGoalDeleteReceiptParams{
		UserID:         mustUUID(userID),
		IdempotencyKey: mustUUID(idempotencyKey),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return goalDeleteReceiptFromRow(row)
}

func goalDeleteReceiptFromRow(row *db.FindGoalDeleteReceiptRow) (*workspace.GoalDeleteReceipt, error) {
	if row == nil {
		return nil, fmt.Errorf("%w: receipt row is nil", workspace.ErrGoalPersistenceInvariant)
	}
	if !row.DeletedGoalID.Valid {
		return nil, fmt.Errorf("%w: receipt deleted_goal_id is invalid", workspace.ErrGoalPersistenceInvariant)
	}
	if row.RequestHash == "" {
		return nil, fmt.Errorf("%w: receipt request_hash is empty", workspace.ErrGoalPersistenceInvariant)
	}
	if !row.ExpiresAt.Valid || row.ExpiresAt.InfinityModifier != pgtype.Finite {
		return nil, fmt.Errorf("%w: receipt expires_at is invalid or non-finite", workspace.ErrGoalPersistenceInvariant)
	}
	return &workspace.GoalDeleteReceipt{
		GoalID:      uuidString(row.DeletedGoalID),
		RequestHash: row.RequestHash,
		ExpiresAt:   row.ExpiresAt.Time,
	}, nil
}

func (transaction *workspaceGoalTx) LockGoalForDelete(
	ctx context.Context,
	userID, goalID string,
) (workspace.GoalDeleteTarget, error) {
	revision, err := transaction.queries.LockGoalForDelete(ctx, db.LockGoalForDeleteParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalDeleteTarget{}, workspace.ErrNotFound
	}
	return workspace.GoalDeleteTarget{Revision: revision}, err
}

func (transaction *workspaceGoalTx) LockGoalDraftIDs(
	ctx context.Context,
	userID, goalID string,
) ([]string, error) {
	rows, err := transaction.queries.LockGoalDraftIDs(ctx, db.LockGoalDraftIDsParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if err != nil {
		return nil, err
	}
	return goalDeleteDraftIDsFromRows(rows)
}

func goalDeleteDraftIDsFromRows(rows []pgtype.UUID) ([]string, error) {
	ids := make([]string, 0, len(rows))
	for _, id := range rows {
		if !id.Valid {
			return nil, fmt.Errorf("%w: locked Goal Draft id is invalid", workspace.ErrGoalPersistenceInvariant)
		}
		ids = append(ids, uuidString(id))
	}
	return ids, nil
}

func (transaction *workspaceGoalTx) LockGoalCycleIDs(
	ctx context.Context,
	userID, goalID string,
) ([]string, error) {
	rows, err := transaction.queries.LockGoalCycleIDs(ctx, db.LockGoalCycleIDsParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if err != nil {
		return nil, err
	}
	return cycleIDsFromSQLC(rows)
}

func (transaction *workspaceGoalTx) LockRunningGoalGenerations(
	ctx context.Context,
	userID, goalID string,
) ([]workspace.GoalDeleteGeneration, error) {
	rows, err := transaction.queries.LockRunningGoalGenerations(ctx, db.LockRunningGoalGenerationsParams{
		UserID: mustUUID(userID),
		GoalID: mustUUID(goalID),
	})
	if err != nil {
		return nil, err
	}
	return goalDeleteGenerationsFromSQLC(rows)
}

func (transaction *workspaceGoalTx) SumLockedGoalReservationsByMonth(
	ctx context.Context,
	userID, goalID string,
	generationIDs []string,
) ([]workspace.MonthlyReservation, error) {
	if len(generationIDs) == 0 {
		return []workspace.MonthlyReservation{}, nil
	}
	rows, err := transaction.queries.SumLockedGoalReservationsByMonth(
		ctx,
		db.SumLockedGoalReservationsByMonthParams{
			UserID:        mustUUID(userID),
			GoalID:        mustUUID(goalID),
			GenerationIds: generationIDs,
		},
	)
	if err != nil {
		return nil, err
	}
	return goalDeleteMonthlyReservationsFromSQLC(rows)
}

func (transaction *workspaceGoalTx) ReleaseGoalBudgetReservationCAS(
	ctx context.Context,
	month time.Time,
	amount string,
	now time.Time,
) (int64, error) {
	return transaction.queries.ReleaseBudgetReservationCAS(ctx, db.ReleaseBudgetReservationCASParams{
		AmountUsd: amount,
		UpdatedAt: timestamptz(now),
		MonthUtc:  goalDeleteDate(month),
	})
}

func (transaction *workspaceGoalTx) TerminalizeGoalGenerationCAS(
	ctx context.Context,
	userID, goalID string,
	generation workspace.GoalDeleteGeneration,
	now time.Time,
) (int64, error) {
	return transaction.queries.TerminalizeGoalGenerationCAS(ctx, db.TerminalizeGoalGenerationCASParams{
		FinishedAt:             timestamptz(now),
		GenerationID:           mustUUID(generation.ID),
		UserID:                 mustUUID(userID),
		GoalID:                 mustUUID(goalID),
		ExpectedReservationUsd: generation.ReservedCostUSD,
	})
}

func (transaction *workspaceGoalTx) FailRunningGoalUsageCAS(
	ctx context.Context,
	userID, goalID, operationID string,
) (int64, error) {
	return transaction.queries.FailRunningGoalUsageCAS(ctx, db.FailRunningGoalUsageCASParams{
		OperationID: mustUUID(operationID),
		UserID:      mustUUID(userID),
		GoalID:      mustUUID(goalID),
	})
}

func (transaction *workspaceGoalTx) LockGoalUsages(
	ctx context.Context,
	userID, goalID string,
) ([]workspace.GoalDeleteUsage, error) {
	rows, err := transaction.queries.LockGoalUsages(ctx, db.LockGoalUsagesParams{
		UserID: mustUUID(userID),
		GoalID: mustUUID(goalID),
	})
	if err != nil {
		return nil, err
	}
	return goalDeleteUsagesFromSQLC(rows)
}

func (transaction *workspaceGoalTx) RedactGoalUsagesCAS(
	ctx context.Context,
	userID, goalID string,
	operationIDs []string,
) (int64, error) {
	return transaction.queries.RedactGoalUsagesCAS(ctx, db.RedactGoalUsagesCASParams{
		UserID:       mustUUID(userID),
		GoalID:       mustUUID(goalID),
		OperationIds: operationIDs,
	})
}

func (transaction *workspaceGoalTx) DeleteExpiredFinalizedGoalUsagesCAS(
	ctx context.Context,
	userID, goalID string,
	operationIDs []string,
	now time.Time,
) (int64, error) {
	return transaction.queries.DeleteExpiredFinalizedGoalUsagesCAS(
		ctx,
		db.DeleteExpiredFinalizedGoalUsagesCASParams{
			UserID:       mustUUID(userID),
			GoalID:       mustUUID(goalID),
			OperationIds: operationIDs,
			Now:          timestamptz(now),
		},
	)
}

func (transaction *workspaceGoalTx) DeleteGoalCAS(
	ctx context.Context,
	userID, goalID string,
	expectedRevision int64,
) (int64, error) {
	return transaction.queries.DeleteGoalCAS(ctx, db.DeleteGoalCASParams{
		GoalID:           mustUUID(goalID),
		UserID:           mustUUID(userID),
		ExpectedRevision: expectedRevision,
	})
}

func (transaction *workspaceGoalTx) InsertGoalDeleteReceipt(
	ctx context.Context,
	record workspace.GoalDeleteReceiptRecord,
) (int64, error) {
	return transaction.queries.InsertGoalDeleteReceipt(ctx, db.InsertGoalDeleteReceiptParams{
		UserID:         mustUUID(record.UserID),
		IdempotencyKey: mustUUID(record.IdempotencyKey),
		DeletedGoalID:  mustUUID(record.GoalID),
		RequestHash:    record.RequestHash,
		DeletedAt:      timestamptz(record.DeletedAt),
		ExpiresAt:      timestamptz(record.ExpiresAt),
	})
}
