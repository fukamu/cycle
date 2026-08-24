package workspace

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

const (
	aiStatusRunning       = "running"
	aiStatusSucceeded     = "succeeded"
	aiStatusFailed        = "failed"
	aiStatusAccepted      = "accepted"
	goalRefineContextSize = 10
	aiRateBucketLifetime  = 2 * time.Minute
)

const goalRefineOperation = domainai.OperationGoalRefine

var ErrGoalDraftPersistenceInvariant = errors.New("Goal Draft persistence invariant violated")

type GoalDraftUseCases struct {
	uow          GoalDraftUnitOfWork
	entitlements EntitlementPolicy
	clock        ports.Clock
	ids          ports.IDGenerator
	settings     GoalDraftUseCaseSettings
}

func NewGoalDraftUseCases(uow GoalDraftUnitOfWork, entitlements EntitlementPolicy, clock ports.Clock, ids ports.IDGenerator, settings GoalDraftUseCaseSettings) *GoalDraftUseCases {
	return &GoalDraftUseCases{uow: uow, entitlements: entitlements, clock: clock, ids: ids, settings: settings}
}

func (useCases *GoalDraftUseCases) CreateDraft(ctx context.Context, userID, body string) (DraftView, error) {
	draftID, err := useCases.ids.NewID()
	if err != nil {
		return DraftView{}, err
	}
	draft, err := goal.NewDraft(draftID, userID, body, useCases.clock.Now().UTC())
	if err != nil {
		return DraftView{}, err
	}
	err = useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		if lockErr := tx.LockUser(ctx, userID); lockErr != nil {
			return lockErr
		}
		existing, findErr := tx.FindCreationDraft(ctx, userID)
		if findErr != nil && !errors.Is(findErr, ErrNotFound) {
			return findErr
		}
		if existing != nil {
			return &DraftAlreadyExistsError{DraftID: existing.ID}
		}
		rows, insertErr := tx.InsertCreationDraft(ctx, draft)
		if insertErr != nil {
			return insertErr
		}
		return requireRows("create Draft", rows, 1)
	})
	return draftView(draft), err
}

func (useCases *GoalDraftUseCases) SaveDraft(ctx context.Context, userID, draftID, body string, expectedRevision int64) (view DraftView, err error) {
	normalized, err := goal.NormalizeText(body, true)
	if err != nil {
		return DraftView{}, err
	}
	now := useCases.clock.Now().UTC()
	err = useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		current, lockErr := tx.LockDraftByID(ctx, userID, draftID)
		if lockErr != nil {
			return lockErr
		}
		if current.Type != goal.DraftCreation {
			return ErrNotFound
		}
		saved, noOp, saveErr := goal.SaveDraft(current, normalized, expectedRevision, now)
		if errors.Is(saveErr, goal.ErrStateConflict) {
			return ErrDraftRevisionConflict
		}
		if saveErr != nil {
			return saveErr
		}
		if !noOp {
			rows, updateErr := tx.SaveDraftCAS(ctx, saved, current.Revision)
			if updateErr != nil {
				return updateErr
			}
			if invariantErr := requireRows("save Draft", rows, 1); invariantErr != nil {
				return invariantErr
			}
		}
		view = draftView(saved)
		return nil
	})
	return view, err
}

func (useCases *GoalDraftUseCases) SaveReview(ctx context.Context, userID, goalID, expectedReviewDraftID, body string, expectedRevision int64) (view DraftView, err error) {
	now := useCases.clock.Now().UTC()
	err = useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		target, lockErr := tx.LockGoalWithCurrentVersion(ctx, userID, goalID)
		if lockErr != nil {
			return lockErr
		}
		if target.Status != goal.StatusGoalReview {
			return ErrGoalReviewNotActive
		}
		current, lockErr := tx.LockDraftByID(ctx, userID, expectedReviewDraftID)
		if errors.Is(lockErr, ErrNotFound) {
			return ErrReviewRevisionConflict
		}
		if lockErr != nil {
			return lockErr
		}
		if current.Type != goal.DraftReview || current.GoalID == nil || *current.GoalID != goalID {
			return ErrReviewRevisionConflict
		}
		normalized, normalizeErr := goal.NormalizeText(body, true)
		if normalizeErr != nil {
			return normalizeErr
		}
		saved, noOp, saveErr := goal.SaveDraft(current, normalized, expectedRevision, now)
		if errors.Is(saveErr, goal.ErrStateConflict) {
			return ErrReviewRevisionConflict
		}
		if saveErr != nil {
			return saveErr
		}
		if !noOp {
			rows, updateErr := tx.SaveDraftCAS(ctx, saved, current.Revision)
			if updateErr != nil {
				return updateErr
			}
			if invariantErr := requireRows("save Review Draft", rows, 1); invariantErr != nil {
				return invariantErr
			}
		}
		view = draftView(saved)
		return nil
	})
	return view, err
}

func (useCases *GoalDraftUseCases) AbandonDraft(ctx context.Context, userID, draftID string) error {
	now := useCases.clock.Now().UTC()
	return useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		if err := tx.LockUser(ctx, userID); err != nil {
			return err
		}
		draft, err := tx.LockDraftByID(ctx, userID, draftID)
		if err != nil {
			return err
		}
		if draft.Type != goal.DraftCreation {
			return ErrNotFound
		}
		generations, err := tx.LockDraftGenerations(ctx, userID, draftID)
		if err != nil {
			return err
		}
		if err = requireGenerationOrder(generations); err != nil {
			return err
		}
		generationIDs := make([]string, len(generations))
		for index, generation := range generations {
			if generation.Status == aiStatusRunning {
				return ErrAIInProgress
			}
			generationIDs[index] = generation.ID
		}
		usages, err := tx.LockDraftUsages(ctx, userID, generationIDs)
		if err != nil {
			return err
		}
		retainedUsageIDs, expiredUsageIDs, err := partitionDraftUsages(generationIDs, usages, now)
		if err != nil {
			return err
		}
		if len(retainedUsageIDs) > 0 {
			rows, redactErr := tx.RedactDraftUsagesCAS(ctx, userID, retainedUsageIDs)
			if redactErr != nil {
				return redactErr
			}
			if redactErr = requireRows("redact abandoned Draft usage", rows, int64(len(retainedUsageIDs))); redactErr != nil {
				return redactErr
			}
		}
		if len(expiredUsageIDs) > 0 {
			rows, deleteErr := tx.DeleteExpiredFinalizedDraftUsagesCAS(ctx, userID, expiredUsageIDs, now)
			if deleteErr != nil {
				return deleteErr
			}
			if deleteErr = requireRows("delete expired abandoned Draft usage", rows, int64(len(expiredUsageIDs))); deleteErr != nil {
				return deleteErr
			}
		}
		if len(generationIDs) > 0 {
			rows, deleteErr := tx.DeleteDraftGenerationsCAS(ctx, userID, draftID, generationIDs)
			if deleteErr != nil {
				return deleteErr
			}
			if deleteErr = requireRows("delete abandoned Draft generations", rows, int64(len(generationIDs))); deleteErr != nil {
				return deleteErr
			}
		}
		rows, err := tx.DeleteCreationDraftCAS(ctx, userID, draftID, draft.Revision)
		if err != nil {
			return err
		}
		return requireRows("delete abandoned Draft", rows, 1)
	})
}

func (useCases *GoalDraftUseCases) StartGoal(ctx context.Context, userID, draftID, operationID string, expectedDraftRevision int64) (result StartGoalResult, err error) {
	goalID, versionID, cycleID, err := useCases.threeIDs()
	if err != nil {
		return result, err
	}
	now := useCases.clock.Now().UTC()
	requestHash := hashRequest(struct {
		DraftID  string `json:"draftId"`
		Revision int64  `json:"revision"`
	}{draftID, expectedDraftRevision})
	err = useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		if lockErr := tx.LockUser(ctx, userID); lockErr != nil {
			return lockErr
		}
		replay, replayErr := tx.FindStartReplay(ctx, userID, operationID)
		if replayErr != nil {
			return replayErr
		}
		if replay != nil {
			if replay.RequestHash != requestHash {
				return ErrIdempotencyKeyReused
			}
			result.Goal, replayErr = tx.LoadGoalView(ctx, userID, replay.GoalID)
			if replayErr != nil {
				return replayErr
			}
			result.Cycle, replayErr = tx.LoadCycleView(ctx, userID, replay.GoalID, replay.CycleID)
			result.Replayed = true
			return replayErr
		}
		draft, lockErr := tx.LockDraftByID(ctx, userID, draftID)
		if lockErr != nil {
			return lockErr
		}
		if draft.Type != goal.DraftCreation {
			return ErrNotFound
		}
		if draft.Revision != expectedDraftRevision {
			return ErrDraftRevisionConflict
		}
		aggregate, aggregateErr := goal.StartInitial(draft, goalID, versionID, cycleID, operationID, requestHash, now)
		if aggregateErr != nil {
			return aggregateErr
		}
		generations, lockErr := tx.LockDraftGenerations(ctx, userID, draftID)
		if lockErr != nil {
			return lockErr
		}
		if lockErr = requireGenerationOrder(generations); lockErr != nil {
			return lockErr
		}
		generationIDs := make([]string, len(generations))
		for index, generation := range generations {
			if generation.Status == aiStatusRunning {
				return ErrAIInProgress
			}
			generationIDs[index] = generation.ID
		}
		limits, limitErr := useCases.entitlements.Limits(ctx, user.ID(userID))
		if limitErr != nil {
			return limitErr
		}
		count, countErr := tx.CountProgressingGoals(ctx, userID)
		if countErr != nil {
			return countErr
		}
		if count >= limits.MaxProgressingGoals {
			return ErrGoalActiveLimit
		}
		if insertErr := insertInitialAggregate(ctx, tx, aggregate); insertErr != nil {
			return insertErr
		}
		if len(generationIDs) > 0 {
			rows, attachErr := tx.AttachDraftGenerations(ctx, userID, draftID, generationIDs, goalID, versionID)
			if attachErr != nil {
				return attachErr
			}
			if attachErr = requireRows("attach Draft generations", rows, int64(len(generationIDs))); attachErr != nil {
				return attachErr
			}
			rows, attachErr = tx.AttachUsageToGoal(ctx, userID, generationIDs, goalID)
			if attachErr != nil {
				return attachErr
			}
			if attachErr = requireRows("attach Draft usage", rows, int64(len(generationIDs))); attachErr != nil {
				return attachErr
			}
		}
		rows, deleteErr := tx.DeleteCreationDraftCAS(ctx, userID, draftID, draft.Revision)
		if deleteErr != nil {
			return deleteErr
		}
		if deleteErr = requireRows("delete started Draft", rows, 1); deleteErr != nil {
			return deleteErr
		}
		result.Goal, deleteErr = tx.LoadGoalView(ctx, userID, goalID)
		if deleteErr != nil {
			return deleteErr
		}
		result.Cycle, deleteErr = tx.LoadCycleView(ctx, userID, goalID, cycleID)
		return deleteErr
	})
	return result, err
}

func (useCases *GoalDraftUseCases) BeginGoalRefine(ctx context.Context, input GoalRefineInput, selectContext AIContextSelector) (snapshot AISnapshot, err error) {
	if input.GenerationID == "" {
		input.GenerationID, err = useCases.ids.NewID()
		if err != nil {
			return snapshot, err
		}
	}
	if input.Now.IsZero() {
		input.Now = useCases.clock.Now().UTC()
	} else {
		input.Now = input.Now.UTC()
	}
	var replayOutcomeErr error
	err = useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		if lockErr := tx.LockUser(ctx, input.UserID); lockErr != nil {
			return lockErr
		}
		var target *GoalTargetState
		if input.GoalID != "" {
			locked, lockErr := tx.LockGoalWithCurrentVersion(ctx, input.UserID, input.GoalID)
			if lockErr != nil {
				return lockErr
			}
			if locked.Status != goal.StatusGoalReview {
				return ErrGoalReviewNotActive
			}
			target = &locked
		}
		draft, lockErr := lockGoalRefineDraft(ctx, tx, input.UserID, input.DraftID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		if validationErr := validateGoalRefineDraftTarget(draft, input.GoalID); validationErr != nil {
			return validationErr
		}
		input.DraftID = draft.ID
		requestHash := goalRefineRequestHash(input)
		if recoveryErr := useCases.recoverExpiredAI(ctx, tx, input.UserID, input.Now); recoveryErr != nil {
			return recoveryErr
		}
		replay, replayErr := tx.FindGoalRefineReplay(ctx, input.UserID, input.IdempotencyKey)
		if replayErr != nil {
			return replayErr
		}
		if replay != nil {
			replayedSnapshot, replayErr := replayGoalRefine(*replay, requestHash)
			if replayErr != nil {
				if errors.Is(replayErr, ErrGoalDraftPersistenceInvariant) {
					return replayErr
				}
				replayOutcomeErr = replayErr
				return nil
			}
			if input.ExpectedGoalRevision != nil {
				replayedSnapshot.SourceGoalRevision = *input.ExpectedGoalRevision
			}
			snapshot = replayedSnapshot
			return nil
		}
		if draft.Revision != input.ExpectedDraftRevision {
			if target != nil {
				return ErrReviewRevisionConflict
			}
			return ErrDraftRevisionConflict
		}
		if strings.TrimSpace(draft.Body) == "" {
			return ErrAIInputIncomplete
		}
		var goalID, goalVersionID, goalBody string
		var sourceGoalRevision int64
		contextCycles := []AIContextCycle{}
		if target != nil {
			if draft.GoalID == nil || *draft.GoalID != input.GoalID || input.ExpectedGoalRevision == nil {
				return ErrGoalStateConflict
			}
			if target.Revision != *input.ExpectedGoalRevision || draft.BaseGoalVersionID == nil ||
				*draft.BaseGoalVersionID != target.CurrentVersionID {
				return ErrGoalRevisionConflict
			}
			goalID = input.GoalID
			goalVersionID = target.CurrentVersionID
			goalBody = target.Body
			sourceGoalRevision = target.Revision
			contextCycles, replayErr = tx.ListAIContextCycles(ctx, input.UserID, input.GoalID, "", goalRefineContextSize)
			if replayErr != nil {
				return replayErr
			}
		}
		snapshot = AISnapshot{
			GenerationID: input.GenerationID, Operation: goalRefineOperation, TargetRevision: draft.Revision,
			SourceGoalRevision: sourceGoalRevision, GoalID: goalID, GoalBody: goalBody,
			SourceText: draft.Body, PastCycles: contextCycles,
		}
		if isolationErr := assertSameGoalContext(snapshot); isolationErr != nil {
			return isolationErr
		}
		if selectContext == nil {
			return ErrAIInputBudget
		}
		candidate := cloneAISnapshot(snapshot)
		snapshot, replayErr = selectContext(ctx, cloneAISnapshot(candidate))
		if replayErr != nil {
			return replayErr
		}
		if isolationErr := validateGoalRefineContextSelection(candidate, snapshot); isolationErr != nil {
			return isolationErr
		}
		if snapshot.CanonicalProviderInputHash == "" {
			return invariantError("Goal Refine canonical provider input hash is missing")
		}
		running, runningErr := tx.HasRunningDraftGeneration(ctx, draft.ID)
		if runningErr != nil {
			return runningErr
		}
		if running {
			return ErrAIInProgress
		}
		limits, limitErr := useCases.entitlements.Limits(ctx, user.ID(input.UserID))
		if limitErr != nil {
			return limitErr
		}
		usageCount, usageErr := tx.CountRollingUsage(ctx, input.UserID, input.Now.Add(-AIRollingWindow))
		if usageErr != nil {
			return usageErr
		}
		if usageCount >= limits.MaxAIOperationsPer24Hours {
			return ErrAIUserLimit
		}
		month := time.Date(input.Now.Year(), input.Now.Month(), 1, 0, 0, 0, 0, time.UTC)
		if budgetErr := tx.EnsureBudgetMonth(ctx, month, input.Now); budgetErr != nil {
			return budgetErr
		}
		budget, budgetErr := tx.LockBudgetMonth(ctx, month)
		if budgetErr != nil {
			return budgetErr
		}
		if rateErr := useCases.checkAIRateLimits(ctx, tx, input, input.Now); rateErr != nil {
			return rateErr
		}
		reservation := decimalFromFloat(useCases.settings.ReservationUSD)
		overBudget, budgetErr := exceedsBudget(budget, reservation, decimalFromFloat(useCases.settings.MonthlyBudgetUSD))
		if budgetErr != nil {
			return budgetErr
		}
		if overBudget {
			return ErrAIBudget
		}
		rows, reserveErr := tx.ReserveBudgetCAS(ctx, month, reservation, input.Now)
		if reserveErr != nil {
			return reserveErr
		}
		if reserveErr = requireRows("reserve Goal Refine budget", rows, 1); reserveErr != nil {
			return reserveErr
		}
		rows, reserveErr = tx.InsertGoalRefineGeneration(ctx, GoalRefineGenerationRecord{
			ID: input.GenerationID, UserID: input.UserID, DraftID: draft.ID,
			GoalID: goalID, GoalVersionID: goalVersionID, TargetRevision: draft.Revision,
			IdempotencyKey: input.IdempotencyKey, IdempotencyRequestHash: requestHash,
			CanonicalProviderInputHash: snapshot.CanonicalProviderInputHash, SourceText: draft.Body,
			Provider: useCases.settings.Provider, Model: useCases.settings.Model,
			PromptVersion: useCases.settings.GoalPromptVersion, BudgetMonthUtc: month,
			ReservedCostUSD: reservation, LeaseExpiresAt: input.Now.Add(useCases.settings.LeaseDuration),
			StartedAt: input.Now, ContextCycleIDs: aiContextCycleIDs(snapshot.PastCycles),
		})
		if reserveErr != nil {
			return reserveErr
		}
		if reserveErr = requireRows("insert Goal Refine generation", rows, 1); reserveErr != nil {
			return reserveErr
		}
		rows, reserveErr = tx.InsertAcceptedUsage(ctx, AIUsageRecord{
			OperationID: input.GenerationID, UserID: input.UserID, GoalID: goalID,
			Operation: goalRefineOperation, Provider: useCases.settings.Provider, Model: useCases.settings.Model,
			PromptVersion: useCases.settings.GoalPromptVersion, AcceptedAt: input.Now,
			QuotaRetainUntil: AIUsageQuotaRetainUntil(input.Now), SettlementBudgetMonthUtc: month,
			SettlementReservationCostUSD: reservation,
		})
		if reserveErr != nil {
			return reserveErr
		}
		return requireRows("insert Goal Refine usage", rows, 1)
	})
	if err != nil {
		return snapshot, err
	}
	return snapshot, replayOutcomeErr
}

func (useCases *GoalDraftUseCases) FinishGoalRefine(ctx context.Context, snapshot AISnapshot, result AIExecutionResult, providerErr error, now time.Time) (response AIResponse, err error) {
	now = now.UTC()
	finishErr := error(nil)
	err = useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		locator, locateErr := tx.FindGenerationLocator(ctx, snapshot.GenerationID)
		if locateErr != nil {
			return locateErr
		}
		if locator == nil {
			if settleErr := useCases.settleLateUsage(ctx, tx, snapshot.GenerationID, "", false, result, providerErr, now); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if locator.Operation != goalRefineOperation {
			return invariantError("Goal Refine generation operation changed")
		}
		if locator.Status != aiStatusRunning {
			if settleErr := useCases.settleLateUsage(ctx, tx, snapshot.GenerationID, "", false, result, providerErr, now); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if lockErr := tx.LockUser(ctx, locator.UserID); lockErr != nil {
			return lockErr
		}
		if locator.GoalID != "" {
			target, lockErr := tx.LockGoalWithCurrentVersion(ctx, locator.UserID, locator.GoalID)
			if errors.Is(lockErr, ErrNotFound) {
				if settleErr := useCases.settleLateUsage(ctx, tx, snapshot.GenerationID, locator.UserID, true, result, providerErr, now); settleErr != nil {
					return settleErr
				}
				finishErr = ErrNotFound
				return nil
			}
			if lockErr != nil {
				return lockErr
			}
			if target.Status != goal.StatusGoalReview {
				providerErr = ErrGoalReviewNotActive
			}
		}
		draft, lockErr := lockGoalRefineDraft(ctx, tx, locator.UserID, locator.DraftID, locator.GoalID)
		if errors.Is(lockErr, ErrNotFound) {
			if settleErr := useCases.settleLateUsage(ctx, tx, snapshot.GenerationID, locator.UserID, true, result, providerErr, now); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if lockErr != nil {
			return lockErr
		}
		if validationErr := validateGoalRefineDraftTarget(draft, locator.GoalID); validationErr != nil {
			return invariantError("Goal Refine generation Draft target changed")
		}
		generation, lockErr := tx.LockGoalRefineGeneration(ctx, GoalRefineGenerationKey{
			GenerationID: snapshot.GenerationID, UserID: locator.UserID, DraftID: draft.ID,
		})
		if errors.Is(lockErr, ErrNotFound) {
			if settleErr := useCases.settleLateUsage(ctx, tx, snapshot.GenerationID, locator.UserID, true, result, providerErr, now); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if lockErr != nil {
			return lockErr
		}
		if generation.TargetRevision != snapshot.TargetRevision {
			return invariantError("Goal Refine generation target revision changed")
		}
		contextChanged := draft.Revision != generation.TargetRevision
		status := aiStatusSucceeded
		output := &result.Output
		failureCode := ""
		if providerErr != nil {
			status = aiStatusFailed
			output = nil
			failureCode = goalRefineFailureCode(providerErr)
		}
		cost := decimalFromFloat(result.Usage.CostUSD)
		rows, settleErr := tx.TerminalizeGenerationCAS(ctx, AIGenerationSettlement{
			GenerationID: snapshot.GenerationID, ExpectedReservationUSD: generation.ReservedCostUSD,
			Status: status, Output: output, InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens,
			EstimatedCostUSD: cost, AttemptCount: result.Attempts, FailureCode: failureCode,
			ProviderRequestID: result.Usage.ProviderRequestID, ContextChanged: contextChanged, FinishedAt: now,
		})
		if settleErr != nil {
			return settleErr
		}
		if settleErr = requireRows("terminalize Goal Refine generation", rows, 1); settleErr != nil {
			return settleErr
		}
		rows, settleErr = tx.SettleBudgetCAS(ctx, generation.BudgetMonthUtc, generation.ReservedCostUSD, cost, now)
		if settleErr != nil {
			return settleErr
		}
		if settleErr = requireRows("settle Goal Refine budget", rows, 1); settleErr != nil {
			return settleErr
		}
		rows, settleErr = tx.FinalizeUsageCAS(ctx, AIUsageSettlement{
			OperationID: snapshot.GenerationID, ExpectedBudgetMonthUtc: generation.BudgetMonthUtc,
			ExpectedReservationCostUSD: generation.ReservedCostUSD, Status: status, InputTokens: result.Usage.InputTokens,
			OutputTokens: result.Usage.OutputTokens, EstimatedCostUSD: cost, FinalizedAt: now,
		})
		if settleErr != nil {
			return settleErr
		}
		if settleErr = requireRows("finalize Goal Refine usage", rows, 1); settleErr != nil {
			return settleErr
		}
		if providerErr != nil {
			finishErr = providerErr
			return nil
		}
		sourceDraftRevision := snapshot.TargetRevision
		response = AIResponse{
			GenerationID: snapshot.GenerationID, SourceDraftRevision: &sourceDraftRevision,
			SourceGoalRevision: snapshot.SourceGoalRevision, Suggestion: result.Output,
			ContextChanged: contextChanged,
		}
		return nil
	})
	if err != nil {
		return AIResponse{}, err
	}
	return response, finishErr
}

func (useCases *GoalDraftUseCases) AdoptGoalSuggestion(ctx context.Context, userID, draftID, goalID, generationID string, expectedDraftRevision int64, expectedGoalRevision *int64) (view DraftView, err error) {
	now := useCases.clock.Now().UTC()
	err = useCases.uow.WithinGoalDraftTransaction(ctx, func(tx GoalDraftTx) error {
		if lockErr := tx.LockUser(ctx, userID); lockErr != nil {
			return lockErr
		}
		if goalID != "" {
			if expectedGoalRevision == nil {
				return ErrGoalRevisionConflict
			}
			target, lockErr := tx.LockGoalWithCurrentVersion(ctx, userID, goalID)
			if lockErr != nil {
				return lockErr
			}
			if target.Status != goal.StatusGoalReview {
				return ErrGoalReviewNotActive
			}
			if target.Revision != *expectedGoalRevision {
				return ErrGoalRevisionConflict
			}
		}
		draft, lockErr := lockGoalRefineDraft(ctx, tx, userID, draftID, goalID)
		if lockErr != nil {
			return lockErr
		}
		if validationErr := validateGoalRefineDraftTarget(draft, goalID); validationErr != nil {
			return validationErr
		}
		suggestion, lockErr := tx.LockSucceededGoalRefineGeneration(ctx, userID, draft.ID, generationID)
		if lockErr != nil {
			if errors.Is(lockErr, ErrNotFound) {
				return ErrAISuggestionNotFound
			}
			return lockErr
		}
		if suggestion.AdoptedAt != nil {
			if suggestion.AdoptedDraftRevision != nil && draft.Revision == *suggestion.AdoptedDraftRevision && draft.Body == suggestion.Output {
				draftView := draftView(draft)
				draftView.Replayed = true
				view = draftView
				return nil
			}
			return ErrAIResultAlreadyAdopted
		}
		if draft.Revision != expectedDraftRevision || suggestion.TargetRevision > draft.Revision || draft.Body != suggestion.SourceText {
			return ErrAIContextStale
		}
		previousRevision := draft.Revision
		draft.Body = suggestion.Output
		draft.Revision++
		draft.UpdatedAt = now
		rows, adoptErr := tx.AdoptDraftCAS(ctx, AdoptDraftRecord{
			DraftID: draft.ID, UserID: userID, ExpectedRevision: previousRevision,
			Body: draft.Body, NewRevision: draft.Revision, UpdatedAt: now,
		})
		if adoptErr != nil {
			return adoptErr
		}
		if adoptErr = requireRows("adopt Goal suggestion into Draft", rows, 1); adoptErr != nil {
			return adoptErr
		}
		rows, adoptErr = tx.MarkSuggestionAdoptedCAS(ctx, generationID, draft.Revision, now)
		if adoptErr != nil {
			return adoptErr
		}
		if adoptErr = requireRows("mark Goal suggestion adopted", rows, 1); adoptErr != nil {
			return adoptErr
		}
		view = draftView(draft)
		return nil
	})
	return view, err
}

func (useCases *GoalDraftUseCases) recoverExpiredAI(ctx context.Context, tx GoalDraftTx, userID string, now time.Time) error {
	items, err := tx.LockExpiredGenerations(ctx, userID, now)
	if err != nil {
		return err
	}
	if err = requireExpiredGenerationOrder(items); err != nil {
		return err
	}
	ids := make([]string, len(items))
	for index, item := range items {
		ids[index] = item.ID
	}
	monthly, err := tx.SumLockedReservationsByMonth(ctx, ids)
	if err != nil {
		return err
	}
	if err = requireMonthlyReservationOrder(monthly); err != nil {
		return err
	}
	for _, reservation := range monthly {
		rows, releaseErr := tx.ReleaseBudgetReservationCAS(ctx, reservation.MonthUtc, reservation.AmountUSD, now)
		if releaseErr != nil {
			return releaseErr
		}
		if releaseErr = requireRows("release expired AI reservation", rows, 1); releaseErr != nil {
			return releaseErr
		}
	}
	for _, item := range items {
		rows, expireErr := tx.ExpireGenerationCAS(ctx, item.ID, item.ReservedCostUSD, now)
		if expireErr != nil {
			return expireErr
		}
		if expireErr = requireRows("expire AI generation", rows, 1); expireErr != nil {
			return expireErr
		}
		rows, expireErr = tx.ExpireUsageCAS(ctx, item.ID, item.BudgetMonthUtc, item.ReservedCostUSD)
		if expireErr != nil {
			return expireErr
		}
		if expireErr = requireRows("expire AI usage", rows, 1); expireErr != nil {
			return expireErr
		}
	}
	return nil
}

func (useCases *GoalDraftUseCases) checkAIRateLimits(ctx context.Context, tx GoalDraftTx, input GoalRefineInput, now time.Time) error {
	checks := []struct {
		scope string
		value string
		limit int
	}{
		{scope: "ai_user_minute", value: input.UserID, limit: useCases.settings.AIPerUserMinute},
		{scope: "ai_session_minute", value: input.SessionID, limit: useCases.settings.AIPerSessionMinute},
		{scope: "ai_ip_minute", value: input.RemoteAddress, limit: useCases.settings.AIPerIPMinute},
	}
	window := now.UTC().Truncate(time.Minute)
	for _, check := range checks {
		if check.value == "" || check.limit <= 0 {
			continue
		}
		count, err := tx.IncrementRateBucket(ctx, AIRateBucket{
			Scope: check.scope, KeyHash: goalDraftRateHash(useCases.settings.RateHashKey, check.scope, check.value),
			WindowStart: window, ExpiresAt: window.Add(aiRateBucketLifetime),
		})
		if err != nil {
			return err
		}
		if count > check.limit {
			return ErrAIRateLimit
		}
	}
	return nil
}

func (useCases *GoalDraftUseCases) settleLateUsage(
	ctx context.Context,
	tx GoalDraftTx,
	generationID string,
	knownUserID string,
	userLocked bool,
	result AIExecutionResult,
	providerErr error,
	now time.Time,
) error {
	locator, err := tx.FindUsageLocator(ctx, generationID)
	if err != nil {
		return err
	}
	if locator == nil || locator.FinalizedAt != nil {
		return nil
	}
	userID := locator.UserID
	if knownUserID != "" && userID != knownUserID {
		return invariantError("late AI usage owner changed")
	}
	if !userLocked {
		if err = tx.LockUser(ctx, userID); errors.Is(err, ErrNotFound) {
			return nil
		} else if err != nil {
			return err
		}
	}
	usage, err := tx.LockUsage(ctx, generationID, userID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil || usage.FinalizedAt != nil {
		return err
	}
	if usage.SettlementBudgetMonthUtc.IsZero() || usage.SettlementReservationCostUSD == "" {
		return invariantError("late AI usage settlement exposure is missing")
	}
	month := usage.SettlementBudgetMonthUtc
	if err = tx.EnsureBudgetMonth(ctx, month, now); err != nil {
		return err
	}
	cost := decimalFromFloat(result.Usage.CostUSD)
	rows, err := tx.AddLateActualCostCAS(ctx, month, cost, now)
	if err != nil {
		return err
	}
	if err = requireRows("add late AI actual cost", rows, 1); err != nil {
		return err
	}
	status := aiStatusSucceeded
	if providerErr != nil {
		status = aiStatusFailed
	}
	rows, err = tx.FinalizeLateUsageCAS(ctx, AIUsageSettlement{
		OperationID: generationID, ExpectedBudgetMonthUtc: month,
		ExpectedReservationCostUSD: usage.SettlementReservationCostUSD, Status: status, InputTokens: result.Usage.InputTokens,
		OutputTokens: result.Usage.OutputTokens, EstimatedCostUSD: cost, FinalizedAt: now,
	})
	if err != nil {
		return err
	}
	return requireRows("finalize late AI usage", rows, 1)
}

func insertInitialAggregate(ctx context.Context, tx GoalDraftTx, aggregate goal.InitialAggregate) error {
	rows, err := tx.InsertInitialGoal(ctx, aggregate.Goal)
	if err != nil {
		return err
	}
	if err = requireRows("insert initial Goal", rows, 1); err != nil {
		return err
	}
	rows, err = tx.InsertInitialVersion(ctx, aggregate.Version)
	if err != nil {
		return err
	}
	if err = requireRows("insert initial Goal Version", rows, 1); err != nil {
		return err
	}
	rows, err = tx.TryInsertInitialCycleClaim(ctx, aggregate.Cycle)
	if err != nil {
		return err
	}
	if rows == 0 {
		return classifyLostInitialCycleClaim(ctx, tx, aggregate)
	}
	return requireRows("insert initial Cycle claim", rows, 1)
}

func classifyLostInitialCycleClaim(ctx context.Context, tx GoalDraftTx, aggregate goal.InitialAggregate) error {
	replay, err := tx.FindStartReplay(ctx, aggregate.Cycle.UserID, aggregate.Cycle.StartOperationID)
	if err != nil {
		return err
	}
	if replay == nil {
		return invariantError("initial Cycle claim affected no row without a competing receipt")
	}
	if replay.GoalID != aggregate.Goal.ID || replay.CycleID != aggregate.Cycle.ID ||
		replay.RequestHash != aggregate.Cycle.StartRequestHash {
		return ErrIdempotencyKeyReused
	}
	return invariantError("matching Start Goal receipt appeared while its User lock was held")
}

func lockGoalRefineDraft(ctx context.Context, tx GoalDraftTx, userID, draftID, goalID string) (goal.Draft, error) {
	if draftID != "" {
		return tx.LockDraftByID(ctx, userID, draftID)
	}
	if goalID != "" {
		return tx.LockReviewDraftByGoal(ctx, userID, goalID)
	}
	return goal.Draft{}, ErrNotFound
}

func validateGoalRefineDraftTarget(draft goal.Draft, goalID string) error {
	if goalID == "" {
		if draft.Type != goal.DraftCreation || draft.GoalID != nil {
			return ErrDraftTypeMismatch
		}
		return nil
	}
	if draft.Type != goal.DraftReview || draft.GoalID == nil || *draft.GoalID != goalID {
		return ErrDraftTypeMismatch
	}
	return nil
}

func validateGoalRefineContextSelection(candidate, selected AISnapshot) error {
	sourceChanged := selected.SourceText != candidate.SourceText
	goalChanged := selected.GoalBody != candidate.GoalBody
	if selected.GenerationID != candidate.GenerationID ||
		selected.Operation != candidate.Operation ||
		selected.TargetRevision != candidate.TargetRevision ||
		selected.SourceGoalRevision != candidate.SourceGoalRevision ||
		selected.GoalID != candidate.GoalID ||
		candidate.CurrentCycle != nil || selected.CurrentCycle != nil ||
		selected.ReplayedOutput != nil ||
		selected.ReplayedContextChanged ||
		selected.ReplayedContentRevision != 0 ||
		selected.ReplayedActionRevision != 0 ||
		!validGoalRefineSelectedText(candidate.SourceText, selected.SourceText) ||
		!validGoalRefineSelectedText(candidate.GoalBody, selected.GoalBody) ||
		selected.CurrentTruncated != (sourceChanged || goalChanged) {
		return ErrAIContextIsolation
	}
	candidateIndex := 0
	for _, selectedCycle := range selected.PastCycles {
		for candidateIndex < len(candidate.PastCycles) && candidate.PastCycles[candidateIndex] != selectedCycle {
			candidateIndex++
		}
		if candidateIndex == len(candidate.PastCycles) {
			return ErrAIContextIsolation
		}
		candidateIndex++
	}
	return assertSameGoalContext(selected)
}

func validGoalRefineSelectedText(original, selected string) bool {
	if !utf8.ValidString(selected) {
		return false
	}
	if selected == original {
		return true
	}
	if selected == "" {
		return true
	}
	if !strings.HasSuffix(selected, truncationMarker) {
		return false
	}
	prefix := strings.TrimSuffix(selected, truncationMarker)
	return len(prefix) < len(original) && strings.HasPrefix(original, prefix)
}
func replayGoalRefine(replay GoalRefineReplayState, requestHash string) (AISnapshot, error) {
	if replay.IdempotencyRequestHash != requestHash {
		return AISnapshot{}, ErrIdempotencyKeyReused
	}
	switch replay.Status {
	case aiStatusRunning:
		return AISnapshot{}, &AIOperationInProgressError{GenerationID: replay.GenerationID}
	case aiStatusFailed:
		return AISnapshot{}, goalRefineFailureError(replay.FailureCode)
	case aiStatusSucceeded:
		if replay.Output == nil {
			return AISnapshot{}, ErrAIInvalidResponse
		}
		return AISnapshot{
			GenerationID: replay.GenerationID, Operation: goalRefineOperation,
			TargetRevision: replay.TargetRevision, ReplayedOutput: replay.Output,
			ReplayedContextChanged: replay.ContextChanged,
		}, nil
	default:
		return AISnapshot{}, invariantError("unknown Goal Refine generation status")
	}
}

func goalRefineRequestHash(input GoalRefineInput) string {
	return hashRequest(struct {
		Operation             domainai.OperationType `json:"operation"`
		DraftID               string                 `json:"draftId"`
		GoalID                string                 `json:"goalId,omitempty"`
		ExpectedDraftRevision int64                  `json:"expectedDraftRevision"`
		ExpectedGoalRevision  *int64                 `json:"expectedGoalRevision,omitempty"`
	}{goalRefineOperation, input.DraftID, input.GoalID, input.ExpectedDraftRevision, input.ExpectedGoalRevision})
}

func goalRefineFailureError(code string) error {
	switch code {
	case "invalid_response":
		return ErrAIInvalidResponse
	case "provider_timeout":
		return ErrAIProviderTimeout
	case "target_deleted":
		return ErrNotFound
	case "goal_version_conflict":
		return ErrGoalVersionConflict
	case "lease_expired":
		return ErrAIProviderUnavailable
	default:
		return ErrAIProviderUnavailable
	}
}

func goalRefineFailureCode(err error) string {
	switch {
	case errors.Is(err, ErrAIInvalidResponse):
		return "invalid_response"
	case errors.Is(err, ErrAIProviderTimeout):
		return "provider_timeout"
	case errors.Is(err, ErrNotFound):
		return "target_deleted"
	case errors.Is(err, ErrGoalVersionConflict):
		return "goal_version_conflict"
	default:
		return "provider_unavailable"
	}
}

func goalDraftRateHash(key []byte, scope, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(scope))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func exceedsBudget(budget AIBudgetState, reservation, limit string) (bool, error) {
	total := new(big.Rat)
	for _, amount := range []string{budget.ReservedCostUSD, budget.ActualCostUSD, budget.UnattributedCostUSD, reservation} {
		parsed, ok := new(big.Rat).SetString(amount)
		if !ok {
			return false, invariantError("invalid exact AI budget amount")
		}
		total.Add(total, parsed)
	}
	maximum, ok := new(big.Rat).SetString(limit)
	if !ok {
		return false, invariantError("invalid exact AI budget limit")
	}
	return total.Cmp(maximum) > 0, nil
}

func decimalFromFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', 8, 64)
}

func draftView(draft goal.Draft) DraftView {
	return DraftView{
		ID: draft.ID, DraftType: string(draft.Type), GoalID: draft.GoalID,
		BaseGoalVersionID: draft.BaseGoalVersionID, ReviewCycleID: draft.ReviewCycleID,
		Body: draft.Body, Revision: draft.Revision, UpdatedAt: draft.UpdatedAt,
	}
}

func aiContextCycleIDs(cycles []AIContextCycle) []string {
	ids := make([]string, len(cycles))
	for index := range cycles {
		ids[index] = cycles[index].ID
	}
	return ids
}

func partitionDraftUsages(generationIDs []string, usages []DraftUsageState, now time.Time) ([]string, []string, error) {
	known := make(map[string]struct{}, len(generationIDs))
	for _, generationID := range generationIDs {
		known[generationID] = struct{}{}
	}
	usageIDs := make([]string, len(usages))
	seen := make(map[string]struct{}, len(usages))
	for index, usage := range usages {
		if _, ok := known[usage.OperationID]; !ok {
			return nil, nil, invariantError("Draft usage does not belong to a locked generation")
		}
		if _, duplicate := seen[usage.OperationID]; duplicate {
			return nil, nil, invariantError("Draft usage lock returned a duplicate operation")
		}
		if usage.QuotaRetainUntil.IsZero() {
			return nil, nil, invariantError("Draft usage retention deadline is missing")
		}
		seen[usage.OperationID] = struct{}{}
		usageIDs[index] = usage.OperationID
	}
	if !slices.IsSorted(usageIDs) {
		return nil, nil, invariantError("Draft usages are not locked in UUID order")
	}
	retained := make([]string, 0, len(usages))
	expired := make([]string, 0, len(usages))
	for _, usage := range usages {
		if now.Before(usage.QuotaRetainUntil) || usage.ProviderUsageFinalizedAt == nil {
			retained = append(retained, usage.OperationID)
			continue
		}
		expired = append(expired, usage.OperationID)
	}
	return retained, expired, nil
}

func requireRows(operation string, actual, expected int64) error {
	if actual == expected {
		return nil
	}
	return fmt.Errorf("%w: %s affected %d rows, want %d", ErrGoalDraftPersistenceInvariant, operation, actual, expected)
}

func invariantError(detail string) error {
	return fmt.Errorf("%w: %s", ErrGoalDraftPersistenceInvariant, detail)
}

func requireGenerationOrder(items []DraftGenerationState) error {
	ids := make([]string, len(items))
	for index := range items {
		ids[index] = items[index].ID
	}
	if !slices.IsSorted(ids) {
		return invariantError("Draft generations are not locked in UUID order")
	}
	return nil
}

func requireExpiredGenerationOrder(items []ExpiredGeneration) error {
	ids := make([]string, len(items))
	for index := range items {
		ids[index] = items[index].ID
	}
	if !slices.IsSorted(ids) {
		return invariantError("expired AI generations are not locked in UUID order")
	}
	return nil
}

func requireMonthlyReservationOrder(items []MonthlyReservation) error {
	for index := 1; index < len(items); index++ {
		if items[index].MonthUtc.Before(items[index-1].MonthUtc) {
			return invariantError("AI budget months are not locked in ascending order")
		}
	}
	return nil
}

func (useCases *GoalDraftUseCases) threeIDs() (string, string, string, error) {
	first, err := useCases.ids.NewID()
	if err != nil {
		return "", "", "", err
	}
	second, err := useCases.ids.NewID()
	if err != nil {
		return "", "", "", err
	}
	third, err := useCases.ids.NewID()
	return first, second, third, err
}
