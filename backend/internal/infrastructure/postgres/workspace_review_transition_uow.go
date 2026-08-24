package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

var _ workspace.ReviewTransitionUnitOfWork = (*WorkspaceStore)(nil)
var _ workspace.ReviewTransitionTx = (*workspaceReviewTransitionTx)(nil)

type workspaceReviewTransitionTx struct {
	*workspaceCycleTx
	*workspaceGoalDraftTx
}

func (store *WorkspaceStore) WithinReviewTransitionTransaction(
	ctx context.Context,
	operation func(workspace.ReviewTransitionTx) error,
) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	reviewTx := &workspaceReviewTransitionTx{
		workspaceCycleTx:     &workspaceCycleTx{tx: tx},
		workspaceGoalDraftTx: &workspaceGoalDraftTx{tx: tx},
	}
	if err = operation(reviewTx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (transaction *workspaceReviewTransitionTx) FindContinueReviewReceipt(
	ctx context.Context,
	userID, operationID string,
) (*workspace.ContinueReviewReceipt, error) {
	var receipt workspace.ContinueReviewReceipt
	err := transaction.workspaceCycleTx.tx.QueryRow(ctx, `SELECT c.goal_id,c.id,c.start_request_hash,
EXISTS(SELECT 1 FROM goal_versions gv
       WHERE gv.user_id=c.user_id AND gv.goal_id=c.goal_id
         AND gv.created_by_operation_id=c.start_operation_id)
FROM pdca_cycles c
WHERE c.user_id=$1 AND c.start_operation_id=$2`,
		mustUUID(userID), mustUUID(operationID),
	).Scan(&receipt.GoalID, &receipt.CycleID, &receipt.RequestHash, &receipt.VersionCreated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &receipt, nil
}

func (transaction *workspaceReviewTransitionTx) FindGoalTerminationReceipt(
	ctx context.Context,
	userID, operationID string,
) (*workspace.GoalTerminationReceipt, error) {
	var receipt workspace.GoalTerminationReceipt
	err := transaction.workspaceCycleTx.tx.QueryRow(ctx, `SELECT id,terminal_request_hash
FROM goals
WHERE user_id=$1 AND terminal_operation_id=$2`,
		mustUUID(userID), mustUUID(operationID),
	).Scan(&receipt.GoalID, &receipt.RequestHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &receipt, nil
}

func (transaction *workspaceReviewTransitionTx) LockUser(ctx context.Context, userID string) error {
	return transaction.workspaceCycleTx.LockUser(ctx, userID)
}

func (transaction *workspaceReviewTransitionTx) LockGoal(
	ctx context.Context,
	userID, goalID string,
) (goal.Goal, error) {
	return transaction.workspaceCycleTx.LockGoal(ctx, userID, goalID)
}

func (transaction *workspaceReviewTransitionTx) LockCycle(
	ctx context.Context,
	userID, goalID, cycleID string,
) (cycle.PDCACycle, error) {
	return transaction.workspaceCycleTx.LockCycle(ctx, userID, goalID, cycleID)
}

func (transaction *workspaceReviewTransitionTx) LockReviewDraft(
	ctx context.Context,
	userID, goalID string,
) (goal.Draft, error) {
	return transaction.workspaceGoalDraftTx.LockReviewDraftByGoal(ctx, userID, goalID)
}

func (transaction *workspaceReviewTransitionTx) LoadCurrentGoalVersion(
	ctx context.Context,
	userID, goalID string,
	versionNumber int32,
) (goal.Version, error) {
	return transaction.workspaceCycleTx.LoadCurrentGoalVersion(ctx, userID, goalID, versionNumber)
}

func (transaction *workspaceReviewTransitionTx) HasRunningGoalGeneration(
	ctx context.Context,
	userID, goalID string,
) (bool, error) {
	var running bool
	err := transaction.workspaceCycleTx.tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM ai_generations
WHERE user_id=$1 AND goal_id=$2 AND status='running'
)`, mustUUID(userID), mustUUID(goalID)).Scan(&running)
	return running, err
}

func (transaction *workspaceReviewTransitionTx) InsertGoalVersion(
	ctx context.Context,
	version goal.Version,
) (int64, error) {
	return transaction.workspaceGoalDraftTx.InsertInitialVersion(ctx, version)
}

func (transaction *workspaceReviewTransitionTx) TryInsertReviewCycleClaim(
	ctx context.Context,
	current cycle.PDCACycle,
) (int64, error) {
	command, err := transaction.workspaceCycleTx.tx.Exec(ctx, `INSERT INTO pdca_cycles
(id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,start_operation_id,start_request_hash,created_at,updated_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (user_id,start_operation_id) DO NOTHING`,
		mustUUID(current.ID),
		mustUUID(current.UserID),
		mustUUID(current.GoalID),
		mustUUID(current.GoalVersionID),
		current.SequenceNumber,
		current.Status,
		current.StartedAt,
		mustUUID(current.StartOperationID),
		current.StartRequestHash,
		current.CreatedAt,
		current.UpdatedAt,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceReviewTransitionTx) ContinueGoalCAS(
	ctx context.Context,
	continued goal.Goal,
	expectedRevision int64,
) (int64, error) {
	command, err := transaction.workspaceCycleTx.tx.Exec(ctx, `UPDATE goals SET
status=$3,current_version_number=$4,next_cycle_sequence_number=$5,
revision=$6,updated_at=$7
WHERE id=$1 AND user_id=$2 AND status='goal_review' AND revision=$8`,
		mustUUID(continued.ID),
		mustUUID(continued.UserID),
		continued.Status,
		continued.CurrentVersionNumber,
		continued.NextCycleSequenceNumber,
		continued.Revision,
		continued.UpdatedAt,
		expectedRevision,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceReviewTransitionTx) CancelCycleCAS(
	ctx context.Context,
	canceled cycle.PDCACycle,
	expectedContentRevision int64,
) (int64, error) {
	command, err := transaction.workspaceCycleTx.tx.Exec(ctx, `UPDATE pdca_cycles SET
status=$4,canceled_at=$5,cancellation_reason=$6,updated_at=$7
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND status='active' AND content_revision=$8`,
		mustUUID(canceled.ID),
		mustUUID(canceled.UserID),
		mustUUID(canceled.GoalID),
		canceled.Status,
		canceled.CanceledAt,
		canceled.CancellationReason,
		canceled.UpdatedAt,
		expectedContentRevision,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceReviewTransitionTx) DeleteReviewDraftCAS(
	ctx context.Context,
	userID, draftID string,
	expectedRevision int64,
) (int64, error) {
	command, err := transaction.workspaceCycleTx.tx.Exec(ctx, `DELETE FROM goal_drafts
WHERE id=$1 AND user_id=$2 AND draft_type='review' AND revision=$3`,
		mustUUID(draftID), mustUUID(userID), expectedRevision)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceReviewTransitionTx) TerminateGoalCAS(
	ctx context.Context,
	terminated goal.Goal,
	expectedRevision int64,
) (int64, error) {
	command, err := transaction.workspaceCycleTx.tx.Exec(ctx, `UPDATE goals SET
status=$3,revision=$4,terminal_at=$5,terminal_operation_id=$6,
terminal_request_hash=$7,updated_at=$8
WHERE id=$1 AND user_id=$2 AND status IN ('active_cycle','goal_review') AND revision=$9`,
		mustUUID(terminated.ID),
		mustUUID(terminated.UserID),
		terminated.Status,
		terminated.Revision,
		terminated.TerminalAt,
		terminated.TerminalOperationID,
		terminated.TerminalRequestHash,
		terminated.UpdatedAt,
		expectedRevision,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceReviewTransitionTx) LoadGoalView(
	ctx context.Context,
	userID, goalID string,
) (workspace.GoalView, error) {
	return transaction.workspaceCycleTx.LoadGoalView(ctx, userID, goalID)
}

func (transaction *workspaceReviewTransitionTx) LoadCycleView(
	ctx context.Context,
	userID, goalID, cycleID string,
) (workspace.CycleView, error) {
	return transaction.workspaceCycleTx.LoadCycleView(ctx, userID, goalID, cycleID)
}
