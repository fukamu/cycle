package workspace

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

const actionAIContextSize = 10

var ErrActionAIPersistenceInvariant = errors.New("Action AI persistence invariant violated")

type ActionAIUseCases struct {
	uow          ActionAIUnitOfWork
	entitlements EntitlementPolicy
	clock        ports.Clock
	ids          ports.IDGenerator
	settings     ActionAIUseCaseSettings
}

func NewActionAIUseCases(
	uow ActionAIUnitOfWork,
	entitlements EntitlementPolicy,
	clock ports.Clock,
	ids ports.IDGenerator,
	settings ActionAIUseCaseSettings,
) *ActionAIUseCases {
	return &ActionAIUseCases{uow: uow, entitlements: entitlements, clock: clock, ids: ids, settings: settings}
}

func (useCases *ActionAIUseCases) BeginGenerate(
	ctx context.Context,
	input ActionGenerateInput,
	selectContext AIContextSelector,
) (AISnapshot, error) {
	return useCases.begin(ctx, actionAIInput{
		UserID: input.UserID, GoalID: input.GoalID, CycleID: input.CycleID,
		Operation: domainai.OperationActionGenerate, ExpectedContentRevision: input.ExpectedContentRevision,
		ConfirmReplace: input.ConfirmReplace, IdempotencyKey: input.IdempotencyKey,
		GenerationID: input.GenerationID, RemoteAddress: input.RemoteAddress, SessionID: input.SessionID, Now: input.Now,
	}, selectContext)
}

func (useCases *ActionAIUseCases) BeginRefine(
	ctx context.Context,
	input ActionRefineInput,
	selectContext AIContextSelector,
) (AISnapshot, error) {
	return useCases.begin(ctx, actionAIInput{
		UserID: input.UserID, GoalID: input.GoalID, CycleID: input.CycleID,
		Operation: domainai.OperationActionRefine, ExpectedContentRevision: input.ExpectedContentRevision,
		IdempotencyKey: input.IdempotencyKey, GenerationID: input.GenerationID,
		RemoteAddress: input.RemoteAddress, SessionID: input.SessionID, Now: input.Now,
	}, selectContext)
}

func (useCases *ActionAIUseCases) begin(
	ctx context.Context,
	input actionAIInput,
	selectContext AIContextSelector,
) (snapshot AISnapshot, err error) {
	if input.Operation != domainai.OperationActionGenerate && input.Operation != domainai.OperationActionRefine {
		return snapshot, ErrAIInputIncomplete
	}
	if input.Now.IsZero() {
		input.Now = useCases.clock.Now().UTC()
	} else {
		input.Now = input.Now.UTC()
	}
	requestHash := actionAIRequestHash(input)
	var replayOutcomeErr error
	err = useCases.uow.WithinActionAITransaction(ctx, func(tx ActionAITx) error {
		if lockErr := tx.LockUser(ctx, input.UserID); lockErr != nil {
			return lockErr
		}
		replay, replayErr := tx.FindActionAIReplay(ctx, input.UserID, input.Operation, input.IdempotencyKey)
		if replayErr != nil {
			return replayErr
		}
		correlationGenerationID := input.GenerationID
		if replay != nil {
			correlationGenerationID = replay.GenerationID
		}
		if correlationGenerationID != "" {
			ctx = ports.WithAIGenerationCorrelation(ctx, correlationGenerationID, string(input.Operation))
		}
		if replay != nil {
			confirmedReplay, confirmErr := tx.FindActionAIReplay(ctx, input.UserID, input.Operation, input.IdempotencyKey)
			if confirmErr != nil {
				return confirmErr
			}
			if confirmedReplay == nil || confirmedReplay.GenerationID != replay.GenerationID {
				return actionAIInvariantError("Action AI replay changed while user locked")
			}
			replay = confirmedReplay
			if replay.IdempotencyRequestHash != requestHash || replay.GoalID != input.GoalID || replay.CycleID != input.CycleID ||
				replay.TargetRevision != input.ExpectedContentRevision {
				return ErrIdempotencyKeyReused
			}
			if replay.Status == aiStatusRunning && replay.LeaseExpiresAt != nil && !replay.LeaseExpiresAt.After(input.Now) {
				if _, lockErr := tx.LockGoalWithCurrentVersion(ctx, input.UserID, input.GoalID); lockErr != nil {
					return lockErr
				}
				if _, lockErr := tx.LockActionCycle(ctx, input.UserID, input.GoalID, input.CycleID); lockErr != nil {
					return lockErr
				}
				if recoveryErr := recoverExpiredActionAI(ctx, tx, input.UserID, input.Now); recoveryErr != nil {
					return recoveryErr
				}
				replay, replayErr = tx.FindActionAIReplay(ctx, input.UserID, input.Operation, input.IdempotencyKey)
				if replayErr != nil {
					return replayErr
				}
				if replay == nil || replay.Status != aiStatusFailed || replay.FailureCode != "lease_expired" {
					return actionAIInvariantError("expired Action AI replay was not terminal after recovery")
				}
			}
			snapshot, replayOutcomeErr = replayActionAI(ctx, tx, input, *replay)
			return nil
		}

		target, lockErr := tx.LockGoalWithCurrentVersion(ctx, input.UserID, input.GoalID)
		if lockErr != nil {
			return lockErr
		}
		current, lockErr := tx.LockActionCycle(ctx, input.UserID, input.GoalID, input.CycleID)
		if lockErr != nil {
			return lockErr
		}
		if target.Status != goal.StatusActiveCycle {
			return ErrGoalStateConflict
		}
		if current.Status != cycle.StatusActive {
			return cycle.ErrCycleNotActive
		}
		if recoveryErr := recoverExpiredActionAI(ctx, tx, input.UserID, input.Now); recoveryErr != nil {
			return recoveryErr
		}
		if current.GoalVersionID != target.CurrentVersionID {
			return ErrGoalVersionConflict
		}
		if current.Revisions.Content != input.ExpectedContentRevision {
			return cycle.ErrRevisionConflict
		}
		if cycle.IsBlank(current.Plan) || cycle.IsBlank(current.Do) || cycle.IsBlank(current.Check) {
			return ErrAIInputIncomplete
		}
		if input.Operation == domainai.OperationActionRefine && cycle.IsBlank(current.Action) {
			return ErrAIInputIncomplete
		}
		if input.Operation == domainai.OperationActionGenerate && !cycle.IsBlank(current.Action) && !input.ConfirmReplace {
			return ErrAIReplacementRequired
		}
		past, contextErr := tx.ListAIContextCycles(ctx, input.UserID, input.GoalID, input.CycleID, actionAIContextSize)
		if contextErr != nil {
			return contextErr
		}
		currentContext := &AIContextCycle{
			ID: current.ID, GoalID: current.GoalID, SequenceNumber: current.SequenceNumber, Status: current.Status,
			GoalBody: target.Body, Plan: current.Plan, Do: current.Do, Check: current.Check, Action: current.Action,
		}
		snapshot = AISnapshot{
			Operation: input.Operation, TargetRevision: current.Revisions.Content, SourceGoalRevision: target.Revision,
			GoalID: input.GoalID, GoalBody: target.Body, CurrentCycle: currentContext, PastCycles: past,
		}
		if input.Operation == domainai.OperationActionRefine {
			snapshot.SourceText = current.Action
		}
		if isolationErr := assertSameGoalContext(snapshot); isolationErr != nil {
			return isolationErr
		}
		if selectContext == nil {
			return ErrAIInputBudget
		}
		candidate := cloneAISnapshot(snapshot)
		snapshot, contextErr = selectContext(ctx, cloneAISnapshot(candidate))
		if contextErr != nil {
			return contextErr
		}
		if isolationErr := validateActionAIContextSelection(candidate, snapshot); isolationErr != nil {
			return isolationErr
		}
		if snapshot.CanonicalProviderInputHash == "" {
			return actionAIInvariantError("Action AI canonical provider input hash is missing")
		}
		running, runningErr := tx.HasRunningCycleGeneration(ctx, input.UserID, input.GoalID, input.CycleID)
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
		if rateErr := useCases.checkRateLimits(ctx, tx, input); rateErr != nil {
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
		if reserveErr = requireActionAIRows("reserve Action AI budget", rows, 1); reserveErr != nil {
			return reserveErr
		}
		if input.GenerationID == "" {
			input.GenerationID, reserveErr = useCases.ids.NewID()
			if reserveErr != nil {
				return reserveErr
			}
			ctx = ports.WithAIGenerationCorrelation(ctx, input.GenerationID, string(input.Operation))
		}
		snapshot.GenerationID = input.GenerationID
		promptVersion := useCases.promptVersion(input.Operation)
		var sourceText *string
		if input.Operation == domainai.OperationActionRefine {
			source := current.Action
			sourceText = &source
		}
		rows, reserveErr = tx.InsertActionAIGeneration(ctx, ActionAIGenerationRecord{
			ID: input.GenerationID, UserID: input.UserID, Operation: input.Operation,
			GoalID: input.GoalID, GoalVersionID: target.CurrentVersionID, CycleID: input.CycleID,
			TargetRevision: current.Revisions.Content, IdempotencyKey: input.IdempotencyKey,
			IdempotencyRequestHash: requestHash, CanonicalProviderInputHash: snapshot.CanonicalProviderInputHash,
			SourceText: sourceText, Provider: useCases.settings.Provider,
			Model: useCases.settings.Model, PromptVersion: promptVersion, BudgetMonthUtc: month,
			ReservedCostUSD: reservation, LeaseExpiresAt: input.Now.Add(useCases.settings.LeaseDuration),
			StartedAt: input.Now, ContextCycleIDs: aiContextCycleIDs(snapshot.PastCycles),
		})
		if reserveErr != nil {
			return reserveErr
		}
		if reserveErr = requireActionAIRows("insert Action AI generation", rows, 1); reserveErr != nil {
			return reserveErr
		}
		rows, reserveErr = tx.InsertAcceptedUsage(ctx, AIUsageRecord{
			OperationID: input.GenerationID, UserID: input.UserID, GoalID: input.GoalID,
			Operation: input.Operation, Provider: useCases.settings.Provider, Model: useCases.settings.Model,
			PromptVersion: promptVersion, AcceptedAt: input.Now, QuotaRetainUntil: AIUsageQuotaRetainUntil(input.Now),
			SettlementBudgetMonthUtc: month, SettlementReservationCostUSD: reservation,
		})
		if reserveErr != nil {
			return reserveErr
		}
		return requireActionAIRows("insert Action AI usage", rows, 1)
	})
	if err != nil {
		return AISnapshot{}, err
	}
	return snapshot, replayOutcomeErr
}

func replayActionAI(
	ctx context.Context,
	tx ActionAITx,
	input actionAIInput,
	replay ActionAIReplayState,
) (AISnapshot, error) {
	switch replay.Status {
	case aiStatusRunning:
		return AISnapshot{}, &AIOperationInProgressError{GenerationID: replay.GenerationID}
	case aiStatusFailed:
		return AISnapshot{}, actionAIFailureError(replay.FailureCode)
	case aiStatusSucceeded:
		if replay.Output == nil {
			return AISnapshot{}, ErrAIInvalidResponse
		}
		if _, err := tx.LockGoalWithCurrentVersion(ctx, input.UserID, input.GoalID); err != nil {
			return AISnapshot{}, err
		}
		current, err := tx.LockActionCycle(ctx, input.UserID, input.GoalID, input.CycleID)
		if err != nil {
			return AISnapshot{}, err
		}
		return AISnapshot{
			GenerationID: replay.GenerationID, Operation: input.Operation, TargetRevision: replay.TargetRevision,
			ReplayedOutput: replay.Output, ReplayedContextChanged: replay.ContextChanged,
			ReplayedContentRevision: current.Revisions.Content, ReplayedActionRevision: current.Revisions.Action,
		}, nil
	default:
		return AISnapshot{}, actionAIInvariantError("unknown Action AI generation status")
	}
}

func (useCases *ActionAIUseCases) Finish(
	ctx context.Context,
	snapshot AISnapshot,
	result AIExecutionResult,
	providerErr error,
	now time.Time,
) (response AIResponse, err error) {
	now = now.UTC()
	var finishErr error
	settleLate := func(ctx context.Context, tx ActionAITx, knownUserID string, userLocked bool) error {
		response.SettlementPath = "late"
		response.SettlementResult = "failure"
		settled, settleErr := settleLateActionAIUsage(
			ctx, tx, snapshot.GenerationID, knownUserID, userLocked, result, providerErr, now,
		)
		if settleErr == nil {
			response.SettlementResult = "idempotent"
			if settled {
				response.SettlementResult = "success"
			}
		}
		return settleErr
	}
	err = useCases.uow.WithinActionAITransaction(ctx, func(tx ActionAITx) error {
		locator, locateErr := tx.FindGenerationLocator(ctx, snapshot.GenerationID)
		if locateErr != nil {
			return locateErr
		}
		if locator == nil {
			if settleErr := settleLate(ctx, tx, "", false); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if (locator.Operation != domainai.OperationActionGenerate && locator.Operation != domainai.OperationActionRefine) ||
			locator.Operation != snapshot.Operation {
			return actionAIInvariantError("Action AI generation operation changed")
		}
		if locator.Status != aiStatusRunning {
			if settleErr := settleLate(ctx, tx, "", false); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if lockErr := tx.LockUser(ctx, locator.UserID); lockErr != nil {
			return lockErr
		}
		target, lockErr := tx.LockGoalWithCurrentVersion(ctx, locator.UserID, locator.GoalID)
		if errors.Is(lockErr, ErrNotFound) {
			if settleErr := settleLate(ctx, tx, locator.UserID, true); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if lockErr != nil {
			return lockErr
		}
		current, lockErr := tx.LockActionCycle(ctx, locator.UserID, locator.GoalID, locator.CycleID)
		if errors.Is(lockErr, ErrNotFound) {
			if settleErr := settleLate(ctx, tx, locator.UserID, true); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if lockErr != nil {
			return lockErr
		}
		generation, lockErr := tx.LockActionAIGeneration(ctx, ActionAIGenerationKey{
			GenerationID: snapshot.GenerationID, UserID: locator.UserID, GoalID: locator.GoalID,
			CycleID: locator.CycleID, Operation: locator.Operation,
		})
		if errors.Is(lockErr, ErrNotFound) {
			if settleErr := settleLate(ctx, tx, locator.UserID, true); settleErr != nil {
				return settleErr
			}
			finishErr = ErrNotFound
			return nil
		}
		if lockErr != nil {
			return lockErr
		}
		if generation.TargetRevision != snapshot.TargetRevision {
			return actionAIInvariantError("Action AI generation target revision changed")
		}
		if target.Status != goal.StatusActiveCycle || current.Status != cycle.StatusActive {
			providerErr = ErrGoalStateConflict
		}
		if current.GoalVersionID != generation.GoalVersionID || target.CurrentVersionID != generation.GoalVersionID {
			providerErr = ErrGoalVersionConflict
		}
		contextChanged := current.Revisions.Content != generation.TargetRevision
		response.ContextChanged = contextChanged
		var appliedAt *time.Time
		if providerErr == nil {
			updated, applyErr := cycle.ApplyAIAction(current, result.Output, now)
			if applyErr != nil {
				return actionAIInvariantError("validated Action AI output could not be applied")
			}
			rows, applyErr := tx.ApplyActionAICAS(ctx, ActionAIApplyRecord{
				UserID: locator.UserID, GoalID: locator.GoalID, CycleID: locator.CycleID,
				GoalVersionID: generation.GoalVersionID, Action: updated.Action,
				ExpectedContentRevision: current.Revisions.Content, ExpectedActionRevision: current.Revisions.Action,
				NewContentRevision: updated.Revisions.Content, NewActionRevision: updated.Revisions.Action,
				UpdatedAt: updated.UpdatedAt,
			})
			if applyErr != nil {
				return applyErr
			}
			if applyErr = requireActionAIRows("apply Action AI output", rows, 1); applyErr != nil {
				return applyErr
			}
			current = updated
			appliedAt = &now
		}
		status := aiStatusSucceeded
		output := &result.Output
		failureCode := ""
		if providerErr != nil {
			status = aiStatusFailed
			output = nil
			failureCode = actionAIFailureCode(providerErr)
		}
		response.SettlementPath = "normal"
		response.SettlementResult = "failure"
		cost := decimalFromFloat(result.Usage.CostUSD)
		rows, settleErr := tx.TerminalizeActionAIGenerationCAS(ctx, ActionAIGenerationSettlement{
			GenerationID: snapshot.GenerationID, Operation: locator.Operation,
			ExpectedReservationUSD: generation.ReservedCostUSD, Status: status, Output: output,
			InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens,
			EstimatedCostUSD: cost, AttemptCount: result.Attempts, FailureCode: failureCode,
			ProviderRequestID: result.Usage.ProviderRequestID, ContextChanged: contextChanged,
			AppliedAt: appliedAt, FinishedAt: now,
		})
		if settleErr != nil {
			return settleErr
		}
		if settleErr = requireActionAIRows("terminalize Action AI generation", rows, 1); settleErr != nil {
			return settleErr
		}
		rows, settleErr = tx.SettleBudgetCAS(ctx, generation.BudgetMonthUtc, generation.ReservedCostUSD, cost, now)
		if settleErr != nil {
			return settleErr
		}
		if settleErr = requireActionAIRows("settle Action AI budget", rows, 1); settleErr != nil {
			return settleErr
		}
		rows, settleErr = tx.FinalizeUsageCAS(ctx, AIUsageSettlement{
			OperationID: snapshot.GenerationID, ExpectedBudgetMonthUtc: generation.BudgetMonthUtc,
			ExpectedReservationCostUSD: generation.ReservedCostUSD, Status: status,
			InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens,
			EstimatedCostUSD: cost, FinalizedAt: now,
		})
		if settleErr != nil {
			return settleErr
		}
		if settleErr = requireActionAIRows("finalize Action AI usage", rows, 1); settleErr != nil {
			return settleErr
		}
		response.SettlementResult = "success"
		if providerErr != nil {
			finishErr = providerErr
			return nil
		}
		response = AIResponse{
			GenerationID: snapshot.GenerationID, Action: result.Output,
			ContentRevision: current.Revisions.Content, ActionRevision: current.Revisions.Action,
			ContextChanged: contextChanged,
			SettlementPath: response.SettlementPath, SettlementResult: response.SettlementResult,
		}
		return nil
	})
	if err != nil {
		if response.SettlementPath != "" {
			response.SettlementResult = "failure"
		}
		return response, err
	}
	return response, finishErr
}

func recoverExpiredActionAI(ctx context.Context, tx ActionAITx, userID string, now time.Time) error {
	items, err := tx.LockExpiredGenerations(ctx, userID, now)
	if err != nil {
		return err
	}
	if err = requireActionGenerationOrder(items); err != nil {
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
	if err = requireActionReservationOrder(monthly); err != nil {
		return err
	}
	for _, reservation := range monthly {
		rows, releaseErr := tx.ReleaseBudgetReservationCAS(ctx, reservation.MonthUtc, reservation.AmountUSD, now)
		if releaseErr != nil {
			return releaseErr
		}
		if releaseErr = requireActionAIRows("release expired AI reservation", rows, 1); releaseErr != nil {
			return releaseErr
		}
	}
	for _, item := range items {
		rows, expireErr := tx.ExpireGenerationCAS(ctx, item.ID, item.ReservedCostUSD, now)
		if expireErr != nil {
			return expireErr
		}
		if expireErr = requireActionAIRows("expire AI generation", rows, 1); expireErr != nil {
			return expireErr
		}
		rows, expireErr = tx.ExpireUsageCAS(ctx, item.ID, item.BudgetMonthUtc, item.ReservedCostUSD)
		if expireErr != nil {
			return expireErr
		}
		if expireErr = requireActionAIRows("expire AI usage", rows, 1); expireErr != nil {
			return expireErr
		}
	}
	return nil
}

func (useCases *ActionAIUseCases) checkRateLimits(ctx context.Context, tx ActionAITx, input actionAIInput) error {
	checks := []struct {
		scope string
		value string
		limit int
	}{
		{scope: "ai_user_minute", value: input.UserID, limit: useCases.settings.AIPerUserMinute},
		{scope: "ai_session_minute", value: input.SessionID, limit: useCases.settings.AIPerSessionMinute},
		{scope: "ai_ip_minute", value: input.RemoteAddress, limit: useCases.settings.AIPerIPMinute},
	}
	window := input.Now.UTC().Truncate(time.Minute)
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

func settleLateActionAIUsage(
	ctx context.Context,
	tx ActionAITx,
	generationID string,
	knownUserID string,
	userLocked bool,
	result AIExecutionResult,
	providerErr error,
	now time.Time,
) (bool, error) {
	locator, err := tx.FindUsageLocator(ctx, generationID)
	if err != nil {
		return false, err
	}
	if locator == nil || locator.FinalizedAt != nil {
		return false, nil
	}
	userID := locator.UserID
	if knownUserID != "" && userID != knownUserID {
		return false, actionAIInvariantError("late AI usage owner changed")
	}
	if !userLocked {
		if err = tx.LockUser(ctx, userID); errors.Is(err, ErrNotFound) {
			return false, nil
		} else if err != nil {
			return false, err
		}
	}
	usage, err := tx.LockUsage(ctx, generationID, userID)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil || usage.FinalizedAt != nil {
		return false, err
	}
	if usage.SettlementBudgetMonthUtc.IsZero() || usage.SettlementReservationCostUSD == "" {
		return false, actionAIInvariantError("late AI usage settlement exposure is missing")
	}
	month := usage.SettlementBudgetMonthUtc
	if err = tx.EnsureBudgetMonth(ctx, month, now); err != nil {
		return false, err
	}
	cost := decimalFromFloat(result.Usage.CostUSD)
	rows, err := tx.AddLateActualCostCAS(ctx, month, cost, now)
	if err != nil {
		return false, err
	}
	if err = requireActionAIRows("add late AI actual cost", rows, 1); err != nil {
		return false, err
	}
	status := aiStatusSucceeded
	if providerErr != nil {
		status = aiStatusFailed
	}
	rows, err = tx.FinalizeLateUsageCAS(ctx, AIUsageSettlement{
		OperationID: generationID, ExpectedBudgetMonthUtc: month,
		ExpectedReservationCostUSD: usage.SettlementReservationCostUSD, Status: status,
		InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens,
		EstimatedCostUSD: cost, FinalizedAt: now,
	})
	if err != nil {
		return false, err
	}
	if err = requireActionAIRows("finalize late AI usage", rows, 1); err != nil {
		return false, err
	}
	return true, nil
}

func validateActionAIContextSelection(candidate, selected AISnapshot) error {
	if candidate.CurrentCycle == nil || selected.CurrentCycle == nil ||
		selected.GenerationID != candidate.GenerationID || selected.Operation != candidate.Operation ||
		selected.TargetRevision != candidate.TargetRevision || selected.SourceGoalRevision != candidate.SourceGoalRevision ||
		selected.GoalID != candidate.GoalID || selected.SourceText != candidate.SourceText || selected.ReplayedOutput != nil ||
		selected.ReplayedContextChanged || selected.ReplayedContentRevision != 0 || selected.ReplayedActionRevision != 0 {
		return ErrAIContextIsolation
	}
	original := candidate.CurrentCycle
	current := selected.CurrentCycle
	if current.ID != original.ID || current.GoalID != original.GoalID || current.SequenceNumber != original.SequenceNumber ||
		current.Status != original.Status || current.GoalBody != original.GoalBody ||
		!validActionSelectedText(candidate.GoalBody, selected.GoalBody) ||
		!validActionSelectedText(original.Plan, current.Plan) ||
		!validActionSelectedText(original.Do, current.Do) ||
		!validActionSelectedText(original.Check, current.Check) ||
		!validSelectedAction(candidate.Operation, original.Action, current.Action) {
		return ErrAIContextIsolation
	}
	changed := selected.GoalBody != candidate.GoalBody || current.Plan != original.Plan || current.Do != original.Do ||
		current.Check != original.Check || (candidate.Operation == domainai.OperationActionRefine && current.Action != original.Action)
	if selected.CurrentTruncated != changed {
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

func validSelectedAction(operation domainai.OperationType, original, selected string) bool {
	if operation == domainai.OperationActionGenerate && selected == "" {
		return true
	}
	return validActionSelectedText(original, selected)
}

func validActionSelectedText(original, selected string) bool {
	if !utf8.ValidString(selected) {
		return false
	}
	if selected == original || selected == "" {
		return true
	}
	if !strings.HasSuffix(selected, truncationMarker) {
		return false
	}
	prefix := strings.TrimSuffix(selected, truncationMarker)
	return len(prefix) < len(original) && strings.HasPrefix(original, prefix)
}

func actionAIRequestHash(input actionAIInput) string {
	return hashRequest(struct {
		Operation               domainai.OperationType `json:"operation"`
		GoalID                  string                 `json:"goalId"`
		CycleID                 string                 `json:"cycleId"`
		ExpectedContentRevision int64                  `json:"expectedContentRevision"`
		ConfirmReplace          bool                   `json:"confirmReplace,omitempty"`
	}{input.Operation, input.GoalID, input.CycleID, input.ExpectedContentRevision, input.ConfirmReplace})
}

func (useCases *ActionAIUseCases) promptVersion(operation domainai.OperationType) string {
	if operation == domainai.OperationActionGenerate {
		return useCases.settings.GeneratePromptVersion
	}
	return useCases.settings.RefinePromptVersion
}

func actionAIFailureError(code string) error {
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

func actionAIFailureCode(err error) string {
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

func requireActionAIRows(operation string, actual, expected int64) error {
	if actual == expected {
		return nil
	}
	return fmt.Errorf("%w: %s affected %d rows, want %d", ErrActionAIPersistenceInvariant, operation, actual, expected)
}

func actionAIInvariantError(detail string) error {
	return fmt.Errorf("%w: %s", ErrActionAIPersistenceInvariant, detail)
}

func requireActionGenerationOrder(items []ExpiredGeneration) error {
	ids := make([]string, len(items))
	for index := range items {
		ids[index] = items[index].ID
	}
	if !slices.IsSorted(ids) {
		return actionAIInvariantError("expired AI generations are not locked in UUID order")
	}
	return nil
}

func requireActionReservationOrder(items []MonthlyReservation) error {
	for index := 1; index < len(items); index++ {
		if items[index].MonthUtc.Before(items[index-1].MonthUtc) {
			return actionAIInvariantError("AI budget months are not locked in ascending order")
		}
	}
	return nil
}
