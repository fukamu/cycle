package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type Settings struct {
	MaxProgressingGoals        int
	CursorSigningKey           []byte
	Provider                   string
	RollingLimit               int
	MonthlyBudgetUSD           float64
	ReservationUSD             float64
	ActionReservationUSD       float64
	LeaseDuration              time.Duration
	RateHashKey                []byte
	GoalStartPerUserMinute     int
	GoalStartPerSessionMinute  int
	AIPerUserMinute            int
	AIPerSessionMinute         int
	AIPerIPMinute              int
	MaxProviderAttempts        int
	MaxRetryBackoff            time.Duration
	FinalizationGrace          time.Duration
	Model                      string
	MaxInputTokens             int
	GoalRefineMaxOutputTokens  int
	ActionMaxOutputTokens      int
	MaxContextCycles           int
	GoalRefineInstructions     string
	ActionGenerateInstructions string
	ActionRefineInstructions   string
	TokenCounter               TokenCounter
	GoalPromptVersion          string
	GeneratePromptVersion      string
	RefinePromptVersion        string
	AIObserver                 AIObserver
	EventObserver              WorkspaceObserver
}

type Service struct {
	store             Store
	goalDraft         *GoalDraftUseCases
	goals             *GoalUseCases
	cycles            *CycleUseCases
	reviewTransitions *ReviewTransitionUseCases
	actionAI          *ActionAIUseCases
	entitlements      EntitlementPolicy
	goalRefiner       GoalRefiner
	actionGenerator   ActionGenerator
	clock             ports.Clock
	ids               ports.IDGenerator
	settings          Settings
}

func NewService(
	store Store,
	goalDraftUOW GoalDraftUnitOfWork,
	goalQueries GoalQueryRepository,
	goalUOW GoalUnitOfWork,
	cycleQueries CycleQueryRepository,
	cycleUOW CycleUnitOfWork,
	reviewTransitionUOW ReviewTransitionUnitOfWork,
	actionAIUOW ActionAIUnitOfWork,
	goalRefiner GoalRefiner,
	actionGenerator ActionGenerator,
	clock ports.Clock,
	ids ports.IDGenerator,
	settings Settings,
) *Service {
	entitlements := NewStaticEntitlementPolicy(Entitlements{
		MaxProgressingGoals:       settings.MaxProgressingGoals,
		MaxAIOperationsPer24Hours: settings.RollingLimit,
		MaxAIInputTokens:          settings.MaxInputTokens,
		GoalRefineOutputTokens:    settings.GoalRefineMaxOutputTokens,
		ActionOutputTokens:        settings.ActionMaxOutputTokens,
	})
	goalDraft := NewGoalDraftUseCases(goalDraftUOW, entitlements, clock, ids, GoalDraftUseCaseSettings{
		Provider: settings.Provider, Model: settings.Model, GoalPromptVersion: settings.GoalPromptVersion,
		MonthlyBudgetUSD: settings.MonthlyBudgetUSD,
		ReservationUSD:   settings.ReservationUSD, LeaseDuration: settings.LeaseDuration,
		RateHashKey:            settings.RateHashKey,
		GoalStartPerUserMinute: settings.GoalStartPerUserMinute, GoalStartPerSessionMinute: settings.GoalStartPerSessionMinute,
		AIPerUserMinute: settings.AIPerUserMinute, AIPerSessionMinute: settings.AIPerSessionMinute,
		AIPerIPMinute: settings.AIPerIPMinute,
	})
	goals := NewGoalUseCases(goalQueries, goalUOW, clock, GoalUseCaseSettings{
		CursorSigningKey: settings.CursorSigningKey,
	})
	cycles := NewCycleUseCases(cycleQueries, cycleUOW, clock, ids, CycleUseCaseSettings{
		CursorSigningKey: settings.CursorSigningKey,
	})
	reviewTransitions := NewReviewTransitionUseCases(reviewTransitionUOW, clock, ids)
	actionAI := NewActionAIUseCases(actionAIUOW, entitlements, clock, ids, ActionAIUseCaseSettings{
		Provider: settings.Provider, Model: settings.Model,
		GeneratePromptVersion: settings.GeneratePromptVersion, RefinePromptVersion: settings.RefinePromptVersion,
		MonthlyBudgetUSD: settings.MonthlyBudgetUSD, ReservationUSD: settings.ActionReservationUSD,
		LeaseDuration: settings.LeaseDuration, RateHashKey: settings.RateHashKey,
		AIPerUserMinute: settings.AIPerUserMinute, AIPerSessionMinute: settings.AIPerSessionMinute,
		AIPerIPMinute: settings.AIPerIPMinute,
	})
	return &Service{store: store, goalDraft: goalDraft, goals: goals, cycles: cycles, reviewTransitions: reviewTransitions,
		actionAI: actionAI, entitlements: entitlements, goalRefiner: goalRefiner, actionGenerator: actionGenerator,
		clock: clock, ids: ids, settings: settings}
}

func (service *Service) Home(ctx context.Context, userID string) (HomeView, error) {
	limits, err := service.entitlements.Limits(ctx, user.ID(userID))
	if err != nil {
		return HomeView{}, err
	}
	view, err := service.store.Home(ctx, userID, limits.MaxProgressingGoals)
	if err == nil && len(view.ProgressingGoals) > limits.MaxProgressingGoals {
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricProgressingGoalLimitInvariantViolation})
	}
	return view, err
}

func (service *Service) CreateDraft(ctx context.Context, userID, body string) (DraftView, error) {
	view, err := service.goalDraft.CreateDraft(ctx, userID, body)
	if err == nil {
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricGoalCreationDraftCreated})
	}
	return view, err
}

func (service *Service) GetDraft(ctx context.Context, userID, draftID string) (DraftView, error) {
	view, err := service.store.GetDraft(ctx, userID, draftID)
	return view, resourceNotFound(err, ErrGoalDraftNotFound)
}

func (service *Service) SaveDraft(ctx context.Context, userID, draftID, body string, expectedRevision int64) (DraftView, error) {
	view, err := service.goalDraft.SaveDraft(ctx, userID, draftID, body, expectedRevision)
	return view, resourceNotFound(err, ErrGoalDraftNotFound)
}

func (service *Service) AbandonDraft(ctx context.Context, userID, draftID string) error {
	return resourceNotFound(service.goalDraft.AbandonDraft(ctx, userID, draftID), ErrGoalDraftNotFound)
}

func (service *Service) StartGoal(ctx context.Context, userID, sessionID, draftID, operationID string, expectedDraftRevision int64) (StartGoalResult, error) {
	result, err := service.goalDraft.StartGoal(ctx, userID, sessionID, draftID, operationID, expectedDraftRevision)
	if errors.Is(err, ports.ErrRateLimitExceeded) {
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricRateLimitRejected, Scope: "goal_start"})
	}
	if errors.Is(err, ErrGoalActiveLimit) {
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricProgressingGoalLimitRejected})
	}
	if errors.Is(err, ErrProgressingGoalLimitInvariant) {
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricProgressingGoalLimitInvariantViolation})
	}
	if err == nil && !result.Replayed {
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricGoalStarted})
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricGoalVersionCreated})
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricCycleStarted})
	}
	return result, resourceNotFound(err, ErrGoalDraftNotFound)
}

func (service *Service) ListGoals(ctx context.Context, userID, scope, cursor string, limit int) (GoalPage, error) {
	return service.goals.ListGoals(ctx, userID, scope, cursor, limit)
}

func (service *Service) GetGoal(ctx context.Context, userID, goalID string) (GoalView, error) {
	view, err := service.goals.GetGoal(ctx, userID, goalID)
	return view, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) GetReview(ctx context.Context, userID, goalID string) (ReviewView, error) {
	view, err := service.store.GetReview(ctx, userID, goalID)
	return view, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) SaveReview(ctx context.Context, userID, goalID, expectedReviewDraftID, body string, expectedRevision int64) (DraftView, error) {
	view, err := service.goalDraft.SaveReview(ctx, userID, goalID, expectedReviewDraftID, body, expectedRevision)
	return view, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) ContinueReview(ctx context.Context, userID, goalID, operationID string, expectedGoalRevision, expectedDraftRevision int64) (ContinueReviewResult, error) {
	result, err := service.reviewTransitions.ContinueReview(ctx, ContinueReviewInput{
		UserID: userID, GoalID: goalID, OperationID: operationID,
		ExpectedGoalRevision: expectedGoalRevision, ExpectedDraftRevision: expectedDraftRevision,
	})
	if err == nil && !result.Replayed {
		service.observeWorkspace(ctx, WorkspaceObservation{
			Event: WorkspaceMetricGoalReviewContinued, VersionChanged: result.VersionCreated,
		})
		if result.VersionCreated {
			service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricGoalVersionCreated})
		}
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricCycleStarted})
	}
	return result, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) Terminate(ctx context.Context, input TerminateInput) (TerminateResult, error) {
	result, err := service.reviewTransitions.Terminate(ctx, input)
	if err == nil && !result.Replayed {
		service.observeWorkspace(ctx, WorkspaceObservation{
			Event: WorkspaceMetricGoalTerminal, Outcome: input.Outcome, SourceState: input.ExpectedState,
		})
		if result.CanceledCycle != nil && result.CanceledCycle.CancellationReason != nil {
			service.observeWorkspace(ctx, WorkspaceObservation{
				Event: WorkspaceMetricCycleCanceled, CancellationReason: *result.CanceledCycle.CancellationReason,
			})
		}
	}
	return result, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) DeleteGoal(ctx context.Context, userID, goalID string, confirmed bool, expectedRevision int64, idempotencyKey string) error {
	result, err := service.goals.DeleteGoalWithResult(
		ctx, userID, goalID, confirmed, expectedRevision, idempotencyKey,
	)
	if confirmed {
		metricResult := "failure"
		if err == nil {
			metricResult = "success"
			if result.Replayed {
				metricResult = "idempotent"
			}
		}
		service.observeWorkspace(ctx, WorkspaceObservation{
			Event: WorkspaceMetricGoalDeleted, SourceState: result.SourceState, Result: metricResult,
		})
	}
	return resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) ListCycles(ctx context.Context, userID, goalID, cursor string, limit int) (CyclePage, error) {
	page, err := service.cycles.ListCycles(ctx, userID, goalID, cursor, limit)
	return page, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) GetCycle(ctx context.Context, userID, goalID, cycleID string) (CycleView, error) {
	view, err := service.cycles.GetCycle(ctx, userID, goalID, cycleID)
	return view, resourceNotFound(err, ErrCycleNotFound)
}

func (service *Service) SaveFrame(ctx context.Context, input SaveFrameInput) (SaveFrameResult, error) {
	result, err := service.cycles.SaveFrame(ctx, input)
	return result, resourceNotFound(err, ErrCycleNotFound)
}

func (service *Service) CompleteCycle(ctx context.Context, input CompleteCycleInput) (CompleteCycleResult, error) {
	result, err := service.cycles.CompleteCycle(ctx, input)
	if err == nil && !result.Replayed && result.Replay == nil {
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricCycleCompleted})
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricGoalReviewOpened})
	}
	return result, resourceNotFound(err, ErrCycleNotFound)
}

func (service *Service) RefineGoal(ctx context.Context, input GoalRefineInput) (AIResponse, error) {
	generationID, err := service.ids.NewID()
	if err != nil {
		return AIResponse{}, err
	}
	input.GenerationID = generationID
	input.Now = service.clock.Now().UTC()
	snapshot, err := service.goalDraft.BeginGoalRefine(ctx, input, service.selectAIContextForUser(input.UserID))
	if err != nil {
		service.observeAIRejection(ctx, err)
		missing := ErrGoalDraftNotFound
		if input.GoalID != "" {
			missing = ErrGoalNotFound
		}
		return AIResponse{}, specificAIInputError(domainai.OperationGoalRefine, resourceNotFound(err, missing))
	}
	ctx = ports.WithAIGenerationCorrelation(ctx, snapshot.GenerationID, string(snapshot.Operation))
	if snapshot.ReplayedOutput != nil {
		sourceDraftRevision := snapshot.TargetRevision
		sourceGoalRevision := int64(0)
		if input.ExpectedGoalRevision != nil {
			sourceGoalRevision = *input.ExpectedGoalRevision
		}
		return AIResponse{
			GenerationID: snapshot.GenerationID, SourceDraftRevision: &sourceDraftRevision,
			SourceGoalRevision: sourceGoalRevision, Suggestion: *snapshot.ReplayedOutput,
			ContextChanged: snapshot.ReplayedContextChanged, Replayed: true,
		}, nil
	}
	startedAt := service.clock.Now()
	result, providerErr := service.executeAI(ctx, &snapshot)
	providerDuration := service.clock.Now().Sub(startedAt)
	finishContext, cancel := service.finalizationContext(ctx)
	defer cancel()
	response, finishErr := service.goalDraft.FinishGoalRefine(finishContext, snapshot, result, providerErr, service.clock.Now().UTC())
	service.observeAI(ctx, snapshot, result, response, providerErr, finishErr, providerDuration, startedAt)
	missing := ErrGoalDraftNotFound
	if input.GoalID != "" {
		missing = ErrGoalNotFound
	}
	return response, specificAIInputError(domainai.OperationGoalRefine, resourceNotFound(finishErr, missing))
}

func (service *Service) AdoptGoalSuggestion(ctx context.Context, userID, draftID, goalID, generationID string, expectedDraftRevision int64, expectedGoalRevision *int64) (DraftView, error) {
	view, err := service.goalDraft.AdoptGoalSuggestion(ctx, userID, draftID, goalID, generationID, expectedDraftRevision, expectedGoalRevision)
	if err == nil && !view.Replayed {
		source := "creation"
		if goalID != "" {
			source = "review"
		}
		service.observeWorkspace(ctx, WorkspaceObservation{
			Event: WorkspaceMetricAISuggestionAdopted, SuggestionSource: source,
		})
	}
	missing := ErrGoalDraftNotFound
	if goalID != "" {
		missing = ErrGoalNotFound
	}
	return view, resourceNotFound(err, missing)
}

func (service *Service) GenerateAction(ctx context.Context, input ActionGenerateInput) (AIResponse, error) {
	generationID, err := service.ids.NewID()
	if err != nil {
		return AIResponse{}, err
	}
	input.GenerationID = generationID
	input.Now = service.clock.Now().UTC()
	return service.runActionAI(ctx, input.UserID, domainai.OperationActionGenerate, func(selector AIContextSelector) (AISnapshot, error) {
		return service.actionAI.BeginGenerate(ctx, input, selector)
	})
}

func (service *Service) RefineAction(ctx context.Context, input ActionRefineInput) (AIResponse, error) {
	generationID, err := service.ids.NewID()
	if err != nil {
		return AIResponse{}, err
	}
	input.GenerationID = generationID
	input.Now = service.clock.Now().UTC()
	return service.runActionAI(ctx, input.UserID, domainai.OperationActionRefine, func(selector AIContextSelector) (AISnapshot, error) {
		return service.actionAI.BeginRefine(ctx, input, selector)
	})
}

type actionAIBegin func(AIContextSelector) (AISnapshot, error)

func (service *Service) runActionAI(
	ctx context.Context,
	userID string,
	operation domainai.OperationType,
	begin actionAIBegin,
) (AIResponse, error) {
	snapshot, err := begin(service.selectAIContextForUser(userID))
	if err != nil {
		service.observeAIRejection(ctx, err)
		return AIResponse{}, specificAIInputError(operation, resourceNotFound(err, ErrCycleNotFound))
	}
	ctx = ports.WithAIGenerationCorrelation(ctx, snapshot.GenerationID, string(snapshot.Operation))
	if snapshot.ReplayedOutput != nil {
		return AIResponse{
			GenerationID: snapshot.GenerationID, Action: *snapshot.ReplayedOutput,
			ContentRevision: snapshot.ReplayedContentRevision, ActionRevision: snapshot.ReplayedActionRevision,
			ContextChanged: snapshot.ReplayedContextChanged, Replayed: true,
		}, nil
	}
	startedAt := service.clock.Now()
	result, providerErr := service.executeAI(ctx, &snapshot)
	providerDuration := service.clock.Now().Sub(startedAt)
	finishContext, cancel := service.finalizationContext(ctx)
	defer cancel()
	response, finishErr := service.actionAI.Finish(finishContext, snapshot, result, providerErr, service.clock.Now().UTC())
	service.observeAI(ctx, snapshot, result, response, providerErr, finishErr, providerDuration, startedAt)
	return response, specificAIInputError(operation, resourceNotFound(finishErr, ErrCycleNotFound))
}

type aiProviderAttempt func(context.Context, bool) (string, AIUsage, error)

const invalidResponseRetryInstruction = "\nThe previous response was invalid. Follow the JSON Schema exactly and stay within the stated character limit."

func (service *Service) executeAI(ctx context.Context, snapshot *AISnapshot) (AIExecutionResult, error) {
	if snapshot.MaxOutputTokens <= 0 {
		return AIExecutionResult{}, ErrAIInputBudget
	}
	if err := service.verifyCanonicalProviderInputHash(snapshot); err != nil {
		return AIExecutionResult{}, err
	}
	ctx = ports.WithAIGenerationCorrelation(ctx, snapshot.GenerationID, string(snapshot.Operation))

	var attempt aiProviderAttempt
	switch snapshot.Operation {
	case domainai.OperationGoalRefine:
		if service.goalRefiner == nil {
			return AIExecutionResult{}, ErrAIProviderUnavailable
		}
		input := service.refineGoalAIInput(*snapshot)
		attempt = func(ctx context.Context, validationRetry bool) (string, AIUsage, error) {
			request := input
			if validationRetry {
				request.Instructions += invalidResponseRetryInstruction
			}
			raw, usage, err := service.goalRefiner.RefineGoal(ctx, request)
			if err != nil {
				return "", usage, err
			}
			output, validationErr := domainai.ValidateGoalSuggestion(raw.Suggestion)
			if validationErr != nil {
				return "", usage, ErrAIInvalidResponse
			}
			return output, usage, nil
		}
	case domainai.OperationActionGenerate:
		if service.actionGenerator == nil {
			return AIExecutionResult{}, ErrAIProviderUnavailable
		}
		input := service.generateActionAIInput(*snapshot)
		attempt = func(ctx context.Context, validationRetry bool) (string, AIUsage, error) {
			request := input
			if validationRetry {
				request.Instructions += invalidResponseRetryInstruction
			}
			raw, usage, err := service.actionGenerator.GenerateAction(ctx, request)
			if err != nil {
				return "", usage, err
			}
			output, validationErr := domainai.RenderGeneratedActions(raw.Actions)
			if validationErr != nil {
				return "", usage, ErrAIInvalidResponse
			}
			return output, usage, nil
		}
	case domainai.OperationActionRefine:
		if service.actionGenerator == nil {
			return AIExecutionResult{}, ErrAIProviderUnavailable
		}
		input := service.refineActionAIInput(*snapshot)
		attempt = func(ctx context.Context, validationRetry bool) (string, AIUsage, error) {
			request := input
			if validationRetry {
				request.Instructions += invalidResponseRetryInstruction
			}
			raw, usage, err := service.actionGenerator.RefineAction(ctx, request)
			if err != nil {
				return "", usage, err
			}
			output, validationErr := domainai.ValidateRefinedAction(raw.RefinedAction)
			if validationErr != nil {
				return "", usage, ErrAIInvalidResponse
			}
			return output, usage, nil
		}
	default:
		return AIExecutionResult{}, ErrAIInputBudget
	}
	return service.executeAIAttempts(ctx, snapshot.Operation, attempt)
}

func (service *Service) executeAIAttempts(
	ctx context.Context,
	operation domainai.OperationType,
	execute aiProviderAttempt,
) (AIExecutionResult, error) {
	attemptLimit := service.settings.MaxProviderAttempts
	if attemptLimit < 1 {
		attemptLimit = 1
	}
	var result AIExecutionResult
	var finalErr error
	validationRetry := false
	for attempt := 1; attempt <= attemptLimit; attempt++ {
		output, usage, err := execute(ctx, validationRetry)
		service.observeWorkspace(ctx, WorkspaceObservation{
			Event: WorkspaceMetricAIProviderAttempt, Operation: operation, Result: aiProviderAttemptResult(err),
		})
		result.Output = output
		result.Usage.InputTokens += usage.InputTokens
		result.Usage.OutputTokens += usage.OutputTokens
		result.Usage.CostUSD += usage.CostUSD
		if usage.ProviderRequestID != "" {
			result.Usage.ProviderRequestID = usage.ProviderRequestID
		}
		result.Attempts = int16(attempt)
		finalErr = err
		if finalErr == nil {
			return result, nil
		}
		if !errors.Is(finalErr, ErrAIInvalidResponse) && !errors.Is(finalErr, ErrAIProviderUnavailable) {
			break
		}
		validationRetry = errors.Is(finalErr, ErrAIInvalidResponse)
		if attempt < attemptLimit {
			if cancellationErr := ctx.Err(); cancellationErr != nil {
				return result, cancellationErr
			}
			delay := min(time.Duration(1<<(attempt-1))*250*time.Millisecond, service.settings.MaxRetryBackoff)
			if delay > 0 {
				select {
				case <-ctx.Done():
					return result, ctx.Err()
				case <-time.After(delay):
				}
			}
		}
	}
	return result, finalErr
}

func (service *Service) finalizationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	grace := service.settings.FinalizationGrace
	if grace <= 0 {
		grace = 15 * time.Second
	}
	return context.WithTimeout(context.WithoutCancel(ctx), grace)
}

func (service *Service) observeAI(
	ctx context.Context,
	snapshot AISnapshot,
	result AIExecutionResult,
	response AIResponse,
	providerErr, finishErr error,
	providerDuration time.Duration,
	startedAt time.Time,
) {
	if response.SettlementPath != "" {
		service.observeWorkspace(ctx, WorkspaceObservation{
			Event:          WorkspaceMetricAICostSettlement,
			SettlementPath: response.SettlementPath, Result: response.SettlementResult,
		})
	}
	if service.settings.AIObserver == nil {
		return
	}
	resultLabel := "success"
	if providerErr != nil || finishErr != nil {
		resultLabel = "failure"
	}
	operationSettings, _ := service.aiOperationSettings(snapshot.Operation)
	service.settings.AIObserver.ObserveAI(context.WithoutCancel(ctx), AIObservation{
		GenerationID: snapshot.GenerationID, Operation: snapshot.Operation,
		Result: resultLabel, Model: service.settings.Model,
		PromptVersion: operationSettings.promptVersion, InputTokens: result.Usage.InputTokens,
		OutputTokens: result.Usage.OutputTokens, EstimatedCostUSD: result.Usage.CostUSD,
		ContextCycleCount: len(snapshot.PastCycles), CurrentTruncated: snapshot.CurrentTruncated,
		ContextChanged: response.ContextChanged, ProviderDuration: providerDuration,
		Duration: service.clock.Now().Sub(startedAt),
	})
}

func (service *Service) observeWorkspace(ctx context.Context, event WorkspaceObservation) {
	if service.settings.EventObserver != nil {
		service.settings.EventObserver.ObserveWorkspace(context.WithoutCancel(ctx), event)
	}
}

func (service *Service) observeAIRejection(ctx context.Context, err error) {
	switch {
	case errors.Is(err, ErrAIUserLimit):
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricAIQuotaRejected})
	case errors.Is(err, ErrAIBudget):
		service.observeWorkspace(ctx, WorkspaceObservation{Event: WorkspaceMetricAIBudgetRejected})
	case errors.Is(err, ErrAIRateLimit):
		service.observeWorkspace(ctx, WorkspaceObservation{
			Event: WorkspaceMetricRateLimitRejected, Scope: "ai",
		})
	}
}

func aiProviderAttemptResult(err error) string {
	switch {
	case err == nil:
		return "success"
	case errors.Is(err, ErrAIInvalidResponse):
		return "invalid_response"
	case errors.Is(err, ErrAIProviderTimeout):
		return "timeout"
	case errors.Is(err, ErrAIProviderUnavailable):
		return "unavailable"
	case errors.Is(err, ErrAIProviderRejected):
		return "rejected"
	default:
		return "failure"
	}
}

func hashRequest(value any) string {
	encoded, _ := json.Marshal(value)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func resourceNotFound(err, replacement error) error {
	if errors.Is(err, ErrNotFound) {
		return replacement
	}
	return err
}

func specificAIInputError(operation domainai.OperationType, err error) error {
	if !errors.Is(err, ErrAIInputIncomplete) {
		return err
	}
	switch operation {
	case domainai.OperationGoalRefine:
		return ErrGoalRefineInputEmpty
	case domainai.OperationActionGenerate:
		return ErrActionGenerateInputIncomplete
	case domainai.OperationActionRefine:
		return ErrActionRefineInputIncomplete
	default:
		return err
	}
}
