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

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
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
		if !isCycleUUIDv7(reviewDraftID) {
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
		result.Goal.CurrentVersion.ID != result.CompletedCycle.GoalVersion.ID || validateGoalCurrentWork(result.Goal) != nil ||
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
		result.ReviewDraft.Body != result.CompletedCycle.GoalVersion.Body || result.ReviewDraft.Revision != 0 {
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
	mac := hmac.New(sha256.New, useCases.settings.CursorSigningKey)
	_, _ = mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(append(body, mac.Sum(nil)...)), nil
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
	mac := hmac.New(sha256.New, useCases.settings.CursorSigningKey)
	_, _ = mac.Write(body)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, ErrInvalidCursor
	}
	var payload cycleCursorPayload
	if json.Unmarshal(body, &payload) != nil || payload.Scope != "cycles:"+goalID || payload.Category != nil ||
		payload.Time != nil || payload.Sequence == nil || *payload.Sequence <= 0 || !isCycleUUIDv7(payload.ID) {
		return nil, ErrInvalidCursor
	}
	return &CycleListKeyset{SequenceNumber: *payload.Sequence, CycleID: payload.ID}, nil
}

func validateCycleSummaries(rows []CycleSummary) error {
	for index, row := range rows {
		if !isCycleUUIDv7(row.ID) || row.SequenceNumber <= 0 || row.StartedAt.IsZero() {
			return cycleInvariantError("Cycle query row metadata is incomplete")
		}
		if err := validateCycleSummaryStatusTimes(row.Status, row.CompletedAt, row.CanceledAt); err != nil {
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

func cycleSummaryFollows(previous, current CycleSummary) bool {
	if current.SequenceNumber != previous.SequenceNumber {
		return current.SequenceNumber < previous.SequenceNumber
	}
	return current.ID < previous.ID
}

func validateCycleView(view CycleView, goalID, cycleID string) error {
	if view.ID != cycleID || view.GoalID != goalID || view.SequenceNumber <= 0 || view.StartedAt.IsZero() ||
		view.ContentRevision < 0 || view.FrameRevisions.Plan < 0 || view.FrameRevisions.Do < 0 ||
		view.FrameRevisions.Check < 0 || view.FrameRevisions.Action < 0 {
		return cycleInvariantError("Cycle view metadata is inconsistent")
	}
	if view.ContentRevision != view.FrameRevisions.Plan+view.FrameRevisions.Do+view.FrameRevisions.Check+view.FrameRevisions.Action {
		return cycleInvariantError("Cycle content revision does not match frame revisions")
	}
	if err := validateCycleStatusTimes(view.Status, view.CompletedAt, view.CanceledAt, view.CancellationReason); err != nil {
		return err
	}
	return validateCycleGoalVersion(view.GoalVersion)
}

func validateCycleSummaryStatusTimes(status cycle.Status, completedAt, canceledAt *time.Time) error {
	switch status {
	case cycle.StatusActive:
		if completedAt != nil || canceledAt != nil {
			return cycleInvariantError("active Cycle summary has terminal metadata")
		}
	case cycle.StatusCompleted:
		if completedAt == nil || canceledAt != nil {
			return cycleInvariantError("completed Cycle summary terminal metadata is invalid")
		}
	case cycle.StatusCanceled:
		if completedAt != nil || canceledAt == nil {
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
			(*reason != cycle.CancellationGoalAchieved && *reason != cycle.CancellationGoalEnded) {
			return cycleInvariantError("canceled Cycle terminal metadata is invalid")
		}
	default:
		return cycleInvariantError("Cycle status is invalid")
	}
	return nil
}

func validateCycleGoalVersion(version GoalVersionView) error {
	if !isCycleUUIDv7(version.ID) || version.VersionNumber <= 0 || version.CreatedAt.IsZero() {
		return cycleInvariantError("Cycle Goal Version is incomplete")
	}
	return nil
}

func isCycleUUIDv7(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' ||
		value[14] != '7' || !strings.ContainsRune("89ab", rune(value[19])) {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
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
