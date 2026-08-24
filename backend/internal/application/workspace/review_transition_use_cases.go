package workspace

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

var ErrReviewTransitionPersistenceInvariant = errors.New("Review transition persistence invariant violated")

type ReviewTransitionUseCases struct {
	uow   ReviewTransitionUnitOfWork
	clock ports.Clock
	ids   ports.IDGenerator
}

func NewReviewTransitionUseCases(uow ReviewTransitionUnitOfWork, clock ports.Clock, ids ports.IDGenerator) *ReviewTransitionUseCases {
	return &ReviewTransitionUseCases{uow: uow, clock: clock, ids: ids}
}

func (useCases *ReviewTransitionUseCases) ContinueReview(ctx context.Context, input ContinueReviewInput) (result ContinueReviewResult, err error) {
	requestHash := continueReviewRequestHash(input)
	err = useCases.uow.WithinReviewTransitionTransaction(ctx, func(tx ReviewTransitionTx) error {
		receipt, findErr := tx.FindContinueReviewReceipt(ctx, input.UserID, input.OperationID)
		if findErr != nil {
			return findErr
		}
		if findErr = validateContinueReviewReceipt(receipt, input, requestHash); findErr != nil {
			return findErr
		}

		lockedGoal, lockErr := tx.LockGoal(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		if lockedGoal.UserID != input.UserID || lockedGoal.ID != input.GoalID {
			return reviewTransitionInvariant("locked Goal target does not match Continue Review")
		}
		if receipt != nil {
			result, lockErr = buildContinueReviewReplay(ctx, tx, input, *receipt)
			return lockErr
		}

		receipt, findErr = tx.FindContinueReviewReceipt(ctx, input.UserID, input.OperationID)
		if findErr != nil {
			return findErr
		}
		if findErr = validateContinueReviewReceipt(receipt, input, requestHash); findErr != nil {
			return findErr
		}
		if receipt != nil {
			result, findErr = buildContinueReviewReplay(ctx, tx, input, *receipt)
			return findErr
		}

		if lockedGoal.Status != goal.StatusGoalReview {
			return ErrGoalReviewNotActive
		}
		draft, lockErr := tx.LockReviewDraft(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			if errors.Is(lockErr, ErrNotFound) {
				return reviewTransitionInvariant("Review Draft is missing while Goal is in review")
			}
			return lockErr
		}
		if lockErr = validateLockedReviewDraft(draft, input.UserID, input.GoalID); lockErr != nil {
			return lockErr
		}
		if lockedGoal.Revision != input.ExpectedGoalRevision {
			return ErrGoalRevisionConflict
		}
		if draft.Revision != input.ExpectedDraftRevision {
			return ErrReviewRevisionConflict
		}

		generations, lockErr := tx.LockDraftGenerations(ctx, input.UserID, draft.ID)
		if lockErr != nil {
			return lockErr
		}
		generationIDs, running, lockErr := validateReviewGenerations(generations)
		if lockErr != nil {
			return lockErr
		}
		if running {
			return ErrAIInProgress
		}
		usages, lockErr := tx.LockDraftUsages(ctx, input.UserID, generationIDs)
		if lockErr != nil {
			return lockErr
		}
		if lockErr = validateReviewUsages(generationIDs, usages); lockErr != nil {
			return lockErr
		}
		usageIDs := reviewUsageIDs(usages)

		currentVersion, loadErr := tx.LoadCurrentGoalVersion(ctx, input.UserID, input.GoalID, lockedGoal.CurrentVersionNumber)
		if loadErr != nil {
			if errors.Is(loadErr, ErrNotFound) || errors.Is(loadErr, ErrGoalVersionConflict) {
				return ErrGoalVersionConflict
			}
			return loadErr
		}
		if loadErr = validateReviewCurrentVersion(currentVersion, lockedGoal, input.UserID, input.GoalID, draft); loadErr != nil {
			return ErrGoalVersionConflict
		}
		_, changed, transitionErr := goal.ReviewBodyChanged(lockedGoal, currentVersion, draft)
		if transitionErr != nil {
			if errors.Is(transitionErr, goal.ErrStateConflict) {
				return ErrGoalVersionConflict
			}
			return transitionErr
		}

		versionID := currentVersion.ID
		if changed {
			versionID, transitionErr = useCases.ids.NewID()
			if transitionErr != nil {
				return transitionErr
			}
			if !isCycleUUIDv7(versionID) {
				return reviewTransitionInvariant("ID generator returned a non-canonical Goal Version UUIDv7")
			}
		}
		cycleID, transitionErr := useCases.ids.NewID()
		if transitionErr != nil {
			return transitionErr
		}
		if !isCycleUUIDv7(cycleID) {
			return reviewTransitionInvariant("ID generator returned a non-canonical Cycle UUIDv7")
		}
		now := useCases.clock.Now().UTC().Truncate(time.Microsecond)
		continued, transitionErr := goal.ContinueReview(
			lockedGoal, currentVersion, draft, versionID, cycleID,
			input.OperationID, requestHash, now,
		)
		if transitionErr != nil {
			return transitionErr
		}

		if continued.VersionCreated {
			rows, writeErr := tx.InsertGoalVersion(ctx, continued.Version)
			if writeErr != nil {
				return writeErr
			}
			if writeErr = requireReviewTransitionRows("insert continued Goal Version", rows, 1); writeErr != nil {
				return writeErr
			}
		}
		rows, writeErr := tx.TryInsertReviewCycleClaim(ctx, continued.Cycle)
		if writeErr != nil {
			return writeErr
		}
		if rows == 0 {
			return classifyLostContinueReviewClaim(ctx, tx, input, requestHash)
		}
		if writeErr = requireReviewTransitionRows("claim continued Cycle operation", rows, 1); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.ContinueGoalCAS(ctx, continued.Goal, input.ExpectedGoalRevision)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireReviewTransitionRows("continue reviewed Goal", rows, 1); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.AttachDraftGenerations(
			ctx, input.UserID, draft.ID, generationIDs, input.GoalID, continued.Version.ID,
		)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireReviewTransitionRows("attach Review generations", rows, int64(len(generationIDs))); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.AttachUsageToGoal(ctx, input.UserID, usageIDs, input.GoalID)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireReviewTransitionRows("attach Review usage", rows, int64(len(usageIDs))); writeErr != nil {
			return writeErr
		}
		rows, writeErr = tx.DeleteReviewDraftCAS(ctx, input.UserID, draft.ID, input.ExpectedDraftRevision)
		if writeErr != nil {
			return writeErr
		}
		if writeErr = requireReviewTransitionRows("delete continued Review Draft", rows, 1); writeErr != nil {
			return writeErr
		}

		result.Goal, writeErr = tx.LoadGoalView(ctx, input.UserID, input.GoalID)
		if writeErr != nil {
			return reviewTransitionMaterializationError("continued Goal", writeErr)
		}
		result.Cycle, writeErr = tx.LoadCycleView(ctx, input.UserID, input.GoalID, cycleID)
		if writeErr != nil {
			return reviewTransitionMaterializationError("continued Cycle", writeErr)
		}
		result.VersionCreated = continued.VersionCreated
		return validateFreshContinueReviewResult(result, continued, input.ExpectedGoalRevision)
	})
	return result, err
}

func (useCases *ReviewTransitionUseCases) Terminate(ctx context.Context, input TerminateInput) (result TerminateResult, err error) {
	if err = validateTerminationInput(input); err != nil {
		return result, err
	}
	requestHash := terminateRequestHash(input)
	err = useCases.uow.WithinReviewTransitionTransaction(ctx, func(tx ReviewTransitionTx) error {
		if lockErr := tx.LockUser(ctx, input.UserID); lockErr != nil {
			return lockErr
		}
		receipt, findErr := tx.FindGoalTerminationReceipt(ctx, input.UserID, input.OperationID)
		if findErr != nil {
			return findErr
		}
		if findErr = validateGoalTerminationReceipt(receipt, input, requestHash); findErr != nil {
			return findErr
		}
		lockedGoal, lockErr := tx.LockGoal(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		if lockedGoal.UserID != input.UserID || lockedGoal.ID != input.GoalID {
			return reviewTransitionInvariant("locked Goal target does not match termination")
		}
		if receipt != nil {
			result, lockErr = buildGoalTerminationReplay(ctx, tx, input, *receipt)
			return lockErr
		}
		if lockedGoal.Status == goal.StatusAchieved || lockedGoal.Status == goal.StatusEnded {
			return ErrGoalAlreadyTerminal
		}
		if lockedGoal.Status != input.ExpectedState {
			return ErrGoalStateConflict
		}
		switch lockedGoal.Status {
		case goal.StatusActiveCycle:
			result, lockErr = useCases.terminateActiveCycle(ctx, tx, input, requestHash, lockedGoal)
		case goal.StatusGoalReview:
			result, lockErr = useCases.terminateGoalReview(ctx, tx, input, requestHash, lockedGoal)
		default:
			return ErrGoalStateConflict
		}
		return lockErr
	})
	return result, err
}

func (useCases *ReviewTransitionUseCases) terminateActiveCycle(
	ctx context.Context,
	tx ReviewTransitionTx,
	input TerminateInput,
	requestHash string,
	lockedGoal goal.Goal,
) (result TerminateResult, err error) {
	current, err := tx.LockCycle(ctx, input.UserID, input.GoalID, input.ActiveCycleID)
	if err != nil {
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrCycleNotFound) {
			return result, ErrGoalStateConflict
		}
		return result, err
	}
	if current.UserID != input.UserID || current.GoalID != input.GoalID || current.ID != input.ActiveCycleID {
		return result, reviewTransitionInvariant("locked active Cycle does not match termination")
	}
	if current.Status != cycle.StatusActive {
		return result, ErrGoalStateConflict
	}
	if lockedGoal.Revision != input.ExpectedGoalRevision {
		return result, ErrGoalStateConflict
	}
	if current.Revisions.Content != *input.ExpectedCycleContentRevision {
		return result, cycle.ErrRevisionConflict
	}
	running, err := tx.HasRunningGoalGeneration(ctx, input.UserID, input.GoalID)
	if err != nil {
		return result, err
	}
	if running {
		return result, ErrAIInProgress
	}
	now := useCases.clock.Now().UTC().Truncate(time.Microsecond)
	reason := cycle.CancellationGoalEnded
	if input.Outcome == goal.StatusAchieved {
		reason = cycle.CancellationGoalAchieved
	}
	canceled, err := cycle.Cancel(current, reason, now)
	if err != nil {
		return result, err
	}
	terminated, err := goal.Terminate(lockedGoal, input.Outcome, input.OperationID, requestHash, now)
	if err != nil {
		return result, err
	}
	rows, err := tx.CancelCycleCAS(ctx, canceled, *input.ExpectedCycleContentRevision)
	if err != nil {
		return result, err
	}
	if err = requireReviewTransitionRows("cancel active Cycle", rows, 1); err != nil {
		return result, err
	}
	rows, err = tx.TerminateGoalCAS(ctx, terminated, input.ExpectedGoalRevision)
	if err != nil {
		return result, err
	}
	if err = requireReviewTransitionRows("terminate active Goal", rows, 1); err != nil {
		return result, err
	}
	result.Goal, err = tx.LoadGoalView(ctx, input.UserID, input.GoalID)
	if err != nil {
		return result, reviewTransitionMaterializationError("terminal Goal", err)
	}
	canceledView, err := tx.LoadCycleView(ctx, input.UserID, input.GoalID, input.ActiveCycleID)
	if err != nil {
		return result, reviewTransitionMaterializationError("canceled Cycle", err)
	}
	result.CanceledCycle = &canceledView
	return result, validateFreshTerminationResult(result, input, terminated, &canceled, nil)
}

func (useCases *ReviewTransitionUseCases) terminateGoalReview(
	ctx context.Context,
	tx ReviewTransitionTx,
	input TerminateInput,
	requestHash string,
	lockedGoal goal.Goal,
) (result TerminateResult, err error) {
	draft, err := tx.LockReviewDraft(ctx, input.UserID, input.GoalID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return result, reviewTransitionInvariant("Review Draft is missing during termination")
		}
		return result, err
	}
	if err = validateLockedReviewDraft(draft, input.UserID, input.GoalID); err != nil {
		return result, err
	}
	if lockedGoal.Revision != input.ExpectedGoalRevision {
		return result, ErrGoalStateConflict
	}
	generations, err := tx.LockDraftGenerations(ctx, input.UserID, draft.ID)
	if err != nil {
		return result, err
	}
	generationIDs, running, err := validateReviewGenerations(generations)
	if err != nil {
		return result, err
	}
	if running {
		return result, ErrAIInProgress
	}
	usages, err := tx.LockDraftUsages(ctx, input.UserID, generationIDs)
	if err != nil {
		return result, err
	}
	if err = validateReviewUsages(generationIDs, usages); err != nil {
		return result, err
	}
	currentVersion, err := tx.LoadCurrentGoalVersion(ctx, input.UserID, input.GoalID, lockedGoal.CurrentVersionNumber)
	if err != nil {
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrGoalVersionConflict) {
			return result, reviewTransitionInvariant("current Goal Version is missing during Review termination")
		}
		return result, err
	}
	if err = validateReviewCurrentVersion(currentVersion, lockedGoal, input.UserID, input.GoalID, draft); err != nil {
		return result, reviewTransitionInvariant("Review Draft base does not match current Goal Version")
	}
	changed, compareErr := goal.ReviewDraftDiffersFromVersion(lockedGoal, currentVersion, draft)
	if compareErr != nil {
		return result, reviewTransitionInvariant("Review aggregate is inconsistent during termination")
	}
	if changed && !input.ConfirmDiscardReviewDraft {
		return result, ErrDiscardConfirmation
	}

	now := useCases.clock.Now().UTC().Truncate(time.Microsecond)
	retainedUsageIDs, expiredUsageIDs, err := partitionReviewUsages(generationIDs, usages, now)
	if err != nil {
		return result, err
	}
	terminated, err := goal.Terminate(lockedGoal, input.Outcome, input.OperationID, requestHash, now)
	if err != nil {
		return result, err
	}
	rows, err := tx.RedactDraftUsagesCAS(ctx, input.UserID, retainedUsageIDs)
	if err != nil {
		return result, err
	}
	if err = requireReviewTransitionRows("redact retained Review usage", rows, int64(len(retainedUsageIDs))); err != nil {
		return result, err
	}
	rows, err = tx.DeleteExpiredFinalizedDraftUsagesCAS(ctx, input.UserID, expiredUsageIDs, now)
	if err != nil {
		return result, err
	}
	if err = requireReviewTransitionRows("delete expired Review usage", rows, int64(len(expiredUsageIDs))); err != nil {
		return result, err
	}
	rows, err = tx.DeleteDraftGenerationsCAS(ctx, input.UserID, draft.ID, generationIDs)
	if err != nil {
		return result, err
	}
	if err = requireReviewTransitionRows("delete Review generations", rows, int64(len(generationIDs))); err != nil {
		return result, err
	}
	rows, err = tx.DeleteReviewDraftCAS(ctx, input.UserID, draft.ID, draft.Revision)
	if err != nil {
		return result, err
	}
	if err = requireReviewTransitionRows("delete terminal Review Draft", rows, 1); err != nil {
		return result, err
	}
	rows, err = tx.TerminateGoalCAS(ctx, terminated, input.ExpectedGoalRevision)
	if err != nil {
		return result, err
	}
	if err = requireReviewTransitionRows("terminate reviewed Goal", rows, 1); err != nil {
		return result, err
	}
	result.Goal, err = tx.LoadGoalView(ctx, input.UserID, input.GoalID)
	if err != nil {
		return result, reviewTransitionMaterializationError("terminal Goal", err)
	}
	return result, validateFreshTerminationResult(result, input, terminated, nil, &currentVersion)
}

func continueReviewRequestHash(input ContinueReviewInput) string {
	return hashRequest(struct {
		GoalID        string `json:"goalId"`
		GoalRevision  int64  `json:"goalRevision"`
		DraftRevision int64  `json:"draftRevision"`
	}{input.GoalID, input.ExpectedGoalRevision, input.ExpectedDraftRevision})
}

func terminateRequestHash(input TerminateInput) string {
	return hashRequest(struct {
		GoalID                    string      `json:"goalId"`
		Outcome                   goal.Status `json:"outcome"`
		ExpectedState             goal.Status `json:"expectedState"`
		GoalRevision              int64       `json:"goalRevision"`
		ActiveCycleID             string      `json:"activeCycleId,omitempty"`
		CycleRevision             *int64      `json:"cycleRevision,omitempty"`
		ConfirmDiscardReviewDraft bool        `json:"confirmDiscardReviewDraft"`
	}{
		input.GoalID, input.Outcome, input.ExpectedState, input.ExpectedGoalRevision,
		input.ActiveCycleID, input.ExpectedCycleContentRevision, input.ConfirmDiscardReviewDraft,
	})
}

func validateTerminationInput(input TerminateInput) error {
	if input.Outcome != goal.StatusAchieved && input.Outcome != goal.StatusEnded {
		return ErrInvalidGoalOutcome
	}
	switch input.ExpectedState {
	case goal.StatusActiveCycle:
		if input.ActiveCycleID == "" || input.ExpectedCycleContentRevision == nil || input.ConfirmDiscardReviewDraft {
			return ErrInvalidTerminationRequest
		}
	case goal.StatusGoalReview:
		if input.ActiveCycleID != "" || input.ExpectedCycleContentRevision != nil {
			return ErrInvalidTerminationRequest
		}
	default:
		return ErrInvalidTerminationRequest
	}
	return nil
}

func validateContinueReviewReceipt(receipt *ContinueReviewReceipt, input ContinueReviewInput, requestHash string) error {
	if receipt == nil {
		return nil
	}
	if receipt.GoalID != input.GoalID || receipt.RequestHash != requestHash || receipt.CycleID == "" {
		return ErrIdempotencyKeyReused
	}
	return nil
}

func validateGoalTerminationReceipt(receipt *GoalTerminationReceipt, input TerminateInput, requestHash string) error {
	if receipt == nil {
		return nil
	}
	if receipt.GoalID != input.GoalID || receipt.RequestHash != requestHash {
		return ErrIdempotencyKeyReused
	}
	return nil
}

func classifyLostContinueReviewClaim(ctx context.Context, tx ReviewTransitionTx, input ContinueReviewInput, requestHash string) error {
	receipt, err := tx.FindContinueReviewReceipt(ctx, input.UserID, input.OperationID)
	if err != nil {
		return err
	}
	if err = validateContinueReviewReceipt(receipt, input, requestHash); err != nil {
		return err
	}
	if receipt == nil {
		return reviewTransitionInvariant("continued Cycle claim affected no row without a competing receipt")
	}
	return reviewTransitionInvariant("matching Continue Review receipt appeared while its Goal lock was held")
}

func buildContinueReviewReplay(ctx context.Context, tx ReviewTransitionTx, input ContinueReviewInput, receipt ContinueReviewReceipt) (result ContinueReviewResult, err error) {
	result.Goal, err = tx.LoadGoalView(ctx, input.UserID, receipt.GoalID)
	if err != nil {
		return result, reviewTransitionMaterializationError("Continue Review replay Goal", err)
	}
	result.Cycle, err = tx.LoadCycleView(ctx, input.UserID, receipt.GoalID, receipt.CycleID)
	if err != nil {
		return result, reviewTransitionMaterializationError("Continue Review replay Cycle", err)
	}
	result.VersionCreated = receipt.VersionCreated
	result.Replayed = true
	if result.Goal.ID != receipt.GoalID || validateGoalCurrentWork(result.Goal) != nil ||
		validateCycleView(result.Cycle, receipt.GoalID, receipt.CycleID) != nil {
		return result, reviewTransitionInvariant("Continue Review replay resources are inconsistent")
	}
	return result, nil
}

func buildGoalTerminationReplay(ctx context.Context, tx ReviewTransitionTx, input TerminateInput, receipt GoalTerminationReceipt) (result TerminateResult, err error) {
	result.Goal, err = tx.LoadGoalView(ctx, input.UserID, receipt.GoalID)
	if err != nil {
		return result, reviewTransitionMaterializationError("termination replay Goal", err)
	}
	if input.ExpectedState == goal.StatusActiveCycle {
		canceled, loadErr := tx.LoadCycleView(ctx, input.UserID, receipt.GoalID, input.ActiveCycleID)
		if loadErr != nil {
			return result, reviewTransitionMaterializationError("termination replay canceled Cycle", loadErr)
		}
		result.CanceledCycle = &canceled
	}
	result.Replayed = true
	return result, validateTerminationResult(result, input, true)
}

func validateLockedReviewDraft(draft goal.Draft, userID, goalID string) error {
	if draft.UserID != userID || draft.Type != goal.DraftReview || draft.GoalID == nil || *draft.GoalID != goalID ||
		draft.BaseGoalVersionID == nil || draft.ReviewCycleID == nil {
		return reviewTransitionInvariant("locked Review Draft references are inconsistent")
	}
	return nil
}

func validateReviewCurrentVersion(version goal.Version, current goal.Goal, userID, goalID string, draft goal.Draft) error {
	if version.UserID != userID || version.GoalID != goalID || version.VersionNumber != current.CurrentVersionNumber ||
		version.ID == "" || draft.BaseGoalVersionID == nil || *draft.BaseGoalVersionID != version.ID {
		return ErrGoalVersionConflict
	}
	return nil
}

func validateReviewGenerations(generations []DraftGenerationState) ([]string, bool, error) {
	ids := make([]string, len(generations))
	running := false
	for index, generation := range generations {
		if generation.ID == "" || (index > 0 && generations[index-1].ID >= generation.ID) {
			return nil, false, reviewTransitionInvariant("Review generations are not locked once in UUID order")
		}
		ids[index] = generation.ID
		running = running || generation.Status == "running"
	}
	return ids, running, nil
}

func validateReviewUsages(generationIDs []string, usages []DraftUsageState) error {
	known := make(map[string]struct{}, len(generationIDs))
	for _, id := range generationIDs {
		known[id] = struct{}{}
	}
	previous := ""
	for _, usage := range usages {
		if usage.OperationID == "" || previous >= usage.OperationID {
			return reviewTransitionInvariant("Review usages are not locked once in UUID order")
		}
		if _, ok := known[usage.OperationID]; !ok {
			return reviewTransitionInvariant("Review usage does not belong to a locked generation")
		}
		if usage.QuotaRetainUntil.IsZero() {
			return reviewTransitionInvariant("Review usage retention deadline is missing")
		}
		previous = usage.OperationID
	}
	return nil
}

func reviewUsageIDs(usages []DraftUsageState) []string {
	ids := make([]string, len(usages))
	for index := range usages {
		ids[index] = usages[index].OperationID
	}
	return ids
}

func partitionReviewUsages(generationIDs []string, usages []DraftUsageState, now time.Time) ([]string, []string, error) {
	if !slices.IsSorted(generationIDs) {
		return nil, nil, reviewTransitionInvariant("Review generation retention input is not ordered")
	}
	if err := validateReviewUsages(generationIDs, usages); err != nil {
		return nil, nil, err
	}
	retained := make([]string, 0, len(usages))
	expired := make([]string, 0, len(usages))
	for _, usage := range usages {
		if now.Before(usage.QuotaRetainUntil) || usage.ProviderUsageFinalizedAt == nil {
			retained = append(retained, usage.OperationID)
		} else {
			expired = append(expired, usage.OperationID)
		}
	}
	return retained, expired, nil
}

func validateFreshContinueReviewResult(result ContinueReviewResult, continued goal.ContinueResult, expectedGoalRevision int64) error {
	if result.Replayed || result.VersionCreated != continued.VersionCreated ||
		validateCycleView(result.Cycle, continued.Goal.ID, continued.Cycle.ID) != nil ||
		result.Cycle.Status != cycle.StatusActive ||
		result.Cycle.GoalVersion.ID != continued.Cycle.GoalVersionID ||
		!goalVersionViewMatchesDomain(result.Cycle.GoalVersion, continued.Version) ||
		result.Cycle.SequenceNumber != continued.Cycle.SequenceNumber ||
		!result.Cycle.StartedAt.Equal(continued.Cycle.StartedAt) ||
		result.Cycle.Plan != "" || result.Cycle.Do != "" ||
		result.Cycle.Check != "" || result.Cycle.Action != "" ||
		result.Cycle.ContentRevision != 0 ||
		result.Cycle.FrameRevisions != (FrameRevisions{}) {
		return reviewTransitionInvariant("continued Cycle response is inconsistent")
	}
	if result.Goal.ID != continued.Goal.ID || result.Goal.Status != goal.StatusActiveCycle ||
		result.Goal.Revision != expectedGoalRevision+1 ||
		!goalVersionViewMatchesDomain(result.Goal.CurrentVersion, continued.Version) ||
		result.Goal.NextCycleSequenceNumber != continued.Goal.NextCycleSequenceNumber ||
		result.Goal.CurrentWork == nil || result.Goal.CurrentWork.Kind != "active_cycle" ||
		result.Goal.CurrentWork.CycleID != continued.Cycle.ID ||
		result.Goal.CurrentWork.CycleSequenceNumber != continued.Cycle.SequenceNumber ||
		validateGoalCurrentWork(result.Goal) != nil {
		return reviewTransitionInvariant("continued Goal response is inconsistent")
	}
	return nil
}

func validateFreshTerminationResult(
	result TerminateResult,
	input TerminateInput,
	terminated goal.Goal,
	canceled *cycle.PDCACycle,
	currentVersion *goal.Version,
) error {
	if err := validateTerminationResult(result, input, false); err != nil {
		return err
	}
	if terminated.TerminalAt == nil || result.Goal.TerminalAt == nil ||
		!result.Goal.TerminalAt.Equal(*terminated.TerminalAt) ||
		result.Goal.NextCycleSequenceNumber != terminated.NextCycleSequenceNumber ||
		result.Goal.CurrentVersion.VersionNumber != terminated.CurrentVersionNumber {
		return reviewTransitionInvariant("fresh terminal Goal response is inconsistent")
	}
	if currentVersion != nil && !goalVersionViewMatchesDomain(result.Goal.CurrentVersion, *currentVersion) {
		return reviewTransitionInvariant("Review termination changed the current Goal Version")
	}
	if canceled != nil {
		if result.CanceledCycle == nil || !canceledCycleViewMatchesDomain(*result.CanceledCycle, *canceled) {
			return reviewTransitionInvariant("fresh canceled Cycle response is inconsistent")
		}
		if !goalVersionViewsEqual(result.Goal.CurrentVersion, result.CanceledCycle.GoalVersion) {
			return reviewTransitionInvariant("active termination Goal Version is inconsistent")
		}
	}
	return nil
}

func canceledCycleViewMatchesDomain(view CycleView, canceled cycle.PDCACycle) bool {
	if view.CanceledAt == nil || canceled.CanceledAt == nil ||
		view.CancellationReason == nil || canceled.CancellationReason == nil {
		return false
	}
	return view.ID == canceled.ID &&
		view.GoalID == canceled.GoalID &&
		view.SequenceNumber == canceled.SequenceNumber &&
		view.Status == canceled.Status &&
		view.GoalVersion.ID == canceled.GoalVersionID &&
		view.StartedAt.Equal(canceled.StartedAt) &&
		view.CompletedAt == nil && canceled.CompletedAt == nil &&
		view.CanceledAt.Equal(*canceled.CanceledAt) &&
		*view.CancellationReason == *canceled.CancellationReason &&
		view.Plan == canceled.Plan &&
		view.Do == canceled.Do &&
		view.Check == canceled.Check &&
		view.Action == canceled.Action &&
		view.ContentRevision == canceled.Revisions.Content &&
		view.FrameRevisions.Plan == canceled.Revisions.Plan &&
		view.FrameRevisions.Do == canceled.Revisions.Do &&
		view.FrameRevisions.Check == canceled.Revisions.Check &&
		view.FrameRevisions.Action == canceled.Revisions.Action
}

func goalVersionViewMatchesDomain(view GoalVersionView, version goal.Version) bool {
	return view.ID == version.ID &&
		view.VersionNumber == version.VersionNumber &&
		view.Body == version.Body &&
		view.CreatedAt.Equal(version.CreatedAt)
}

func goalVersionViewsEqual(first, second GoalVersionView) bool {
	return first.ID == second.ID &&
		first.VersionNumber == second.VersionNumber &&
		first.Body == second.Body &&
		first.CreatedAt.Equal(second.CreatedAt)
}

func validateTerminationResult(result TerminateResult, input TerminateInput, replayed bool) error {
	if result.Replayed != replayed || result.Goal.ID != input.GoalID || result.Goal.Status != input.Outcome ||
		result.Goal.Revision != input.ExpectedGoalRevision+1 || result.Goal.TerminalAt == nil ||
		result.Goal.CurrentWork != nil || validateGoalCurrentWork(result.Goal) != nil {
		return reviewTransitionInvariant("terminal Goal response is inconsistent")
	}
	if input.ExpectedState == goal.StatusGoalReview {
		if result.CanceledCycle != nil {
			return reviewTransitionInvariant("Review termination returned a canceled Cycle")
		}
		return nil
	}
	if result.CanceledCycle == nil || validateCycleView(*result.CanceledCycle, input.GoalID, input.ActiveCycleID) != nil ||
		result.CanceledCycle.Status != cycle.StatusCanceled || result.CanceledCycle.CanceledAt == nil ||
		result.CanceledCycle.CancellationReason == nil || !result.CanceledCycle.CanceledAt.Equal(*result.Goal.TerminalAt) {
		return reviewTransitionInvariant("termination canceled Cycle response is inconsistent")
	}
	wantReason := cycle.CancellationGoalEnded
	if input.Outcome == goal.StatusAchieved {
		wantReason = cycle.CancellationGoalAchieved
	}
	if *result.CanceledCycle.CancellationReason != wantReason {
		return reviewTransitionInvariant("termination cancellation reason is inconsistent")
	}
	return nil
}

func requireReviewTransitionRows(operation string, actual, expected int64) error {
	if actual == expected {
		return nil
	}
	return fmt.Errorf("%w: %s affected %d rows, want %d", ErrReviewTransitionPersistenceInvariant, operation, actual, expected)
}

func reviewTransitionInvariant(detail string) error {
	return fmt.Errorf("%w: %s", ErrReviewTransitionPersistenceInvariant, detail)
}

func reviewTransitionMaterializationError(resource string, err error) error {
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrGoalNotFound) || errors.Is(err, ErrCycleNotFound) {
		return reviewTransitionInvariant(resource + " disappeared after its parent lock")
	}
	return err
}
