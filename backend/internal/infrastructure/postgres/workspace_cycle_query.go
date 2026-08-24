package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
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

	var goalExists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM goals WHERE id=$1 AND user_id=$2
)`, mustUUID(query.GoalID), mustUUID(query.UserID)).Scan(&goalExists); err != nil {
		return nil, err
	}
	if !goalExists {
		return nil, workspace.ErrGoalNotFound
	}

	var afterSequence any
	var afterCycleID any
	if query.After != nil {
		afterSequence = query.After.SequenceNumber
		afterCycleID = mustUUID(query.After.CycleID)
	}
	rows, err := tx.Query(ctx, `SELECT
c.id,c.sequence_number,c.status,c.started_at,c.completed_at,c.canceled_at,
gv.id,gv.version_number,gv.body,gv.created_at,
CASE WHEN char_length(c.plan)>120 THEN left(c.plan,120)||'…' ELSE c.plan END
FROM pdca_cycles c
LEFT JOIN goal_versions gv ON gv.id=c.goal_version_id AND gv.goal_id=c.goal_id
WHERE c.user_id=$1 AND c.goal_id=$2
  AND ($3::integer IS NULL OR (c.sequence_number,c.id)<($3,$4::uuid))
ORDER BY c.sequence_number DESC,c.id DESC
LIMIT $5`,
		mustUUID(query.UserID),
		mustUUID(query.GoalID),
		afterSequence,
		afterCycleID,
		query.FetchLimit,
	)
	if err != nil {
		return nil, err
	}
	found = make([]workspace.CycleSummary, 0)
	for rows.Next() {
		item, scanErr := scanCycleSummary(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		found = append(found, item)
	}
	rowsErr := rows.Err()
	rows.Close()
	if rowsErr != nil {
		return nil, rowsErr
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

	var goalExists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM goals WHERE id=$1 AND user_id=$2
)`, mustUUID(goalID), mustUUID(userID)).Scan(&goalExists); err != nil {
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

func scanCycleSummary(scanner rowScanner) (workspace.CycleSummary, error) {
	var item workspace.CycleSummary
	var versionID pgtype.UUID
	var versionNumber pgtype.Int4
	var versionBody pgtype.Text
	var versionCreatedAt pgtype.Timestamptz
	if err := scanner.Scan(
		&item.ID,
		&item.SequenceNumber,
		&item.Status,
		&item.StartedAt,
		&item.CompletedAt,
		&item.CanceledAt,
		&versionID,
		&versionNumber,
		&versionBody,
		&versionCreatedAt,
		&item.PlanPreview,
	); err != nil {
		return workspace.CycleSummary{}, err
	}
	if !versionID.Valid || !versionNumber.Valid || !versionBody.Valid || !versionCreatedAt.Valid {
		return workspace.CycleSummary{}, fmt.Errorf("%w: Cycle Goal Version is missing", workspace.ErrCyclePersistenceInvariant)
	}
	item.GoalVersion = workspace.GoalVersionView{
		ID:            uuidString(versionID),
		VersionNumber: versionNumber.Int32,
		Body:          versionBody.String,
		CreatedAt:     versionCreatedAt.Time,
	}
	return item, nil
}

func queryCycleView(
	ctx context.Context,
	query rowQuerier,
	userID, goalID, cycleID string,
) (workspace.CycleView, error) {
	var view workspace.CycleView
	var versionID pgtype.UUID
	var versionNumber pgtype.Int4
	var versionBody pgtype.Text
	var versionCreatedAt pgtype.Timestamptz
	err := query.QueryRow(ctx, `SELECT
c.id,c.goal_id,c.sequence_number,c.status,c.started_at,c.completed_at,c.canceled_at,c.cancellation_reason,
c.plan,c.do_text,c.check_text,c.action,c.content_revision,c.plan_revision,c.do_revision,c.check_revision,c.action_revision,
gv.id,gv.version_number,gv.body,gv.created_at
FROM pdca_cycles c
JOIN goals g ON g.id=c.goal_id AND g.user_id=c.user_id
LEFT JOIN goal_versions gv ON gv.id=c.goal_version_id AND gv.goal_id=c.goal_id
WHERE c.id=$1 AND c.goal_id=$2 AND c.user_id=$3`,
		mustUUID(cycleID), mustUUID(goalID), mustUUID(userID),
	).Scan(
		&view.ID,
		&view.GoalID,
		&view.SequenceNumber,
		&view.Status,
		&view.StartedAt,
		&view.CompletedAt,
		&view.CanceledAt,
		&view.CancellationReason,
		&view.Plan,
		&view.Do,
		&view.Check,
		&view.Action,
		&view.ContentRevision,
		&view.FrameRevisions.Plan,
		&view.FrameRevisions.Do,
		&view.FrameRevisions.Check,
		&view.FrameRevisions.Action,
		&versionID,
		&versionNumber,
		&versionBody,
		&versionCreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return workspace.CycleView{}, workspace.ErrCycleNotFound
	}
	if err != nil {
		return workspace.CycleView{}, err
	}
	if !versionID.Valid || !versionNumber.Valid || !versionBody.Valid || !versionCreatedAt.Valid {
		return workspace.CycleView{}, fmt.Errorf("%w: Cycle Goal Version is missing", workspace.ErrCyclePersistenceInvariant)
	}
	view.GoalVersion = workspace.GoalVersionView{
		ID:            uuidString(versionID),
		VersionNumber: versionNumber.Int32,
		Body:          versionBody.String,
		CreatedAt:     versionCreatedAt.Time,
	}
	return view, nil
}
