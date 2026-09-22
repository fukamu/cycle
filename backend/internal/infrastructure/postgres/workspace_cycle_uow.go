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
	tx                       pgx.Tx
	queries                  *db.Queries
	content                  contentBoundary
	lockedCycleStorageFormat map[string]string
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
	queries := store.queries.WithTx(tx)
	content, err := prepareContentBoundary(ctx, queries, store.content)
	if err != nil {
		return err
	}
	if err = operation(&workspaceCycleTx{
		tx: tx, queries: queries, content: content,
		lockedCycleStorageFormat: make(map[string]string),
	}); err != nil {
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

func (transaction *workspaceCycleTx) FindReplanCycleReceipt(
	ctx context.Context,
	userID, operationID string,
) (*workspace.ReplanCycleReceipt, error) {
	row, err := transaction.queries.FindReplanCycleReceipt(ctx, db.FindReplanCycleReceiptParams{
		UserID:      mustUUID(userID),
		OperationID: mustUUID(operationID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return replanCycleReceiptFromSQLC(row)
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
	current, err := cycleFromTransitionRow(row)
	if err != nil {
		return cycle.PDCACycle{}, err
	}
	if err = transaction.content.decodeCycle(ctx, &current); err != nil {
		return cycle.PDCACycle{}, err
	}
	transaction.lockedCycleStorageFormat[current.ID] = row.ContentStorageFormat
	schedule, err := transaction.queries.GetCycleReviewSchedule(ctx, mustUUID(cycleID))
	if errors.Is(err, pgx.ErrNoRows) {
		return current, nil
	}
	if err != nil {
		return cycle.PDCACycle{}, err
	}
	current.ReviewDate, current.ReviewScheduleRevision, err = cycleReviewScheduleFromSQLC(
		schedule.ReviewDate,
		schedule.ReviewScheduleRevision,
	)
	if err != nil {
		return cycle.PDCACycle{}, err
	}
	return current, nil
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
	if err = transaction.content.decodeGoalVersion(
		ctx, userID, uuidString(row.ID), &row.Body, &row.SuccessSignal,
	); err != nil {
		return goal.Version{}, err
	}
	return goalVersionFromTransitionRow(row)
}

func goalVersionFromTransitionRow(row *db.LoadCurrentGoalVersionForTransitionRow) (goal.Version, error) {
	if row == nil || !row.ID.Valid || !row.UserID.Valid || !row.GoalID.Valid || row.VersionNumber == nil ||
		row.Body == "" || !row.CreatedByOperationID.Valid || !isFiniteGoalTimestamptz(row.CreatedAt) {
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
		Body:                 row.Body,
		SuccessSignal:        optionalNonEmptyText(row.SuccessSignal),
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
	currentContent := cycleContent{
		userID: current.UserID, cycleID: current.ID,
		plan: current.Plan, doText: current.Do, checkText: current.Check, action: current.Action,
		planRevision: current.Revisions.Plan, doRevision: current.Revisions.Do,
		checkRevision: current.Revisions.Check, actionRevision: current.Revisions.Action,
	}
	storageFormat, locked := transaction.lockedCycleStorageFormat[current.ID]
	if !locked {
		return 0, fmt.Errorf("%w: Cycle was not locked before save", workspace.ErrCyclePersistenceInvariant)
	}
	migrateLegacy := transaction.content.encryptWrites && storageFormat == contentStorageLegacy
	if transaction.content.encryptWrites && storageFormat != contentStorageLegacy && storageFormat != contentStorageV1 {
		return 0, fmt.Errorf("%w: invalid Cycle content storage format", workspace.ErrCyclePersistenceInvariant)
	}
	if migrateLegacy {
		content, err := transaction.content.encodeCycleFields(ctx, currentContent)
		if err != nil {
			return 0, err
		}
		return transaction.saveLegacyCycleFrameCAS(ctx, current, frame, expectedFrameRevision, content)
	}
	encodedField, err := transaction.content.encodeCycleField(ctx, currentContent, frame)
	if err != nil {
		return 0, err
	}
	switch frame {
	case cycle.FramePlan:
		return transaction.queries.SaveCyclePlanCAS(
			ctx,
			db.SaveCyclePlanCASParams{
				Plan:                  encodedField,
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
				DoText:                encodedField,
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
				CheckText:             encodedField,
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
				Action:                    encodedField,
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

func (transaction *workspaceCycleTx) saveLegacyCycleFrameCAS(
	ctx context.Context,
	current cycle.PDCACycle,
	frame cycle.Frame,
	expectedFrameRevision int64,
	content encryptedCycleFields,
) (int64, error) {
	base := struct {
		plan, doText, checkText, action string
	}{content.plan, content.doText, content.checkText, content.action}
	switch frame {
	case cycle.FramePlan:
		return transaction.queries.MigrateLegacyCyclePlanCAS(ctx, db.MigrateLegacyCyclePlanCASParams{
			Plan: base.plan, DoText: base.doText, CheckText: base.checkText, Action: base.action,
			FrameRevision: current.Revisions.Plan, ContentRevision: current.Revisions.Content,
			UpdatedAt: timestamptz(current.UpdatedAt), CycleID: mustUUID(current.ID), UserID: mustUUID(current.UserID),
			GoalID: mustUUID(current.GoalID), ExpectedFrameRevision: expectedFrameRevision,
		})
	case cycle.FrameDo:
		return transaction.queries.MigrateLegacyCycleDoCAS(ctx, db.MigrateLegacyCycleDoCASParams{
			Plan: base.plan, DoText: base.doText, CheckText: base.checkText, Action: base.action,
			FrameRevision: current.Revisions.Do, ContentRevision: current.Revisions.Content,
			UpdatedAt: timestamptz(current.UpdatedAt), CycleID: mustUUID(current.ID), UserID: mustUUID(current.UserID),
			GoalID: mustUUID(current.GoalID), ExpectedFrameRevision: expectedFrameRevision,
		})
	case cycle.FrameCheck:
		return transaction.queries.MigrateLegacyCycleCheckCAS(ctx, db.MigrateLegacyCycleCheckCASParams{
			Plan: base.plan, DoText: base.doText, CheckText: base.checkText, Action: base.action,
			FrameRevision: current.Revisions.Check, ContentRevision: current.Revisions.Content,
			UpdatedAt: timestamptz(current.UpdatedAt), CycleID: mustUUID(current.ID), UserID: mustUUID(current.UserID),
			GoalID: mustUUID(current.GoalID), ExpectedFrameRevision: expectedFrameRevision,
		})
	case cycle.FrameAction:
		return transaction.queries.MigrateLegacyCycleActionCAS(ctx, db.MigrateLegacyCycleActionCASParams{
			Plan: base.plan, DoText: base.doText, CheckText: base.checkText, Action: base.action,
			FrameRevision: current.Revisions.Action, ContentRevision: current.Revisions.Content,
			ActionUserModifiedAfterAi: current.ActionModifiedAfterAI,
			UpdatedAt:                 timestamptz(current.UpdatedAt), CycleID: mustUUID(current.ID), UserID: mustUUID(current.UserID),
			GoalID: mustUUID(current.GoalID), ExpectedFrameRevision: expectedFrameRevision,
		})
	default:
		return 0, cycle.ErrInvalidFrame
	}
}

func (transaction *workspaceCycleTx) SaveCycleReviewScheduleCAS(
	ctx context.Context,
	current cycle.PDCACycle,
	expectedReviewScheduleRevision int64,
) (int64, error) {
	if current.ReviewScheduleRevision != expectedReviewScheduleRevision+1 {
		return 0, fmt.Errorf("%w: saved Cycle review schedule revision is inconsistent", workspace.ErrCyclePersistenceInvariant)
	}
	reviewDate, err := cycleReviewDateParam(current.ReviewDate)
	if err != nil {
		return 0, fmt.Errorf("%w: saved Cycle review date is invalid", workspace.ErrCyclePersistenceInvariant)
	}
	return transaction.queries.SaveCycleReviewScheduleCAS(
		ctx,
		db.SaveCycleReviewScheduleCASParams{
			CycleID:                        mustUUID(current.ID),
			ReviewDate:                     reviewDate,
			ReviewScheduleRevision:         current.ReviewScheduleRevision,
			ExpectedReviewScheduleRevision: expectedReviewScheduleRevision,
		},
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

func (transaction *workspaceCycleTx) CancelCycleCAS(
	ctx context.Context,
	canceled cycle.PDCACycle,
	expectedContentRevision int64,
) (int64, error) {
	if canceled.Status != cycle.StatusCanceled || canceled.CanceledAt == nil || canceled.CancellationReason == nil {
		return 0, fmt.Errorf("%w: canceled Cycle state is incomplete", workspace.ErrCyclePersistenceInvariant)
	}
	return transaction.queries.CancelCycleCAS(ctx, db.CancelCycleCASParams{
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

func (transaction *workspaceCycleTx) TryInsertCycleClaim(
	ctx context.Context,
	current cycle.PDCACycle,
) (int64, error) {
	content, err := transaction.content.encodeCycleFields(ctx, cycleContent{
		userID: current.UserID, cycleID: current.ID,
		plan: current.Plan, doText: current.Do, checkText: current.Check, action: current.Action,
		planRevision: current.Revisions.Plan, doRevision: current.Revisions.Do,
		checkRevision: current.Revisions.Check, actionRevision: current.Revisions.Action,
	})
	if err != nil {
		return 0, err
	}
	return transaction.queries.TryInsertCycleClaim(ctx, db.TryInsertCycleClaimParams{
		CycleID:          mustUUID(current.ID),
		UserID:           mustUUID(current.UserID),
		GoalID:           mustUUID(current.GoalID),
		GoalVersionID:    mustUUID(current.GoalVersionID),
		SequenceNumber:   current.SequenceNumber,
		Status:           string(current.Status),
		StartedAt:        timestamptz(current.StartedAt),
		Plan:             content.plan,
		DoText:           content.doText,
		CheckText:        content.checkText,
		Action:           content.action,
		StartOperationID: mustUUID(current.StartOperationID),
		StartRequestHash: current.StartRequestHash,
		CreatedAt:        timestamptz(current.CreatedAt),
		UpdatedAt:        timestamptz(current.UpdatedAt),
	})
}

func (transaction *workspaceCycleTx) ReplanGoalCAS(
	ctx context.Context,
	replanned goal.Goal,
	expectedRevision int64,
) (int64, error) {
	if replanned.Status != goal.StatusActiveCycle || replanned.Revision != expectedRevision+1 ||
		replanned.NextCycleSequenceNumber < 3 {
		return 0, fmt.Errorf("%w: replanned Goal state is inconsistent", workspace.ErrCyclePersistenceInvariant)
	}
	return transaction.queries.ReplanGoalCAS(ctx, db.ReplanGoalCASParams{
		NextCycleSequenceNumber:         replanned.NextCycleSequenceNumber,
		Revision:                        replanned.Revision,
		UpdatedAt:                       timestamptz(replanned.UpdatedAt),
		GoalID:                          mustUUID(replanned.ID),
		UserID:                          mustUUID(replanned.UserID),
		CurrentVersionNumber:            replanned.CurrentVersionNumber,
		ExpectedNextCycleSequenceNumber: replanned.NextCycleSequenceNumber - 1,
		ExpectedRevision:                expectedRevision,
	})
}

func (transaction *workspaceCycleTx) InsertReviewDraft(
	ctx context.Context,
	draft goal.Draft,
) (int64, error) {
	if draft.Type != goal.DraftReview || draft.GoalID == nil || draft.BaseGoalVersionID == nil || draft.ReviewCycleID == nil {
		return 0, fmt.Errorf("%w: Cycle Review Draft state is incomplete", workspace.ErrCyclePersistenceInvariant)
	}
	body, err := transaction.content.encode(ctx, draft.UserID, "goal_drafts", draft.ID, "body", draft.Revision+1, draft.Body)
	if err != nil {
		return 0, err
	}
	rows, err := transaction.queries.InsertReviewDraftForTransition(ctx, db.InsertReviewDraftForTransitionParams{
		DraftID:           mustUUID(draft.ID),
		UserID:            mustUUID(draft.UserID),
		GoalID:            mustUUID(*draft.GoalID),
		BaseGoalVersionID: mustUUID(*draft.BaseGoalVersionID),
		ReviewCycleID:     mustUUID(*draft.ReviewCycleID),
		Body:              body,
		Revision:          draft.Revision,
		CreatedAt:         timestamptz(draft.CreatedAt),
		UpdatedAt:         timestamptz(draft.UpdatedAt),
	})
	if err != nil || rows != 1 || draft.SuccessSignal == nil {
		return rows, err
	}
	signal, err := transaction.content.encode(
		ctx, draft.UserID, "goal_draft_success_signals", draft.ID, "success_signal", draft.Revision+1, *draft.SuccessSignal,
	)
	if err != nil {
		return 0, err
	}
	signalRows, err := transaction.queries.InsertReviewDraftSuccessSignalForTransition(ctx, db.InsertReviewDraftSuccessSignalForTransitionParams{
		GoalDraftID: mustUUID(draft.ID), SuccessSignal: signal,
	})
	if err != nil {
		return 0, err
	}
	if signalRows != 1 {
		return 0, fmt.Errorf("%w: inserted Review Draft success signal affected an unexpected row count", workspace.ErrCyclePersistenceInvariant)
	}
	return rows, nil
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
	return getGoalView(ctx, transaction.tx, transaction.content, userID, goalID)
}

func (transaction *workspaceCycleTx) LoadCycleView(
	ctx context.Context,
	userID, goalID, cycleID string,
) (workspace.CycleView, error) {
	return queryCycleView(ctx, transaction.tx, transaction.content, userID, goalID, cycleID)
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
	if err = transaction.content.decodeDraft(
		ctx, userID, uuidString(row.ID), &row.Body, &row.SuccessSignal,
	); err != nil {
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
		SuccessSignal:     optionalNonEmptyText(row.SuccessSignal),
		Revision:          row.Revision,
		UpdatedAt:         row.UpdatedAt.Time.UTC(),
	}, nil
}

func goalTransitionPersistenceError(detail string) error {
	return fmt.Errorf("%w: %s", workspace.ErrGoalPersistenceInvariant, detail)
}
