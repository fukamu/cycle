package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

var _ workspace.CycleUnitOfWork = (*WorkspaceStore)(nil)
var _ workspace.CycleTx = (*workspaceCycleTx)(nil)

type workspaceCycleTx struct {
	tx      pgx.Tx
	queries *db.Queries
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
	if err = operation(&workspaceCycleTx{tx: tx, queries: store.queries.WithTx(tx)}); err != nil {
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
	row, err := transaction.queries.LockGoalForTransition(ctx, db.LockGoalForTransitionParams{
		GoalID: mustUUID(goalID),
		UserID: mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return goal.Goal{}, workspace.ErrGoalNotFound
	}
	if err != nil {
		return goal.Goal{}, err
	}
	return goalFromTransitionRow(row)
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
	row, err := transaction.queries.LoadCurrentGoalVersionForTransition(
		ctx,
		db.LoadCurrentGoalVersionForTransitionParams{
			VersionNumber: versionNumber,
			GoalID:        mustUUID(goalID),
			UserID:        mustUUID(userID),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return goal.Version{}, workspace.ErrNotFound
	}
	if err != nil {
		return goal.Version{}, err
	}
	return goalVersionFromTransitionRow(row)
}

func goalVersionFromTransitionRow(row *db.LoadCurrentGoalVersionForTransitionRow) (goal.Version, error) {
	if row == nil || !row.ID.Valid || !row.UserID.Valid || !row.GoalID.Valid || row.VersionNumber == nil ||
		row.Body == nil || !row.CreatedByOperationID.Valid || !isFiniteGoalTimestamptz(row.CreatedAt) {
		return goal.Version{}, workspace.ErrGoalVersionConflict
	}
	versionID := uuidString(row.ID)
	versionUserID := uuidString(row.UserID)
	versionGoalID := uuidString(row.GoalID)
	createdByOperationID := uuidString(row.CreatedByOperationID)
	if versionID == "" || versionUserID == "" || versionGoalID == "" || createdByOperationID == "" {
		return goal.Version{}, workspace.ErrGoalVersionConflict
	}
	return goal.Version{
		ID:                   versionID,
		UserID:               versionUserID,
		GoalID:               versionGoalID,
		VersionNumber:        *row.VersionNumber,
		Body:                 *row.Body,
		CreatedByOperationID: createdByOperationID,
		CreatedAt:            row.CreatedAt.Time.UTC(),
	}, nil
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
	return transaction.queries.InsertReviewDraftForTransition(ctx, db.InsertReviewDraftForTransitionParams{
		DraftID:           mustUUID(draft.ID),
		UserID:            mustUUID(draft.UserID),
		GoalID:            mustUUID(*draft.GoalID),
		BaseGoalVersionID: mustUUID(*draft.BaseGoalVersionID),
		ReviewCycleID:     mustUUID(*draft.ReviewCycleID),
		Body:              draft.Body,
		Revision:          draft.Revision,
		CreatedAt:         timestamptz(draft.CreatedAt),
		UpdatedAt:         timestamptz(draft.UpdatedAt),
	})
}

func (transaction *workspaceCycleTx) EnterGoalReviewCAS(
	ctx context.Context,
	reviewing goal.Goal,
	expectedRevision int64,
) (int64, error) {
	if reviewing.Status != goal.StatusGoalReview || reviewing.Revision != expectedRevision+1 {
		return 0, fmt.Errorf("%w: reviewing Goal state is inconsistent", workspace.ErrCyclePersistenceInvariant)
	}
	return transaction.queries.EnterGoalReviewCAS(ctx, db.EnterGoalReviewCASParams{
		Revision:                reviewing.Revision,
		UpdatedAt:               timestamptz(reviewing.UpdatedAt),
		GoalID:                  mustUUID(reviewing.ID),
		UserID:                  mustUUID(reviewing.UserID),
		ExpectedRevision:        expectedRevision,
		CurrentVersionNumber:    reviewing.CurrentVersionNumber,
		NextCycleSequenceNumber: reviewing.NextCycleSequenceNumber,
	})
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
	row, err := transaction.queries.FindReviewDraftByCycle(ctx, db.FindReviewDraftByCycleParams{
		UserID:  mustUUID(userID),
		GoalID:  mustUUID(goalID),
		CycleID: mustUUID(cycleID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	view, err := reviewDraftViewFromTransitionRow(row)
	if err != nil {
		return nil, err
	}
	return &view, nil
}

func goalFromTransitionRow(row *db.Goal) (goal.Goal, error) {
	if row == nil || !row.ID.Valid || !row.UserID.Valid ||
		!isFiniteGoalTimestamptz(row.CreatedAt) || !isFiniteGoalTimestamptz(row.UpdatedAt) {
		return goal.Goal{}, goalTransitionPersistenceError("required Goal identity or timestamp is missing")
	}
	id := uuidString(row.ID)
	userID := uuidString(row.UserID)
	if id == "" || userID == "" {
		return goal.Goal{}, goalTransitionPersistenceError("required Goal identity is invalid")
	}

	status := goal.Status(row.Status)
	var terminalAt *time.Time
	var terminalOperationID *string
	switch status {
	case goal.StatusActiveCycle, goal.StatusGoalReview:
		if row.TerminalAt.Valid || row.TerminalOperationID.Valid || row.TerminalRequestHash != nil {
			return goal.Goal{}, goalTransitionPersistenceError("progressing Goal has terminal metadata")
		}
	case goal.StatusAchieved, goal.StatusEnded:
		if !isFiniteGoalTimestamptz(row.TerminalAt) || !row.TerminalOperationID.Valid ||
			row.TerminalRequestHash == nil || *row.TerminalRequestHash == "" {
			return goal.Goal{}, goalTransitionPersistenceError("terminal Goal metadata is incomplete")
		}
		operationID := uuidString(row.TerminalOperationID)
		if operationID == "" {
			return goal.Goal{}, goalTransitionPersistenceError("terminal Goal operation identity is invalid")
		}
		terminalTime := row.TerminalAt.Time.UTC()
		terminalAt = &terminalTime
		terminalOperationID = &operationID
	default:
		return goal.Goal{}, goalTransitionPersistenceError("Goal status is invalid")
	}

	return goal.Goal{
		ID:                      id,
		UserID:                  userID,
		Status:                  status,
		CurrentVersionNumber:    row.CurrentVersionNumber,
		NextCycleSequenceNumber: row.NextCycleSequenceNumber,
		Revision:                row.Revision,
		TerminalAt:              terminalAt,
		TerminalOperationID:     terminalOperationID,
		TerminalRequestHash:     row.TerminalRequestHash,
		CreatedAt:               row.CreatedAt.Time.UTC(),
		UpdatedAt:               row.UpdatedAt.Time.UTC(),
	}, nil
}

func reviewDraftViewFromTransitionRow(row *db.FindReviewDraftByCycleRow) (workspace.DraftView, error) {
	if row == nil || !row.ID.Valid || !row.GoalID.Valid || !row.BaseGoalVersionID.Valid ||
		!row.ReviewCycleID.Valid || !isFiniteGoalTimestamptz(row.UpdatedAt) {
		return workspace.DraftView{}, goalTransitionPersistenceError("Review Draft identity, references, or timestamp is missing")
	}
	id := uuidString(row.ID)
	goalID := uuidString(row.GoalID)
	baseGoalVersionID := uuidString(row.BaseGoalVersionID)
	reviewCycleID := uuidString(row.ReviewCycleID)
	if row.DraftType != string(goal.DraftReview) || id == "" || goalID == "" || baseGoalVersionID == "" || reviewCycleID == "" {
		return workspace.DraftView{}, goalTransitionPersistenceError("Review Draft tuple is invalid")
	}
	return workspace.DraftView{
		ID:                id,
		DraftType:         row.DraftType,
		GoalID:            &goalID,
		BaseGoalVersionID: &baseGoalVersionID,
		ReviewCycleID:     &reviewCycleID,
		Body:              row.Body,
		Revision:          row.Revision,
		UpdatedAt:         row.UpdatedAt.Time.UTC(),
	}, nil
}

func goalTransitionPersistenceError(detail string) error {
	return fmt.Errorf("%w: %s", workspace.ErrGoalPersistenceInvariant, detail)
}
