package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

var _ workspace.CycleUnitOfWork = (*WorkspaceStore)(nil)
var _ workspace.CycleTx = (*workspaceCycleTx)(nil)

type workspaceCycleTx struct {
	tx pgx.Tx
}

func (store *WorkspaceStore) WithinCycleTransaction(
	ctx context.Context,
	operation func(workspace.CycleTx) error,
) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	if err = operation(&workspaceCycleTx{tx: tx}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (transaction *workspaceCycleTx) FindCompleteCycleReceipt(
	ctx context.Context,
	userID, operationID string,
) (*workspace.CompleteCycleReceipt, error) {
	var receipt workspace.CompleteCycleReceipt
	err := transaction.tx.QueryRow(ctx, `SELECT goal_id,id,completion_request_hash
FROM pdca_cycles
WHERE user_id=$1 AND completion_operation_id=$2`,
		mustUUID(userID), mustUUID(operationID),
	).Scan(&receipt.GoalID, &receipt.CycleID, &receipt.RequestHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &receipt, nil
}

func (transaction *workspaceCycleTx) LockUser(ctx context.Context, userID string) error {
	if err := lockUser(ctx, transaction.tx, user.ID(userID)); errors.Is(err, pgx.ErrNoRows) {
		return workspace.ErrNotFound
	} else {
		return err
	}
}

func (transaction *workspaceCycleTx) LockGoal(
	ctx context.Context,
	userID, goalID string,
) (goal.Goal, error) {
	var current goal.Goal
	err := transaction.tx.QueryRow(ctx, `SELECT
id,user_id,status,current_version_number,next_cycle_sequence_number,revision,terminal_at,
terminal_operation_id,terminal_request_hash,created_at,updated_at
FROM goals
WHERE id=$1 AND user_id=$2
FOR UPDATE`, mustUUID(goalID), mustUUID(userID)).Scan(
		&current.ID,
		&current.UserID,
		&current.Status,
		&current.CurrentVersionNumber,
		&current.NextCycleSequenceNumber,
		&current.Revision,
		&current.TerminalAt,
		&current.TerminalOperationID,
		&current.TerminalRequestHash,
		&current.CreatedAt,
		&current.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return goal.Goal{}, workspace.ErrGoalNotFound
	}
	return current, err
}

func (transaction *workspaceCycleTx) LockCycle(
	ctx context.Context,
	userID, goalID, cycleID string,
) (cycle.PDCACycle, error) {
	var current cycle.PDCACycle
	err := transaction.tx.QueryRow(ctx, `SELECT
id,user_id,goal_id,goal_version_id,sequence_number,status,started_at,completed_at,canceled_at,
cancellation_reason,plan,do_text,check_text,action,content_revision,plan_revision,do_revision,check_revision,action_revision,
action_last_ai_applied_content_revision,action_user_modified_after_ai,start_operation_id,start_request_hash,
completion_operation_id,completion_request_hash,created_at,updated_at
FROM pdca_cycles
WHERE id=$1 AND goal_id=$2 AND user_id=$3
FOR UPDATE`, mustUUID(cycleID), mustUUID(goalID), mustUUID(userID)).Scan(
		&current.ID,
		&current.UserID,
		&current.GoalID,
		&current.GoalVersionID,
		&current.SequenceNumber,
		&current.Status,
		&current.StartedAt,
		&current.CompletedAt,
		&current.CanceledAt,
		&current.CancellationReason,
		&current.Plan,
		&current.Do,
		&current.Check,
		&current.Action,
		&current.Revisions.Content,
		&current.Revisions.Plan,
		&current.Revisions.Do,
		&current.Revisions.Check,
		&current.Revisions.Action,
		&current.ActionLastAIRevision,
		&current.ActionModifiedAfterAI,
		&current.StartOperationID,
		&current.StartRequestHash,
		&current.CompletionOperationID,
		&current.CompletionRequestHash,
		&current.CreatedAt,
		&current.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return cycle.PDCACycle{}, workspace.ErrCycleNotFound
	}
	return current, err
}

func (transaction *workspaceCycleTx) LoadCurrentGoalVersion(
	ctx context.Context,
	userID, goalID string,
	versionNumber int32,
) (goal.Version, error) {
	var version goal.Version
	var versionID pgtype.UUID
	var versionUserID pgtype.UUID
	var versionGoalID pgtype.UUID
	var persistedNumber pgtype.Int4
	var body pgtype.Text
	var createdByOperationID pgtype.UUID
	var createdAt pgtype.Timestamptz
	err := transaction.tx.QueryRow(ctx, `SELECT
gv.id,gv.user_id,gv.goal_id,gv.version_number,gv.body,gv.created_by_operation_id,gv.created_at
FROM goals g
LEFT JOIN goal_versions gv
  ON gv.user_id=g.user_id AND gv.goal_id=g.id AND gv.version_number=$3
WHERE g.id=$1 AND g.user_id=$2`,
		mustUUID(goalID), mustUUID(userID), versionNumber,
	).Scan(
		&versionID,
		&versionUserID,
		&versionGoalID,
		&persistedNumber,
		&body,
		&createdByOperationID,
		&createdAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return goal.Version{}, workspace.ErrNotFound
	}
	if err != nil {
		return goal.Version{}, err
	}
	if !versionID.Valid || !versionUserID.Valid || !versionGoalID.Valid || !persistedNumber.Valid ||
		!body.Valid || !createdByOperationID.Valid || !createdAt.Valid {
		return goal.Version{}, workspace.ErrGoalVersionConflict
	}
	version.ID = uuidString(versionID)
	version.UserID = uuidString(versionUserID)
	version.GoalID = uuidString(versionGoalID)
	version.VersionNumber = persistedNumber.Int32
	version.Body = body.String
	version.CreatedByOperationID = uuidString(createdByOperationID)
	version.CreatedAt = createdAt.Time
	return version, nil
}

func (transaction *workspaceCycleTx) HasRunningCycleGeneration(
	ctx context.Context,
	userID, goalID, cycleID string,
) (bool, error) {
	var running bool
	err := transaction.tx.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM ai_generations
WHERE user_id=$1 AND goal_id=$2 AND cycle_id=$3 AND status='running'
)`, mustUUID(userID), mustUUID(goalID), mustUUID(cycleID)).Scan(&running)
	return running, err
}

func (transaction *workspaceCycleTx) SaveCycleFrameCAS(
	ctx context.Context,
	current cycle.PDCACycle,
	frame cycle.Frame,
	expectedFrameRevision int64,
) (int64, error) {
	if current.Revisions.Content <= 0 || current.FrameRevision(frame) != expectedFrameRevision+1 {
		return 0, fmt.Errorf("%w: saved Cycle revision is inconsistent", workspace.ErrCyclePersistenceInvariant)
	}
	var (
		command pgconnCommandTag
		err     error
	)
	switch frame {
	case cycle.FramePlan:
		command, err = execCycleFrameCAS(
			ctx,
			transaction.tx,
			`UPDATE pdca_cycles SET
plan=$4,plan_revision=$5,content_revision=$6,updated_at=$7
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND status='active'
  AND plan_revision=$8`,
			current,
			frame,
			current.Plan,
			expectedFrameRevision,
		)
	case cycle.FrameDo:
		command, err = execCycleFrameCAS(
			ctx,
			transaction.tx,
			`UPDATE pdca_cycles SET
do_text=$4,do_revision=$5,content_revision=$6,updated_at=$7
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND status='active'
  AND do_revision=$8`,
			current,
			frame,
			current.Do,
			expectedFrameRevision,
		)
	case cycle.FrameCheck:
		command, err = execCycleFrameCAS(
			ctx,
			transaction.tx,
			`UPDATE pdca_cycles SET
check_text=$4,check_revision=$5,content_revision=$6,updated_at=$7
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND status='active'
  AND check_revision=$8`,
			current,
			frame,
			current.Check,
			expectedFrameRevision,
		)
	case cycle.FrameAction:
		command, err = transaction.tx.Exec(ctx, `UPDATE pdca_cycles SET
action=$4,action_revision=$5,content_revision=$6,
action_user_modified_after_ai=$7,updated_at=$8
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND status='active'
  AND action_revision=$9`,
			mustUUID(current.ID),
			mustUUID(current.UserID),
			mustUUID(current.GoalID),
			current.Action,
			current.FrameRevision(frame),
			current.Revisions.Content,
			current.ActionModifiedAfterAI,
			current.UpdatedAt,
			expectedFrameRevision,
		)
	default:
		return 0, cycle.ErrInvalidFrame
	}
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

// pgconnCommandTag is the minimal result shape shared by pgx.Tx.Exec and the
// small static frame-update helper below.
type pgconnCommandTag interface {
	RowsAffected() int64
}

func execCycleFrameCAS(
	ctx context.Context,
	tx pgx.Tx,
	query string,
	current cycle.PDCACycle,
	frame cycle.Frame,
	content string,
	expectedFrameRevision int64,
) (pgconnCommandTag, error) {
	return tx.Exec(ctx, query,
		mustUUID(current.ID),
		mustUUID(current.UserID),
		mustUUID(current.GoalID),
		content,
		current.FrameRevision(frame),
		current.Revisions.Content,
		current.UpdatedAt,
		expectedFrameRevision,
	)
}

func (transaction *workspaceCycleTx) CompleteCycleCAS(
	ctx context.Context,
	completed cycle.PDCACycle,
	expectedContentRevision int64,
) (int64, error) {
	if completed.Status != cycle.StatusCompleted || completed.CompletedAt == nil || completed.CompletionOperationID == nil ||
		completed.CompletionRequestHash == nil {
		return 0, fmt.Errorf("%w: completed Cycle state is incomplete", workspace.ErrCyclePersistenceInvariant)
	}
	command, err := transaction.tx.Exec(ctx, `UPDATE pdca_cycles SET
status='completed',completed_at=$4,completion_operation_id=$5,completion_request_hash=$6,updated_at=$7
WHERE id=$1 AND user_id=$2 AND goal_id=$3 AND status='active'
  AND content_revision=$8 AND completion_operation_id IS NULL AND completion_request_hash IS NULL`,
		mustUUID(completed.ID),
		mustUUID(completed.UserID),
		mustUUID(completed.GoalID),
		*completed.CompletedAt,
		mustUUID(*completed.CompletionOperationID),
		*completed.CompletionRequestHash,
		completed.UpdatedAt,
		expectedContentRevision,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceCycleTx) InsertReviewDraft(
	ctx context.Context,
	draft goal.Draft,
) (int64, error) {
	if draft.Type != goal.DraftReview || draft.GoalID == nil || draft.BaseGoalVersionID == nil || draft.ReviewCycleID == nil {
		return 0, fmt.Errorf("%w: Cycle Review Draft state is incomplete", workspace.ErrCyclePersistenceInvariant)
	}
	command, err := transaction.tx.Exec(ctx, `INSERT INTO goal_drafts
(id,user_id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,created_at,updated_at)
VALUES($1,$2,'review',$3,$4,$5,$6,$7,$8,$9)`,
		mustUUID(draft.ID),
		mustUUID(draft.UserID),
		mustUUID(*draft.GoalID),
		mustUUID(*draft.BaseGoalVersionID),
		mustUUID(*draft.ReviewCycleID),
		draft.Body,
		draft.Revision,
		draft.CreatedAt,
		draft.UpdatedAt,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceCycleTx) EnterGoalReviewCAS(
	ctx context.Context,
	reviewing goal.Goal,
	expectedRevision int64,
) (int64, error) {
	if reviewing.Status != goal.StatusGoalReview || reviewing.Revision != expectedRevision+1 {
		return 0, fmt.Errorf("%w: reviewing Goal state is inconsistent", workspace.ErrCyclePersistenceInvariant)
	}
	command, err := transaction.tx.Exec(ctx, `UPDATE goals SET
status='goal_review',revision=$3,updated_at=$4
WHERE id=$1 AND user_id=$2 AND status='active_cycle' AND revision=$5
  AND current_version_number=$6 AND next_cycle_sequence_number=$7`,
		mustUUID(reviewing.ID),
		mustUUID(reviewing.UserID),
		reviewing.Revision,
		reviewing.UpdatedAt,
		expectedRevision,
		reviewing.CurrentVersionNumber,
		reviewing.NextCycleSequenceNumber,
	)
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (transaction *workspaceCycleTx) LoadGoalView(
	ctx context.Context,
	userID, goalID string,
) (workspace.GoalView, error) {
	return getGoalView(ctx, transaction.tx, userID, goalID)
}

func (transaction *workspaceCycleTx) LoadCycleView(
	ctx context.Context,
	userID, goalID, cycleID string,
) (workspace.CycleView, error) {
	return queryCycleView(ctx, transaction.tx, userID, goalID, cycleID)
}

func (transaction *workspaceCycleTx) FindReviewDraftByCycle(
	ctx context.Context,
	userID, goalID, cycleID string,
) (*workspace.DraftView, error) {
	draft, err := scanDraft(transaction.tx.QueryRow(ctx, `SELECT
id,draft_type,goal_id,base_goal_version_id,review_cycle_id,body,revision,updated_at
FROM goal_drafts
WHERE user_id=$1 AND goal_id=$2 AND review_cycle_id=$3 AND draft_type='review'`,
		mustUUID(userID), mustUUID(goalID), mustUUID(cycleID),
	))
	if errors.Is(err, workspace.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &draft, nil
}
