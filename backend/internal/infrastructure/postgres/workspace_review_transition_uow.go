package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
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
	queries := store.queries.WithTx(tx)
	reviewTx := &workspaceReviewTransitionTx{
		workspaceCycleTx:     &workspaceCycleTx{tx: tx, queries: queries},
		workspaceGoalDraftTx: &workspaceGoalDraftTx{tx: tx, queries: queries},
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
	row, err := transaction.workspaceCycleTx.queries.FindContinueReviewReceipt(
		ctx,
		db.FindContinueReviewReceiptParams{
			UserID:      mustUUID(userID),
			OperationID: mustUUID(operationID),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return continueReviewReceiptFromSQLC(row)
}

func (transaction *workspaceReviewTransitionTx) FindGoalTerminationReceipt(
	ctx context.Context,
	userID, operationID string,
) (*workspace.GoalTerminationReceipt, error) {
	row, err := transaction.workspaceCycleTx.queries.FindGoalTerminationReceipt(
		ctx,
		db.FindGoalTerminationReceiptParams{
			UserID:      mustUUID(userID),
			OperationID: mustUUID(operationID),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return goalTerminationReceiptFromTransitionRow(row)
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
	return transaction.workspaceCycleTx.queries.HasRunningGoalGenerationForReviewTransition(
		ctx,
		db.HasRunningGoalGenerationForReviewTransitionParams{
			UserID: mustUUID(userID),
			GoalID: mustUUID(goalID),
		},
	)
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
	return transaction.workspaceCycleTx.queries.TryInsertCycleClaim(ctx, db.TryInsertCycleClaimParams{
		CycleID:          mustUUID(current.ID),
		UserID:           mustUUID(current.UserID),
		GoalID:           mustUUID(current.GoalID),
		GoalVersionID:    mustUUID(current.GoalVersionID),
		SequenceNumber:   current.SequenceNumber,
		Status:           string(current.Status),
		StartedAt:        timestamptz(current.StartedAt),
		StartOperationID: mustUUID(current.StartOperationID),
		StartRequestHash: current.StartRequestHash,
		CreatedAt:        timestamptz(current.CreatedAt),
		UpdatedAt:        timestamptz(current.UpdatedAt),
	})
}

func (transaction *workspaceReviewTransitionTx) ContinueGoalCAS(
	ctx context.Context,
	continued goal.Goal,
	expectedRevision int64,
) (int64, error) {
	return transaction.workspaceCycleTx.queries.ContinueGoalCAS(ctx, db.ContinueGoalCASParams{
		Status:                  string(continued.Status),
		CurrentVersionNumber:    continued.CurrentVersionNumber,
		NextCycleSequenceNumber: continued.NextCycleSequenceNumber,
		Revision:                continued.Revision,
		UpdatedAt:               timestamptz(continued.UpdatedAt),
		GoalID:                  mustUUID(continued.ID),
		UserID:                  mustUUID(continued.UserID),
		ExpectedRevision:        expectedRevision,
	})
}

func (transaction *workspaceReviewTransitionTx) CancelCycleCAS(
	ctx context.Context,
	canceled cycle.PDCACycle,
	expectedContentRevision int64,
) (int64, error) {
	if canceled.Status != cycle.StatusCanceled || canceled.CanceledAt == nil || canceled.CancellationReason == nil {
		return 0, fmt.Errorf(
			"%w: canceled Cycle state is incomplete",
			workspace.ErrReviewTransitionPersistenceInvariant,
		)
	}
	return transaction.workspaceCycleTx.queries.CancelCycleCAS(ctx, db.CancelCycleCASParams{
		Status:                  string(canceled.Status),
		CanceledAt:              timestamptz(*canceled.CanceledAt),
		CancellationReason:      string(*canceled.CancellationReason),
		UpdatedAt:               timestamptz(canceled.UpdatedAt),
		CycleID:                 mustUUID(canceled.ID),
		UserID:                  mustUUID(canceled.UserID),
		GoalID:                  mustUUID(canceled.GoalID),
		ExpectedContentRevision: expectedContentRevision,
	})
}

func (transaction *workspaceReviewTransitionTx) DeleteReviewDraftCAS(
	ctx context.Context,
	userID, draftID string,
	expectedRevision int64,
) (int64, error) {
	return transaction.workspaceCycleTx.queries.DeleteReviewDraftCAS(ctx, db.DeleteReviewDraftCASParams{
		DraftID:          mustUUID(draftID),
		UserID:           mustUUID(userID),
		ExpectedRevision: expectedRevision,
	})
}

func (transaction *workspaceReviewTransitionTx) TerminateGoalCAS(
	ctx context.Context,
	terminated goal.Goal,
	expectedRevision int64,
) (int64, error) {
	if terminated.TerminalAt == nil || terminated.TerminalOperationID == nil || terminated.TerminalRequestHash == nil {
		return 0, fmt.Errorf("%w: terminated Goal state is incomplete", workspace.ErrReviewTransitionPersistenceInvariant)
	}
	return transaction.workspaceCycleTx.queries.TerminateGoalCAS(ctx, db.TerminateGoalCASParams{
		Status:              string(terminated.Status),
		Revision:            terminated.Revision,
		TerminalAt:          timestamptz(*terminated.TerminalAt),
		TerminalOperationID: mustUUID(*terminated.TerminalOperationID),
		TerminalRequestHash: *terminated.TerminalRequestHash,
		UpdatedAt:           timestamptz(terminated.UpdatedAt),
		GoalID:              mustUUID(terminated.ID),
		UserID:              mustUUID(terminated.UserID),
		ExpectedRevision:    expectedRevision,
	})
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

func goalTerminationReceiptFromTransitionRow(
	row *db.FindGoalTerminationReceiptRow,
) (*workspace.GoalTerminationReceipt, error) {
	if row == nil || !row.GoalID.Valid || row.RequestHash == nil || *row.RequestHash == "" {
		return nil, fmt.Errorf("%w: Goal termination receipt is incomplete", workspace.ErrReviewTransitionPersistenceInvariant)
	}
	goalID := uuidString(row.GoalID)
	if goalID == "" {
		return nil, fmt.Errorf("%w: Goal termination receipt identity is invalid", workspace.ErrReviewTransitionPersistenceInvariant)
	}
	return &workspace.GoalTerminationReceipt{GoalID: goalID, RequestHash: *row.RequestHash}, nil
}
