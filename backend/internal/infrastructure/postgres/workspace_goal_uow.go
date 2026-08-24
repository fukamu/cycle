package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type workspaceGoalTx struct {
	tx pgx.Tx
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
	if err = operation(&workspaceGoalTx{tx: tx}); err != nil {
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
	var receipt workspace.GoalDeleteReceipt
	err := transaction.tx.QueryRow(ctx, `SELECT deleted_goal_id,request_hash,expires_at
FROM goal_delete_receipts WHERE user_id=$1 AND idempotency_key=$2`,
		mustUUID(userID), mustUUID(idempotencyKey),
	).Scan(&receipt.GoalID, &receipt.RequestHash, &receipt.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &receipt, nil
}

func (transaction *workspaceGoalTx) LockGoalForDelete(
	ctx context.Context,
	userID, goalID string,
) (workspace.GoalDeleteTarget, error) {
	var target workspace.GoalDeleteTarget
	err := transaction.tx.QueryRow(ctx, `SELECT revision FROM goals
WHERE id=$1 AND user_id=$2 FOR UPDATE`, mustUUID(goalID), mustUUID(userID)).Scan(&target.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.GoalDeleteTarget{}, workspace.ErrNotFound
	}
	return target, err
}

func (transaction *workspaceGoalTx) LockGoalDraftIDs(
	ctx context.Context,
	userID, goalID string,
) ([]string, error) {
	return lockGoalChildIDs(ctx, transaction.tx, `SELECT id FROM goal_drafts
WHERE goal_id=$1 AND user_id=$2 ORDER BY id FOR UPDATE`, goalID, userID)
}

func (transaction *workspaceGoalTx) LockGoalCycleIDs(
	ctx context.Context,
	userID, goalID string,
) ([]string, error) {
	return lockGoalChildIDs(ctx, transaction.tx, `SELECT id FROM pdca_cycles
WHERE goal_id=$1 AND user_id=$2 ORDER BY id FOR UPDATE`, goalID, userID)
}

func lockGoalChildIDs(
	ctx context.Context,
	tx pgx.Tx,
	query, goalID, userID string,
) ([]string, error) {
	rows, err := tx.Query(ctx, query, mustUUID(goalID), mustUUID(userID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (transaction *workspaceGoalTx) LockRunningGoalGenerations(
	ctx context.Context,
	userID, goalID string,
) ([]workspace.GoalDeleteGeneration, error) {
	rows, err := transaction.tx.Query(ctx, `SELECT id,budget_reserved_cost_usd::text FROM ai_generations
WHERE user_id=$1 AND goal_id=$2 AND status='running' ORDER BY id FOR UPDATE`,
		mustUUID(userID), mustUUID(goalID),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]workspace.GoalDeleteGeneration, 0)
	for rows.Next() {
		var item workspace.GoalDeleteGeneration
		if err = rows.Scan(&item.ID, &item.ReservedCostUSD); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalTx) SumLockedGoalReservationsByMonth(
	ctx context.Context,
	userID, goalID string,
	generationIDs []string,
) ([]workspace.MonthlyReservation, error) {
	if len(generationIDs) == 0 {
		return []workspace.MonthlyReservation{}, nil
	}
	rows, err := transaction.tx.Query(ctx, `SELECT budget_month_utc,SUM(budget_reserved_cost_usd)::text
FROM ai_generations
WHERE user_id=$1 AND goal_id=$2 AND id=ANY($3::text[]::uuid[]) AND status='running'
GROUP BY budget_month_utc
HAVING SUM(budget_reserved_cost_usd)>0
ORDER BY budget_month_utc`, mustUUID(userID), mustUUID(goalID), generationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]workspace.MonthlyReservation, 0)
	for rows.Next() {
		var item workspace.MonthlyReservation
		if err = rows.Scan(&item.MonthUtc, &item.AmountUSD); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalTx) ReleaseGoalBudgetReservationCAS(
	ctx context.Context,
	month time.Time,
	amount string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_budget_monthly
SET reserved_cost_usd=reserved_cost_usd-$2::numeric,updated_at=$3
WHERE month_utc=$1 AND reserved_cost_usd >= $2::numeric`, month, amount, now)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalTx) TerminalizeGoalGenerationCAS(
	ctx context.Context,
	userID, goalID string,
	generation workspace.GoalDeleteGeneration,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_generations SET status='failed',failure_code='goal_deleted',
budget_reserved_cost_usd=0,lease_expires_at=NULL,finished_at=$4
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND status='running'
  AND budget_reserved_cost_usd=$5::numeric`,
		mustUUID(generation.ID), mustUUID(userID), mustUUID(goalID), now, generation.ReservedCostUSD,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalTx) FailRunningGoalUsageCAS(
	ctx context.Context,
	userID, goalID, operationID string,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_usage_events
SET goal_id=NULL,status='failed',content_deleted=true
WHERE operation_id=$1 AND user_id=$2 AND goal_id=$3
  AND status='accepted' AND provider_usage_finalized_at IS NULL`,
		mustUUID(operationID), mustUUID(userID), mustUUID(goalID),
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalTx) LockGoalUsages(
	ctx context.Context,
	userID, goalID string,
) ([]workspace.GoalDeleteUsage, error) {
	rows, err := transaction.tx.Query(ctx, `SELECT operation_id,status,quota_retain_until,provider_usage_finalized_at
FROM ai_usage_events WHERE user_id=$1 AND goal_id=$2 ORDER BY operation_id FOR UPDATE`,
		mustUUID(userID), mustUUID(goalID),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]workspace.GoalDeleteUsage, 0)
	for rows.Next() {
		var item workspace.GoalDeleteUsage
		var finalized pgtype.Timestamptz
		if err = rows.Scan(&item.OperationID, &item.Status, &item.QuotaRetainUntil, &finalized); err != nil {
			return nil, err
		}
		if finalized.Valid {
			value := finalized.Time
			item.ProviderUsageFinalizedAt = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (transaction *workspaceGoalTx) RedactGoalUsagesCAS(
	ctx context.Context,
	userID, goalID string,
	operationIDs []string,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `UPDATE ai_usage_events
SET goal_id=NULL,status=CASE WHEN status='accepted' THEN 'failed' ELSE status END,content_deleted=true
WHERE user_id=$1 AND goal_id=$2 AND operation_id=ANY($3::text[]::uuid[])`,
		mustUUID(userID), mustUUID(goalID), operationIDs,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalTx) DeleteExpiredFinalizedGoalUsagesCAS(
	ctx context.Context,
	userID, goalID string,
	operationIDs []string,
	now time.Time,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `DELETE FROM ai_usage_events
WHERE user_id=$1 AND goal_id=$2 AND operation_id=ANY($3::text[]::uuid[])
  AND quota_retain_until <= $4 AND provider_usage_finalized_at IS NOT NULL`,
		mustUUID(userID), mustUUID(goalID), operationIDs, now,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalTx) DeleteGoalCAS(
	ctx context.Context,
	userID, goalID string,
	expectedRevision int64,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `DELETE FROM goals
WHERE id=$1 AND user_id=$2 AND revision=$3`, mustUUID(goalID), mustUUID(userID), expectedRevision)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceGoalTx) InsertGoalDeleteReceipt(
	ctx context.Context,
	record workspace.GoalDeleteReceiptRecord,
) (int64, error) {
	command, err := transaction.tx.Exec(ctx, `INSERT INTO goal_delete_receipts
(user_id,idempotency_key,deleted_goal_id,request_hash,deleted_at,expires_at)
VALUES($1,$2,$3,$4,$5,$6)`,
		mustUUID(record.UserID), mustUUID(record.IdempotencyKey), mustUUID(record.GoalID),
		record.RequestHash, record.DeletedAt, record.ExpiresAt,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}
