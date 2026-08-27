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
	row, err := transaction.queries.FindCompleteCycleReceipt(ctx, db.FindCompleteCycleReceiptParams{
		UserID:      mustUUID(userID),
		OperationID: mustUUID(operationID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return completeCycleReceiptFromSQLC(row)
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
	row, err := transaction.queries.LockCycleForTransition(ctx, db.LockCycleForTransitionParams{
		CycleID: mustUUID(cycleID),
		GoalID:  mustUUID(goalID),
		UserID:  mustUUID(userID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return cycle.PDCACycle{}, workspace.ErrCycleNotFound
	}
	if err != nil {
		return cycle.PDCACycle{}, err
	}
	return cycleFromSQLC(row)
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
	return transaction.queries.HasRunningCycleGenerationForTransition(
		ctx,
		db.HasRunningCycleGenerationForTransitionParams{
			UserID:  mustUUID(userID),
			GoalID:  mustUUID(goalID),
			CycleID: mustUUID(cycleID),
		},
	)
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
	switch frame {
	case cycle.FramePlan:
		return transaction.queries.SaveCyclePlanCAS(
			ctx,
			db.SaveCyclePlanCASParams{
				Content:               current.Plan,
				FrameRevision:         current.FrameRevision(frame),
				ContentRevision:       current.Revisions.Content,
				UpdatedAt:             timestamptz(current.UpdatedAt),
				CycleID:               mustUUID(current.ID),
				UserID:                mustUUID(current.UserID),
				GoalID:                mustUUID(current.GoalID),
				ExpectedFrameRevision: expectedFrameRevision,
			},
		)
	case cycle.FrameDo:
		return transaction.queries.SaveCycleDoCAS(
			ctx,
			db.SaveCycleDoCASParams{
				Content:               current.Do,
				FrameRevision:         current.FrameRevision(frame),
				ContentRevision:       current.Revisions.Content,
				UpdatedAt:             timestamptz(current.UpdatedAt),
				CycleID:               mustUUID(current.ID),
				UserID:                mustUUID(current.UserID),
				GoalID:                mustUUID(current.GoalID),
				ExpectedFrameRevision: expectedFrameRevision,
			},
		)
	case cycle.FrameCheck:
		return transaction.queries.SaveCycleCheckCAS(
			ctx,
			db.SaveCycleCheckCASParams{
				Content:               current.Check,
				FrameRevision:         current.FrameRevision(frame),
				ContentRevision:       current.Revisions.Content,
				UpdatedAt:             timestamptz(current.UpdatedAt),
				CycleID:               mustUUID(current.ID),
				UserID:                mustUUID(current.UserID),
				GoalID:                mustUUID(current.GoalID),
				ExpectedFrameRevision: expectedFrameRevision,
			},
		)
	case cycle.FrameAction:
		return transaction.queries.SaveCycleActionCAS(
			ctx,
			db.SaveCycleActionCASParams{
				Content:                   current.Action,
				FrameRevision:             current.FrameRevision(frame),
				ContentRevision:           current.Revisions.Content,
				ActionUserModifiedAfterAi: current.ActionModifiedAfterAI,
				UpdatedAt:                 timestamptz(current.UpdatedAt),
				CycleID:                   mustUUID(current.ID),
				UserID:                    mustUUID(current.UserID),
				GoalID:                    mustUUID(current.GoalID),
				ExpectedFrameRevision:     expectedFrameRevision,
			},
		)
	default:
		return 0, cycle.ErrInvalidFrame
	}
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
	return transaction.queries.CompleteCycleCAS(ctx, db.CompleteCycleCASParams{
		CompletedAt:             timestamptz(*completed.CompletedAt),
		CompletionOperationID:   mustUUID(*completed.CompletionOperationID),
		CompletionRequestHash:   *completed.CompletionRequestHash,
		UpdatedAt:               timestamptz(completed.UpdatedAt),
		CycleID:                 mustUUID(completed.ID),
		UserID:                  mustUUID(completed.UserID),
		GoalID:                  mustUUID(completed.GoalID),
		ExpectedContentRevision: expectedContentRevision,
	})
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
