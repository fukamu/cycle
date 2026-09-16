package workspace

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/identifier"
	"github.com/fukamu/cycle/backend/internal/securehash"
)

var ErrCyclePersistenceInvariant = errors.New("Cycle persistence invariant violated")

type CycleCompletionIncompleteError struct {
	MissingFrames []cycle.Frame
}

func (err *CycleCompletionIncompleteError) Error() string { return cycle.ErrCycleIncomplete.Error() }
func (err *CycleCompletionIncompleteError) Unwrap() error { return cycle.ErrCycleIncomplete }

type CycleUseCases struct {
	queries  CycleQueryRepository
	uow      CycleUnitOfWork
	clock    ports.Clock
	ids      ports.IDGenerator
	settings CycleUseCaseSettings
}

func NewCycleUseCases(
	queries CycleQueryRepository,
	uow CycleUnitOfWork,
	clock ports.Clock,
	ids ports.IDGenerator,
	settings CycleUseCaseSettings,
) *CycleUseCases {
	settings.CursorSigningKey = append([]byte(nil), settings.CursorSigningKey...)
	return &CycleUseCases{queries: queries, uow: uow, clock: clock, ids: ids, settings: settings}
}

func (useCases *CycleUseCases) ListCycles(ctx context.Context, userID, goalID, cursorValue string, limit int) (CyclePage, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	after, err := useCases.decodeCycleCursor(cursorValue, goalID)
	if err != nil {
		return CyclePage{}, err
	}
	rows, err := useCases.queries.QueryCycleRows(ctx, CycleListQuery{
		UserID: userID, GoalID: goalID, After: after, FetchLimit: limit + 1,
	})
	if err != nil {
		return CyclePage{}, err
	}
	if len(rows) > limit+1 {
		return CyclePage{}, cycleInvariantError("Cycle query returned more rows than requested")
	}
	if err = validateCycleSummaries(rows); err != nil {
		return CyclePage{}, err
	}
	page := CyclePage{Items: []CycleSummary{}}
	if len(rows) > limit {
		last := rows[limit-1]
		next, encodeErr := useCases.encodeCycleCursor(goalID, CycleListKeyset{
			SequenceNumber: last.SequenceNumber,
			CycleID:        last.ID,
		})
		if encodeErr != nil {
			return CyclePage{}, encodeErr
		}
		page.NextCursor = &next
		rows = rows[:limit]
	}
	page.Items = append(page.Items, rows...)
	return page, nil
}

func (useCases *CycleUseCases) GetCycle(ctx context.Context, userID, goalID, cycleID string) (CycleView, error) {
	view, err := useCases.queries.QueryCycle(ctx, userID, goalID, cycleID)
	if err != nil {
		return CycleView{}, err
	}
	if err = validateCycleView(view, goalID, cycleID); err != nil {
		return CycleView{}, err
	}
	return view, nil
}

func (useCases *CycleUseCases) SaveFrame(ctx context.Context, input SaveFrameInput) (result SaveFrameResult, err error) {
	now := useCases.clock.Now().UTC()
	err = useCases.uow.WithinCycleTransaction(ctx, func(tx CycleTx) error {
		lockedGoal, lockErr := tx.LockGoal(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		current, lockErr := tx.LockCycle(ctx, input.UserID, input.GoalID, input.CycleID)
		if lockErr != nil {
			return lockErr
		}
		if current.UserID != input.UserID || current.GoalID != input.GoalID || current.ID != input.CycleID {
			return cycleInvariantError("locked Cycle target does not match the command")
		}
		if lockedGoal.Status != goal.StatusActiveCycle {
			return ErrGoalStateConflict
		}
		aiRunning := false
		if input.Frame == cycle.FrameAction {
			var queryErr error
			aiRunning, queryErr = tx.HasRunningCycleGeneration(ctx, input.UserID, input.GoalID, input.CycleID)
			if queryErr != nil {
				return queryErr
			}
		}
		saved, saveErr := cycle.SaveFrame(
			current,
			input.Frame,
			input.Content,
			input.ExpectedFrameRevision,
			aiRunning,
			now,
		)
		if saveErr != nil {
			return saveErr
		}
		if !saved.NoOp {
			rows, updateErr := tx.SaveCycleFrameCAS(ctx, saved.Cycle, saved.Frame, input.ExpectedFrameRevision)
			if updateErr != nil {
				return updateErr
			}
			if updateErr = requireCycleRows("save Cycle frame", rows, 1); updateErr != nil {
				return updateErr
			}
		}
		result = SaveFrameResult{
			CycleID:         saved.Cycle.ID,
			Frame:           saved.Frame,
			Content:         saved.Content,
			FrameRevision:   saved.Cycle.FrameRevision(saved.Frame),
			ContentRevision: saved.Cycle.Revisions.Content,
			SavedAt:         saved.SavedAt,
		}
		return nil
	})
	return result, err
}

func (useCases *CycleUseCases) ChangeReviewSchedule(
	ctx context.Context,
	input ChangeReviewScheduleInput,
) (result ChangeReviewScheduleResult, err error) {
	err = useCases.uow.WithinCycleTransaction(ctx, func(tx CycleTx) error {
		lockedGoal, lockErr := tx.LockGoal(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		current, lockErr := tx.LockCycle(ctx, input.UserID, input.GoalID, input.CycleID)
		if lockErr != nil {
			return lockErr
		}
		if current.UserID != input.UserID || current.GoalID != input.GoalID || current.ID != input.CycleID {
			return cycleInvariantError("locked Cycle target does not match the review schedule command")
		}
		if lockedGoal.Status != goal.StatusActiveCycle {
			return ErrGoalStateConflict
		}
		changed, changeErr := cycle.ChangeReviewSchedule(
			current,
			input.ReviewDate,
			input.ExpectedReviewScheduleRevision,
		)
		if changeErr != nil {
			return changeErr
		}
		if !changed.NoOp {
			rows, updateErr := tx.SaveCycleReviewScheduleCAS(
				ctx,
				changed.Cycle,
				input.ExpectedReviewScheduleRevision,
			)
			if updateErr != nil {
				return updateErr
			}
			if updateErr = requireCycleRows("change Cycle review schedule", rows, 1); updateErr != nil {
				return updateErr
			}
		}
		result.Cycle, changeErr = tx.LoadCycleView(ctx, input.UserID, input.GoalID, input.CycleID)
		if changeErr != nil {
			return changeErr
		}
		return validateCycleView(result.Cycle, input.GoalID, input.CycleID)
	})
	return result, err
}

func (useCases *CycleUseCases) CompleteCycle(ctx context.Context, input CompleteCycleInput) (result CompleteCycleResult, err error) {
	requestHash := completeCycleRequestHash(input)

	err = useCases.uow.WithinCycleTransaction(ctx, func(tx CycleTx) error {
		_, receiptErr := tx.FindCompleteCycleReceipt(ctx, input.UserID, input.OperationID)
		if receiptErr != nil {
			return receiptErr
		}
		if lockErr := tx.LockUser(ctx, input.UserID); lockErr != nil {
			return lockErr
		}
		receipt, receiptErr := tx.FindCompleteCycleReceipt(ctx, input.UserID, input.OperationID)
		if receiptErr != nil {
			return receiptErr
		}
		if receiptErr = validateCompleteCycleReceipt(receipt, input, requestHash); receiptErr != nil {
			return receiptErr
		}
		lockedGoal, lockErr := tx.LockGoal(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		if lockedGoal.UserID != input.UserID || lockedGoal.ID != input.GoalID {
			return cycleInvariantError("locked Goal target does not match the command")
		}
		if receipt != nil {
			replayed, replayErr := buildCompleteCycleReplay(ctx, tx, input, *receipt)
			if replayErr != nil {
				return replayErr
			}
			result = replayed
			return nil
		}
		current, lockErr := tx.LockCycle(ctx, input.UserID, input.GoalID, input.CycleID)
		if lockErr != nil {
			return lockErr
		}
		if current.UserID != input.UserID || current.GoalID != input.GoalID || current.ID != input.CycleID {
			return cycleInvariantError("locked Cycle target does not match the command")
		}
		if lockedGoal.Status != goal.StatusActiveCycle {
			return ErrGoalStateConflict
		}
		if lockedGoal.Revision != input.ExpectedGoalRevision {
			return ErrGoalRevisionConflict
		}
		currentVersion, queryErr := tx.LoadCurrentGoalVersion(
			ctx,
			input.UserID,
			input.GoalID,
			lockedGoal.CurrentVersionNumber,
		)
		if queryErr != nil {
			if errors.Is(queryErr, ErrNotFound) || errors.Is(queryErr, ErrGoalVersionConflict) {
				return ErrGoalVersionConflict
			}
			return queryErr
		}
		if currentVersion.UserID != input.UserID || currentVersion.GoalID != input.GoalID ||
			currentVersion.VersionNumber != lockedGoal.CurrentVersionNumber || currentVersion.ID != current.GoalVersionID {
			return ErrGoalVersionConflict
		}
		aiRunning, queryErr := tx.HasRunningCycleGeneration(ctx, input.UserID, input.GoalID, input.CycleID)
		if queryErr != nil {
			return queryErr
		}
		now := useCases.clock.Now().UTC()
		completed, completeErr := cycle.Complete(
			current,
			input.OperationID,
			requestHash,
			input.ExpectedContentRevision,
			aiRunning,
			now,
		)
		if completeErr != nil {
			if errors.Is(completeErr, cycle.ErrCycleIncomplete) {
				return &CycleCompletionIncompleteError{MissingFrames: append([]cycle.Frame(nil), current.MissingRequiredFrames()...)}
			}
			return completeErr
		}
		reviewDraftID, idErr := useCases.ids.NewID()
		if idErr != nil {
			return idErr
		}
		if !identifier.IsCanonicalUUIDv7(reviewDraftID) {
			return cycleInvariantError("ID generator returned a non-canonical UUIDv7")
		}
		reviewingGoal, transitionErr := goal.EnterReview(lockedGoal, now)
		if transitionErr != nil {
			return transitionErr
		}
		reviewDraft, transitionErr := goal.NewReviewDraft(reviewDraftID, reviewingGoal, currentVersion, completed, now)
		if transitionErr != nil {
			return transitionErr
		}

		rows, writeErr := tx.CompleteCycleCAS(ctx, completed, input.ExpectedContentRevision)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireCycleRows("complete Cycle", rows, 1); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.InsertReviewDraft(ctx, reviewDraft)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireCycleRows("insert Cycle Review Draft", rows, 1); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.EnterGoalReviewCAS(ctx, reviewingGoal, input.ExpectedGoalRevision)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireCycleRows("enter Goal review", rows, 1); writeErr != nil {
			return writeErr
		}

		result.CompletedCycle, writeErr = tx.LoadCycleView(ctx, input.UserID, input.GoalID, input.CycleID)
		if writeErr != nil {
			return completeCycleMaterializationError("Cycle", writeErr)
		}
		result.Goal, writeErr = tx.LoadGoalView(ctx, input.UserID, input.GoalID)
		if writeErr != nil {
			return completeCycleMaterializationError("Goal", writeErr)
		}
		draft, writeErr := tx.FindReviewDraftByCycle(ctx, input.UserID, input.GoalID, input.CycleID)
		if writeErr != nil {
			return completeCycleMaterializationError("Review Draft", writeErr)
		}
		if draft == nil || draft.ID != reviewDraftID {
			return cycleInvariantError("new Cycle Review Draft is missing")
		}
		result.ReviewDraft = *draft
		return validateCompletedCycleResult(result, input.GoalID, input.CycleID, reviewDraftID, input.ExpectedGoalRevision)
	})
	return result, err
}

func (useCases *CycleUseCases) ReplanCycle(ctx context.Context, input ReplanCycleInput) (result ReplanCycleResult, err error) {
	if !input.Confirmed {
		return result, ErrReplanConfirmation
	}
	requestHash := replanCycleRequestHash(input)
	err = useCases.uow.WithinCycleTransaction(ctx, func(tx CycleTx) error {
		if lockErr := tx.LockUser(ctx, input.UserID); lockErr != nil {
			return lockErr
		}
		receipt, findErr := tx.FindReplanCycleReceipt(ctx, input.UserID, input.OperationID)
		if findErr != nil {
			return findErr
		}
		if findErr = validateReplanCycleReceipt(receipt, input, requestHash); findErr != nil {
			return findErr
		}
		lockedGoal, lockErr := tx.LockGoal(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		if lockedGoal.UserID != input.UserID || lockedGoal.ID != input.GoalID {
			return cycleInvariantError("locked Goal target does not match Replan Cycle")
		}
		if receipt != nil {
			result, lockErr = buildReplanCycleReplay(ctx, tx, input, *receipt)
			return lockErr
		}
		current, lockErr := tx.LockCycle(ctx, input.UserID, input.GoalID, input.CycleID)
		if lockErr != nil {
			return lockErr
		}
		if current.UserID != input.UserID || current.GoalID != input.GoalID || current.ID != input.CycleID {
			return cycleInvariantError("locked Cycle target does not match Replan Cycle")
		}
		if lockedGoal.Status != goal.StatusActiveCycle {
			return ErrGoalStateConflict
		}
		if lockedGoal.Revision != input.ExpectedGoalRevision {
			return ErrGoalRevisionConflict
		}
		if current.Status != cycle.StatusActive {
			return cycle.ErrCycleNotActive
		}
		if lockedGoal.NextCycleSequenceNumber <= 1 ||
			current.SequenceNumber != lockedGoal.NextCycleSequenceNumber-1 {
			return cycleInvariantError("active Cycle sequence does not match its Goal during Replan")
		}
		if current.Revisions.Content != input.ExpectedContentRevision ||
			current.ReviewScheduleRevision != input.ExpectedReviewScheduleRevision {
			return cycle.ErrRevisionConflict
		}
		currentVersion, loadErr := tx.LoadCurrentGoalVersion(
			ctx,
			input.UserID,
			input.GoalID,
			lockedGoal.CurrentVersionNumber,
		)
		if loadErr != nil {
			if errors.Is(loadErr, ErrNotFound) || errors.Is(loadErr, ErrGoalVersionConflict) {
				return ErrGoalVersionConflict
			}
			return loadErr
		}
		if currentVersion.UserID != input.UserID || currentVersion.GoalID != input.GoalID ||
			currentVersion.VersionNumber != lockedGoal.CurrentVersionNumber || currentVersion.ID != current.GoalVersionID {
			return ErrGoalVersionConflict
		}
		aiRunning, loadErr := tx.HasRunningCycleGeneration(ctx, input.UserID, input.GoalID, input.CycleID)
		if loadErr != nil {
			return loadErr
		}
		if aiRunning {
			return ErrAIInProgress
		}
		newCycleID, idErr := useCases.ids.NewID()
		if idErr != nil {
			return idErr
		}
		if !identifier.IsCanonicalUUIDv7(newCycleID) {
			return cycleInvariantError("ID generator returned a non-canonical Replan Cycle UUIDv7")
		}
		now := useCases.clock.Now().UTC().Truncate(time.Microsecond)
		replanned, transitionErr := goal.Replan(
			lockedGoal,
			currentVersion,
			current,
			newCycleID,
			input.OperationID,
			requestHash,
			now,
		)
		if transitionErr != nil {
			if errors.Is(transitionErr, goal.ErrStateConflict) {
				return cycleInvariantError("validated Replan aggregate was rejected by Domain")
			}
			return transitionErr
		}

		rows, writeErr := tx.CancelCycleCAS(ctx, replanned.CanceledCycle, input.ExpectedContentRevision)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireCycleRows("cancel replanned Cycle", rows, 1); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.TryInsertCycleClaim(ctx, replanned.Cycle)
		if writeErr != nil {
			return writeErr
		}
		if rows == 0 {
			return classifyLostReplanCycleClaim(ctx, tx, input, requestHash)
		}
		if writeErr = requireCycleRows("insert replanned successor Cycle", rows, 1); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.ReplanGoalCAS(ctx, replanned.Goal, input.ExpectedGoalRevision)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireCycleRows("advance replanned Goal", rows, 1); writeErr != nil {
			return writeErr
		}

		result.CanceledCycle, writeErr = tx.LoadCycleView(ctx, input.UserID, input.GoalID, input.CycleID)
		if writeErr != nil {
			return replanCycleMaterializationError("canceled Cycle", writeErr)
		}
		result.Goal, writeErr = tx.LoadGoalView(ctx, input.UserID, input.GoalID)
		if writeErr != nil {
			return replanCycleMaterializationError("Goal", writeErr)
		}
		result.Cycle, writeErr = tx.LoadCycleView(ctx, input.UserID, input.GoalID, newCycleID)
		if writeErr != nil {
			return replanCycleMaterializationError("successor Cycle", writeErr)
		}
		return validateFreshReplanCycleResult(result, replanned, input)
	})
	return result, err
}

func replanCycleRequestHash(input ReplanCycleInput) string {
	return hashRequest(struct {
		GoalID                 string `json:"goalId"`
		CycleID                string `json:"cycleId"`
		GoalRevision           int64  `json:"goalRevision"`
		ContentRevision        int64  `json:"contentRevision"`
		ReviewScheduleRevision int64  `json:"reviewScheduleRevision"`
		Confirmed              bool   `json:"confirmed"`
	}{
		input.GoalID,
		input.CycleID,
		input.ExpectedGoalRevision,
		input.ExpectedContentRevision,
		input.ExpectedReviewScheduleRevision,
		input.Confirmed,
	})
}

func validateReplanCycleReceipt(receipt *ReplanCycleReceipt, input ReplanCycleInput, requestHash string) error {
	if receipt == nil {
		return nil
	}
	if receipt.GoalID != input.GoalID || receipt.RequestHash != requestHash ||
		receipt.ReplannedCycleID != input.CycleID || receipt.CycleID == "" ||
		receipt.ReplannedCancellationReason == nil ||
		*receipt.ReplannedCancellationReason != cycle.CancellationReplanned {
		return ErrIdempotencyKeyReused
	}
	return nil
}

func classifyLostReplanCycleClaim(
	ctx context.Context,
	tx CycleTx,
	input ReplanCycleInput,
	requestHash string,
) error {
	receipt, err := tx.FindReplanCycleReceipt(ctx, input.UserID, input.OperationID)
	if err != nil {
		return err
	}
	if err = validateReplanCycleReceipt(receipt, input, requestHash); err != nil {
		return err
	}
	if receipt == nil {
		return cycleInvariantError("Replan Cycle claim affected no row without a competing receipt")
	}
	return cycleInvariantError("matching Replan Cycle receipt appeared while its User lock was held")
}

func buildReplanCycleReplay(
	ctx context.Context,
	tx CycleTx,
	input ReplanCycleInput,
	receipt ReplanCycleReceipt,
) (result ReplanCycleResult, err error) {
	result.CanceledCycle, err = tx.LoadCycleView(ctx, input.UserID, receipt.GoalID, receipt.ReplannedCycleID)
	if err != nil {
		return result, replanCycleMaterializationError("replay canceled Cycle", err)
	}
	result.Goal, err = tx.LoadGoalView(ctx, input.UserID, receipt.GoalID)
	if err != nil {
		return result, replanCycleMaterializationError("replay Goal", err)
	}
	result.Cycle, err = tx.LoadCycleView(ctx, input.UserID, receipt.GoalID, receipt.CycleID)
	if err != nil {
		return result, replanCycleMaterializationError("replay successor Cycle", err)
	}
	result.Replayed = true
	return result, validateReplanCycleReplay(result, receipt)
}

func replanCycleMaterializationError(resource string, err error) error {
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrGoalNotFound) || errors.Is(err, ErrCycleNotFound) {
		return cycleInvariantError("Replan Cycle " + resource + " disappeared after its parent lock")
	}
	return err
}

func validateFreshReplanCycleResult(result ReplanCycleResult, replanned goal.ReplanResult, input ReplanCycleInput) error {
	if err := validateReplanCyclePair(result.CanceledCycle, result.Cycle, input.GoalID, input.CycleID); err != nil {
		return err
	}
	if result.Cycle.ID != replanned.Cycle.ID || result.Cycle.Status != cycle.StatusActive ||
		result.Cycle.ContentRevision != 0 || result.Cycle.FrameRevisions != (FrameRevisions{}) ||
		result.Cycle.Plan != "" || result.Cycle.Do != "" || result.Cycle.Check != "" || result.Cycle.Action != "" ||
		result.Cycle.ReviewDate != nil || result.Cycle.ReviewScheduleRevision != 0 ||
		result.Cycle.PreviousCompletedCycleAction != nil ||
		result.CanceledCycle.ReviewScheduleRevision != replanned.CanceledCycle.ReviewScheduleRevision ||
		!reviewDatesEqual(result.CanceledCycle.ReviewDate, replanned.CanceledCycle.ReviewDate) ||
		result.Goal.ID != input.GoalID || result.Goal.Status != goal.StatusActiveCycle ||
		result.Goal.Revision != input.ExpectedGoalRevision+1 ||
		!goalVersionViewsEqual(result.Goal.CurrentVersion, result.Cycle.GoalVersion) ||
		result.Goal.NextCycleSequenceNumber != result.Cycle.SequenceNumber+1 || validateGoalCurrentWork(result.Goal) != nil ||
		result.Goal.CurrentWork == nil || result.Goal.CurrentWork.Kind != "active_cycle" ||
		result.Goal.CurrentWork.CycleID != result.Cycle.ID ||
		result.Goal.CurrentWork.CycleSequenceNumber != result.Cycle.SequenceNumber {
		return cycleInvariantError("fresh Replan Cycle response is inconsistent")
	}
	return nil
}

func validateReplanCycleReplay(result ReplanCycleResult, receipt ReplanCycleReceipt) error {
	if !result.Replayed || result.Goal.ID != receipt.GoalID || result.Cycle.ID != receipt.CycleID ||
		validateGoalCurrentWork(result.Goal) != nil {
		return cycleInvariantError("Replan Cycle replay Goal is inconsistent")
	}
	if result.Cycle.Status == cycle.StatusActive &&
		(result.Goal.Status != goal.StatusActiveCycle || result.Goal.CurrentWork == nil ||
			result.Goal.CurrentWork.CycleID != result.Cycle.ID ||
			result.Goal.CurrentWork.CycleSequenceNumber != result.Cycle.SequenceNumber) {
		return cycleInvariantError("active Replan Cycle replay is not the current Goal work")
	}
	return validateReplanCyclePair(result.CanceledCycle, result.Cycle, receipt.GoalID, receipt.ReplannedCycleID)
}

func validateReplanCyclePair(canceled, next CycleView, goalID, canceledCycleID string) error {
	if validateCycleView(canceled, goalID, canceledCycleID) != nil ||
		validateCycleView(next, goalID, next.ID) != nil ||
		canceled.Status != cycle.StatusCanceled || canceled.CancellationReason == nil ||
		*canceled.CancellationReason != cycle.CancellationReplanned || canceled.CanceledAt == nil ||
		next.SequenceNumber != canceled.SequenceNumber+1 ||
		!goalVersionViewsEqual(next.GoalVersion, canceled.GoalVersion) {
		return cycleInvariantError("Replan Cycle pair is inconsistent")
	}
	return nil
}

func reviewDatesEqual(left, right *cycle.ReviewDate) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func completeCycleRequestHash(input CompleteCycleInput) string {
	return hashRequest(struct {
		GoalID          string `json:"goalId"`
		CycleID         string `json:"cycleId"`
		GoalRevision    int64  `json:"goalRevision"`
		ContentRevision int64  `json:"contentRevision"`
	}{
		GoalID: input.GoalID, CycleID: input.CycleID,
		GoalRevision: input.ExpectedGoalRevision, ContentRevision: input.ExpectedContentRevision,
	})
}

func validateCompleteCycleReceipt(receipt *CompleteCycleReceipt, input CompleteCycleInput, requestHash string) error {
	if receipt == nil {
		return nil
	}
	if receipt.GoalID != input.GoalID || receipt.CycleID != input.CycleID || receipt.RequestHash != requestHash {
		return ErrIdempotencyKeyReused
	}
	return nil
}

func buildCompleteCycleReplay(
	ctx context.Context,
	tx CycleTx,
	input CompleteCycleInput,
	receipt CompleteCycleReceipt,
) (result CompleteCycleResult, err error) {
	result.Goal, err = tx.LoadGoalView(ctx, input.UserID, receipt.GoalID)
	if err != nil {
		return result, completeCycleMaterializationError("Goal", err)
	}
	result.CompletedCycle, err = tx.LoadCycleView(ctx, input.UserID, receipt.GoalID, receipt.CycleID)
	if err != nil {
		return result, completeCycleMaterializationError("Cycle", err)
	}
	draft, err := tx.FindReviewDraftByCycle(ctx, input.UserID, receipt.GoalID, receipt.CycleID)
	if err != nil {
		return result, completeCycleMaterializationError("Review Draft", err)
	}
	if draft == nil {
		result.Replay = &CommandReplayResponse{
			Replayed:  true,
			Operation: "complete_cycle",
			ResourceIDs: CommandReplayResourceIDs{
				GoalID:  receipt.GoalID,
				CycleID: receipt.CycleID,
			},
			CurrentGoalState: result.Goal.Status,
			CurrentWorkspace: result.Goal.CurrentWork,
		}
		return result, validateCompleteCycleReplay(result, receipt, false)
	}
	result.ReviewDraft = *draft
	result.Replayed = true
	return result, validateCompleteCycleReplay(result, receipt, true)
}

func completeCycleMaterializationError(resource string, err error) error {
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrGoalNotFound) || errors.Is(err, ErrCycleNotFound) {
		return cycleInvariantError("Complete Cycle " + resource + " disappeared after its parent lock")
	}
	return err
}

func validateCompleteCycleReplay(result CompleteCycleResult, receipt CompleteCycleReceipt, hasDraft bool) error {
	if result.Goal.ID != receipt.GoalID || validateGoalCurrentWork(result.Goal) != nil ||
		validateCycleView(result.CompletedCycle, receipt.GoalID, receipt.CycleID) != nil ||
		result.CompletedCycle.Status != cycle.StatusCompleted {
		return cycleInvariantError("Complete Cycle replay resources are inconsistent")
	}
	if hasDraft {
		if result.Replay != nil || result.ReviewDraft.GoalID == nil || *result.ReviewDraft.GoalID != receipt.GoalID ||
			result.ReviewDraft.ReviewCycleID == nil || *result.ReviewDraft.ReviewCycleID != receipt.CycleID ||
			result.ReviewDraft.BaseGoalVersionID == nil ||
			*result.ReviewDraft.BaseGoalVersionID != result.CompletedCycle.GoalVersion.ID ||
			!optionalStringsEqual(result.ReviewDraft.SuccessSignal, result.CompletedCycle.GoalVersion.SuccessSignal) ||
			result.ReviewDraft.DraftType != string(goal.DraftReview) || result.Goal.Status != goal.StatusGoalReview ||
			result.Goal.CurrentWork == nil || result.Goal.CurrentWork.ReviewDraftID != result.ReviewDraft.ID ||
			result.Goal.CurrentWork.TriggerCycleID != receipt.CycleID {
			return cycleInvariantError("Complete Cycle replay Draft is inconsistent")
		}
		return nil
	}
	if result.Goal.Status == goal.StatusGoalReview && result.Goal.CurrentWork != nil &&
		result.Goal.CurrentWork.TriggerCycleID == receipt.CycleID {
		return cycleInvariantError("current Cycle Review Draft is missing")
	}
	if result.Replay == nil || result.Replayed || result.Replay.Operation != "complete_cycle" ||
		result.Replay.ResourceIDs.GoalID != receipt.GoalID || result.Replay.ResourceIDs.CycleID != receipt.CycleID {
		return cycleInvariantError("Complete Cycle replay response is inconsistent")
	}
	return nil
}

func validateCompletedCycleResult(result CompleteCycleResult, goalID, cycleID, draftID string, expectedGoalRevision int64) error {
	if validateCycleView(result.CompletedCycle, goalID, cycleID) != nil ||
		result.CompletedCycle.Status != cycle.StatusCompleted || result.CompletedCycle.CompletedAt == nil {
		return cycleInvariantError("completed Cycle response is inconsistent")
	}
	if result.Goal.ID != goalID || result.Goal.Revision != expectedGoalRevision+1 ||
		!goalVersionViewsEqual(result.Goal.CurrentVersion, result.CompletedCycle.GoalVersion) || validateGoalCurrentWork(result.Goal) != nil ||
		result.Goal.Status != goal.StatusGoalReview || result.Goal.CurrentWork == nil ||
		result.Goal.CurrentWork.Kind != "goal_review" || result.Goal.CurrentWork.ReviewDraftID != draftID ||
		result.Goal.CurrentWork.TriggerCycleID != cycleID ||
		result.Goal.CurrentWork.TriggerCycleSequenceNumber != result.CompletedCycle.SequenceNumber {
		return cycleInvariantError("reviewing Goal response is inconsistent")
	}
	if result.ReviewDraft.ID != draftID || result.ReviewDraft.DraftType != string(goal.DraftReview) ||
		result.ReviewDraft.GoalID == nil || *result.ReviewDraft.GoalID != goalID ||
		result.ReviewDraft.ReviewCycleID == nil || *result.ReviewDraft.ReviewCycleID != cycleID ||
		result.ReviewDraft.BaseGoalVersionID == nil || *result.ReviewDraft.BaseGoalVersionID != result.CompletedCycle.GoalVersion.ID ||
		result.ReviewDraft.Body != result.CompletedCycle.GoalVersion.Body ||
		!optionalStringsEqual(result.ReviewDraft.SuccessSignal, result.CompletedCycle.GoalVersion.SuccessSignal) ||
		result.ReviewDraft.Revision != 0 {
		return cycleInvariantError("Cycle Review Draft response is inconsistent")
	}
	return nil
}

type cycleCursorPayload struct {
	Scope    string     `json:"scope"`
	Category *int16     `json:"category,omitempty"`
	Time     *time.Time `json:"time,omitempty"`
	Sequence *int32     `json:"sequence,omitempty"`
	ID       string     `json:"id,omitempty"`
}

func (useCases *CycleUseCases) encodeCycleCursor(goalID string, keyset CycleListKeyset) (string, error) {
	payload := cycleCursorPayload{
		Scope:    "cycles:" + goalID,
		Sequence: &keyset.SequenceNumber,
		ID:       keyset.CycleID,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	signature := securehash.HMACSHA256(useCases.settings.CursorSigningKey, body)
	return base64.RawURLEncoding.EncodeToString(append(body, signature...)), nil
}

func (useCases *CycleUseCases) decodeCycleCursor(encoded, goalID string) (*CycleListKeyset, error) {
	if strings.TrimSpace(encoded) == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) <= sha256.Size {
		return nil, ErrInvalidCursor
	}
	body, signature := raw[:len(raw)-sha256.Size], raw[len(raw)-sha256.Size:]
	if !hmac.Equal(signature, securehash.HMACSHA256(useCases.settings.CursorSigningKey, body)) {
		return nil, ErrInvalidCursor
	}
	var payload cycleCursorPayload
	if json.Unmarshal(body, &payload) != nil || payload.Scope != "cycles:"+goalID || payload.Category != nil ||
		payload.Time != nil || payload.Sequence == nil || *payload.Sequence <= 0 || !identifier.IsCanonicalUUIDv7(payload.ID) {
		return nil, ErrInvalidCursor
	}
	return &CycleListKeyset{SequenceNumber: *payload.Sequence, CycleID: payload.ID}, nil
}

func validateCycleSummaries(rows []CycleSummary) error {
	for index, row := range rows {
		if !identifier.IsCanonicalUUIDv7(row.ID) || row.SequenceNumber <= 0 || row.StartedAt.IsZero() {
			return cycleInvariantError("Cycle query row metadata is incomplete")
		}
		if err := validateCycleSummaryStatusTimes(row.Status, row.CompletedAt, row.CanceledAt, row.CancellationReason); err != nil {
			return err
		}
		if err := validateCycleSummaryPreviews(row); err != nil {
			return err
		}
		if err := validateCycleGoalVersion(row.GoalVersion); err != nil {
			return err
		}
		if index > 0 && !cycleSummaryFollows(rows[index-1], row) {
			return cycleInvariantError("Cycle query rows are not in stable order")
		}
	}
	return nil
}

func validateCycleSummaryPreviews(row CycleSummary) error {
	if utf8.RuneCountInString(row.PlanPreview) > CycleSummaryPreviewMaxCodePoints {
		return cycleInvariantError("Cycle Plan preview exceeds the bounded summary limit")
	}
	if row.Status == cycle.StatusActive {
		if row.LearningPreview != nil {
			return cycleInvariantError("active Cycle summary exposes a learning preview")
		}
		return nil
	}
	if row.LearningPreview == nil {
		return cycleInvariantError("terminal Cycle summary is missing its learning preview")
	}
	if !validCycleFramePreview(row.LearningPreview.Check) || !validCycleFramePreview(row.LearningPreview.Action) {
		return cycleInvariantError("terminal Cycle summary learning preview is invalid")
	}
	return nil
}

func validCycleFramePreview(preview CycleFramePreview) bool {
	length := utf8.RuneCountInString(preview.Text)
	return length <= CycleSummaryPreviewMaxCodePoints &&
		(!preview.Truncated || length == CycleSummaryPreviewMaxCodePoints)
}

func cycleSummaryFollows(previous, current CycleSummary) bool {
	if current.SequenceNumber != previous.SequenceNumber {
		return current.SequenceNumber < previous.SequenceNumber
	}
	return current.ID < previous.ID
}

func validateCycleView(view CycleView, goalID, cycleID string) error {
	if view.ID != cycleID || view.GoalID != goalID || view.SequenceNumber <= 0 || view.StartedAt.IsZero() ||
		view.ContentRevision < 0 || view.ReviewScheduleRevision < 0 ||
		view.FrameRevisions.Plan < 0 || view.FrameRevisions.Do < 0 ||
		view.FrameRevisions.Check < 0 || view.FrameRevisions.Action < 0 {
		return cycleInvariantError("Cycle view metadata is inconsistent")
	}
	if view.ReviewDate != nil {
		if _, err := cycle.ParseReviewDate(string(*view.ReviewDate)); err != nil {
			return cycleInvariantError("Cycle review date is invalid")
		}
	}
	if view.ContentRevision != view.FrameRevisions.Plan+view.FrameRevisions.Do+view.FrameRevisions.Check+view.FrameRevisions.Action {
		return cycleInvariantError("Cycle content revision does not match frame revisions")
	}
	if err := validateCycleStatusTimes(view.Status, view.CompletedAt, view.CanceledAt, view.CancellationReason); err != nil {
		return err
	}
	if err := validateCycleGoalVersion(view.GoalVersion); err != nil {
		return err
	}
	if err := validatePreviousCompletedCycleAction(view); err != nil {
		return err
	}
	return nil
}

func validatePreviousCompletedCycleAction(view CycleView) error {
	if view.Status != cycle.StatusActive || view.SequenceNumber == 1 {
		if view.PreviousCompletedCycleAction != nil || view.Predecessor != nil {
			return cycleInvariantError("Cycle must not expose a previous completed Action")
		}
		return nil
	}
	predecessor := view.Predecessor
	if predecessor == nil || !identifier.IsCanonicalUUIDv7(predecessor.CycleID) || predecessor.CycleID == view.ID ||
		predecessor.CycleSequenceNumber != view.SequenceNumber-1 || predecessor.GoalVersionNumber <= 0 ||
		predecessor.GoalVersionNumber > view.GoalVersion.VersionNumber ||
		predecessor.GoalVersionNumber < view.GoalVersion.VersionNumber-1 {
		return cycleInvariantError("active Cycle predecessor is inconsistent")
	}
	previous := view.PreviousCompletedCycleAction
	switch predecessor.Status {
	case cycle.StatusCompleted:
		if predecessor.CancellationReason != nil || previous == nil || previous.CycleID != predecessor.CycleID ||
			previous.CycleSequenceNumber != predecessor.CycleSequenceNumber ||
			previous.GoalVersionNumber != predecessor.GoalVersionNumber || cycle.IsBlank(previous.Action) ||
			utf8.RuneCountInString(previous.Action) > cycle.MaxFrameCodePoints {
			return cycleInvariantError("active Cycle previous completed Action is inconsistent")
		}
	case cycle.StatusCanceled:
		if predecessor.CancellationReason == nil || *predecessor.CancellationReason != cycle.CancellationReplanned ||
			predecessor.GoalVersionNumber != view.GoalVersion.VersionNumber || previous != nil {
			return cycleInvariantError("active Cycle replanned predecessor is inconsistent")
		}
	default:
		return cycleInvariantError("active Cycle predecessor status is invalid")
	}
	return nil
}

func validateCycleSummaryStatusTimes(
	status cycle.Status,
	completedAt, canceledAt *time.Time,
	reason *cycle.CancellationReason,
) error {
	switch status {
	case cycle.StatusActive:
		if completedAt != nil || canceledAt != nil || reason != nil {
			return cycleInvariantError("active Cycle summary has terminal metadata")
		}
	case cycle.StatusCompleted:
		if completedAt == nil || canceledAt != nil || reason != nil {
			return cycleInvariantError("completed Cycle summary terminal metadata is invalid")
		}
	case cycle.StatusCanceled:
		if completedAt != nil || canceledAt == nil || reason == nil || !cycle.IsValidCancellationReason(*reason) {
			return cycleInvariantError("canceled Cycle summary terminal metadata is invalid")
		}
	default:
		return cycleInvariantError("Cycle status is invalid")
	}
	return nil
}

func validateCycleStatusTimes(
	status cycle.Status,
	completedAt, canceledAt *time.Time,
	reason *cycle.CancellationReason,
) error {
	switch status {
	case cycle.StatusActive:
		if completedAt != nil || canceledAt != nil || reason != nil {
			return cycleInvariantError("active Cycle has terminal metadata")
		}
	case cycle.StatusCompleted:
		if completedAt == nil || canceledAt != nil || reason != nil {
			return cycleInvariantError("completed Cycle terminal metadata is invalid")
		}
	case cycle.StatusCanceled:
		if completedAt != nil || canceledAt == nil || reason == nil ||
			!cycle.IsValidCancellationReason(*reason) {
			return cycleInvariantError("canceled Cycle terminal metadata is invalid")
		}
	default:
		return cycleInvariantError("Cycle status is invalid")
	}
	return nil
}

func validateCycleGoalVersion(version GoalVersionView) error {
	if !identifier.IsCanonicalUUIDv7(version.ID) || version.VersionNumber <= 0 || version.CreatedAt.IsZero() {
		return cycleInvariantError("Cycle Goal Version is incomplete")
	}
	return nil
}

func requireCycleRows(operation string, actual, expected int64) error {
	if actual == expected {
		return nil
	}
	return fmt.Errorf("%w: %s affected %d rows, want %d", ErrCyclePersistenceInvariant, operation, actual, expected)
}

func cycleInvariantError(detail string) error {
	return fmt.Errorf("%w: %s", ErrCyclePersistenceInvariant, detail)
}
