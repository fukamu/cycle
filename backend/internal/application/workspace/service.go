package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type Settings struct {
	MaxProgressingGoals        int
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
}

type Service struct {
	store    Store
	provider AIProvider
	clock    ports.Clock
	ids      ports.IDGenerator
	settings Settings
}

func NewService(store Store, provider AIProvider, clock ports.Clock, ids ports.IDGenerator, settings Settings) *Service {
	return &Service{store: store, provider: provider, clock: clock, ids: ids, settings: settings}
}

func (service *Service) Home(ctx context.Context, userID string) (HomeView, error) {
	return service.store.Home(ctx, userID, service.settings.MaxProgressingGoals)
}

func (service *Service) CreateDraft(ctx context.Context, userID, body string) (DraftView, error) {
	id, err := service.ids.NewID()
	if err != nil {
		return DraftView{}, err
	}
	return service.store.CreateDraft(ctx, userID, id, body, service.clock.Now().UTC())
}

func (service *Service) GetDraft(ctx context.Context, userID, draftID string) (DraftView, error) {
	view, err := service.store.GetDraft(ctx, userID, draftID)
	return view, resourceNotFound(err, ErrGoalDraftNotFound)
}

func (service *Service) SaveDraft(ctx context.Context, userID, draftID, body string, expectedRevision int64) (DraftView, error) {
	view, err := service.store.SaveDraft(ctx, userID, draftID, body, expectedRevision, service.clock.Now().UTC())
	return view, resourceNotFound(err, ErrGoalDraftNotFound)
}

func (service *Service) AbandonDraft(ctx context.Context, userID, draftID string) error {
	return resourceNotFound(service.store.AbandonDraft(ctx, userID, draftID, service.clock.Now().UTC()), ErrGoalDraftNotFound)
}

func (service *Service) StartGoal(ctx context.Context, userID, draftID, operationID string, expectedDraftRevision int64) (StartGoalResult, error) {
	goalID, versionID, cycleID, err := service.threeIDs()
	if err != nil {
		return StartGoalResult{}, err
	}
	requestHash := hashRequest(struct {
		DraftID  string `json:"draftId"`
		Revision int64  `json:"revision"`
	}{draftID, expectedDraftRevision})
	result, err := service.store.StartGoal(ctx, StartGoalInput{
		UserID: userID, DraftID: draftID, OperationID: operationID,
		ExpectedDraftRevision: expectedDraftRevision, RequestHash: requestHash,
		GoalID: goalID, VersionID: versionID, CycleID: cycleID, Now: service.clock.Now().UTC(),
	}, service.settings.MaxProgressingGoals)
	return result, resourceNotFound(err, ErrGoalDraftNotFound)
}

func (service *Service) ListGoals(ctx context.Context, userID, scope, cursor string, limit int) (GoalPage, error) {
	return service.store.ListGoals(ctx, userID, scope, cursor, limit)
}

func (service *Service) GetGoal(ctx context.Context, userID, goalID string) (GoalView, error) {
	view, err := service.store.GetGoal(ctx, userID, goalID)
	return view, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) GetReview(ctx context.Context, userID, goalID string) (ReviewView, error) {
	view, err := service.store.GetReview(ctx, userID, goalID)
	return view, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) SaveReview(ctx context.Context, userID, goalID, body string, expectedRevision int64) (DraftView, error) {
	view, err := service.store.SaveReview(ctx, userID, goalID, body, expectedRevision, service.clock.Now().UTC())
	return view, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) ContinueReview(ctx context.Context, userID, goalID, operationID string, expectedGoalRevision, expectedDraftRevision int64) (ContinueReviewResult, error) {
	versionID, cycleID, err := service.twoIDs()
	if err != nil {
		return ContinueReviewResult{}, err
	}
	requestHash := hashRequest(struct {
		GoalID        string `json:"goalId"`
		GoalRevision  int64  `json:"goalRevision"`
		DraftRevision int64  `json:"draftRevision"`
	}{goalID, expectedGoalRevision, expectedDraftRevision})
	result, err := service.store.ContinueReview(ctx, ContinueReviewInput{
		UserID: userID, GoalID: goalID, OperationID: operationID,
		ExpectedGoalRevision: expectedGoalRevision, ExpectedDraftRevision: expectedDraftRevision,
		RequestHash: requestHash, VersionID: versionID, CycleID: cycleID, Now: service.clock.Now().UTC(),
	})
	return result, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) Terminate(ctx context.Context, input TerminateInput) (TerminateResult, error) {
	if input.Outcome != goal.StatusAchieved && input.Outcome != goal.StatusEnded {
		return TerminateResult{}, ErrInvalidGoalOutcome
	}
	input.Now = service.clock.Now().UTC()
	input.RequestHash = hashRequest(struct {
		GoalID        string      `json:"goalId"`
		Outcome       goal.Status `json:"outcome"`
		ExpectedState goal.Status `json:"expectedState"`
		GoalRevision  int64       `json:"goalRevision"`
		CycleRevision *int64      `json:"cycleRevision"`
	}{input.GoalID, input.Outcome, input.ExpectedState, input.ExpectedGoalRevision, input.ExpectedCycleContentRevision})
	result, err := service.store.Terminate(ctx, input)
	return result, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) DeleteGoal(ctx context.Context, userID, goalID string, confirmed bool, expectedRevision int64, idempotencyKey string) error {
	return resourceNotFound(service.store.DeleteGoal(ctx, userID, goalID, confirmed, expectedRevision, idempotencyKey,
		hashRequest(struct {
			GoalID    string `json:"goalId"`
			Confirmed bool   `json:"confirmed"`
			Revision  int64  `json:"revision"`
		}{goalID, confirmed, expectedRevision}), service.clock.Now().UTC()), ErrGoalNotFound)
}

func (service *Service) ListCycles(ctx context.Context, userID, goalID, cursor string, limit int) (CyclePage, error) {
	page, err := service.store.ListCycles(ctx, userID, goalID, cursor, limit)
	return page, resourceNotFound(err, ErrGoalNotFound)
}

func (service *Service) GetCycle(ctx context.Context, userID, goalID, cycleID string) (CycleView, error) {
	view, err := service.store.GetCycle(ctx, userID, goalID, cycleID)
	return view, resourceNotFound(err, ErrCycleNotFound)
}

func (service *Service) SaveFrame(ctx context.Context, input SaveFrameInput) (SaveFrameResult, error) {
	input.Now = service.clock.Now().UTC()
	result, err := service.store.SaveFrame(ctx, input)
	return result, resourceNotFound(err, ErrCycleNotFound)
}

func (service *Service) CompleteCycle(ctx context.Context, input CompleteCycleInput) (CompleteCycleResult, error) {
	draftID, err := service.ids.NewID()
	if err != nil {
		return CompleteCycleResult{}, err
	}
	input.ReviewDraftID = draftID
	input.Now = service.clock.Now().UTC()
	input.RequestHash = hashRequest(struct {
		GoalID          string `json:"goalId"`
		CycleID         string `json:"cycleId"`
		GoalRevision    int64  `json:"goalRevision"`
		ContentRevision int64  `json:"contentRevision"`
	}{input.GoalID, input.CycleID, input.ExpectedGoalRevision, input.ExpectedContentRevision})
	result, err := service.store.CompleteCycle(ctx, input)
	return result, resourceNotFound(err, ErrCycleNotFound)
}

func (service *Service) RefineGoal(ctx context.Context, input GoalRefineInput) (AIResponse, error) {
	generationID, err := service.ids.NewID()
	if err != nil {
		return AIResponse{}, err
	}
	input.GenerationID = generationID
	input.Now = service.clock.Now().UTC()
	snapshot, err := service.store.BeginGoalRefine(ctx, input, service.selectAIContext)
	if err != nil {
		missing := ErrGoalDraftNotFound
		if input.GoalID != "" {
			missing = ErrGoalNotFound
		}
		return AIResponse{}, specificAIInputError("goal_refine", resourceNotFound(err, missing))
	}
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
	result, providerErr := service.executeProvider(ctx, snapshot)
	finishContext, cancel := service.finalizationContext(ctx)
	defer cancel()
	response, finishErr := service.store.FinishGoalRefine(finishContext, snapshot, result, providerErr, service.clock.Now().UTC())
	service.observeAI(ctx, snapshot, result, providerErr, finishErr, startedAt)
	missing := ErrGoalDraftNotFound
	if input.GoalID != "" {
		missing = ErrGoalNotFound
	}
	return response, specificAIInputError("goal_refine", resourceNotFound(finishErr, missing))
}

func (service *Service) AdoptGoalSuggestion(ctx context.Context, userID, draftID, goalID, generationID string, expectedDraftRevision int64, expectedGoalRevision *int64) (DraftView, error) {
	view, err := service.store.AdoptGoalSuggestion(ctx, userID, draftID, goalID, generationID, expectedDraftRevision, expectedGoalRevision, service.clock.Now().UTC())
	missing := ErrGoalDraftNotFound
	if goalID != "" {
		missing = ErrGoalNotFound
	}
	return view, resourceNotFound(err, missing)
}

func (service *Service) RunActionAI(ctx context.Context, input ActionAIInput) (AIResponse, error) {
	generationID, err := service.ids.NewID()
	if err != nil {
		return AIResponse{}, err
	}
	input.GenerationID = generationID
	input.Now = service.clock.Now().UTC()
	snapshot, err := service.store.BeginActionAI(ctx, input, service.selectAIContext)
	if err != nil {
		return AIResponse{}, specificAIInputError(input.Operation, resourceNotFound(err, ErrCycleNotFound))
	}
	if snapshot.ReplayedOutput != nil {
		return AIResponse{
			GenerationID: snapshot.GenerationID, Action: *snapshot.ReplayedOutput,
			ContentRevision: snapshot.ReplayedContentRevision, ActionRevision: snapshot.ReplayedActionRevision,
			ContextChanged: snapshot.ReplayedContextChanged, Replayed: true,
		}, nil
	}
	startedAt := service.clock.Now()
	result, providerErr := service.executeProvider(ctx, snapshot)
	finishContext, cancel := service.finalizationContext(ctx)
	defer cancel()
	response, finishErr := service.store.FinishActionAI(finishContext, snapshot, result, providerErr, service.clock.Now().UTC())
	service.observeAI(ctx, snapshot, result, providerErr, finishErr, startedAt)
	return response, specificAIInputError(input.Operation, resourceNotFound(finishErr, ErrCycleNotFound))
}

func (service *Service) executeProvider(ctx context.Context, snapshot AISnapshot) (AIProviderResult, error) {
	request := providerRequestFromSnapshot(snapshot, service.outputTokenLimit(snapshot.Operation))
	var result AIProviderResult
	var err error
	var inputTokens, outputTokens int64
	var costUSD float64
	attempts := service.settings.MaxProviderAttempts
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		attemptResult, attemptErr := service.provider.Execute(ctx, request)
		inputTokens += attemptResult.InputTokens
		outputTokens += attemptResult.OutputTokens
		costUSD += attemptResult.CostUSD
		result = attemptResult
		result.InputTokens = inputTokens
		result.OutputTokens = outputTokens
		result.CostUSD = costUSD
		result.Attempts = int16(attempt)
		err = attemptErr
		if err == nil {
			result.Output, err = validateAIOutput(snapshot.Operation, result.Output)
		}
		if err == nil {
			break
		}
		if !errors.Is(err, ErrAIInvalidResponse) && !errors.Is(err, ErrAIProviderUnavailable) {
			break
		}
		if attempt < attempts {
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
	return result, err
}

func validateAIOutput(operation, output string) (string, error) {
	switch operation {
	case "goal_refine":
		normalized, err := goal.NormalizeText(output, false)
		if err != nil {
			return "", ErrAIInvalidResponse
		}
		return normalized, nil
	case "action_generate", "action_refine":
		normalized, err := cycle.NormalizeAndValidateText(output)
		if err != nil || strings.TrimSpace(normalized) == "" {
			return "", ErrAIInvalidResponse
		}
		return normalized, nil
	default:
		return "", ErrAIInvalidResponse
	}
}

func (service *Service) finalizationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	grace := service.settings.FinalizationGrace
	if grace <= 0 {
		grace = 15 * time.Second
	}
	return context.WithTimeout(context.WithoutCancel(ctx), grace)
}

func (service *Service) observeAI(ctx context.Context, snapshot AISnapshot, result AIProviderResult, providerErr, finishErr error, startedAt time.Time) {
	if service.settings.AIObserver == nil {
		return
	}
	resultLabel := "success"
	if providerErr != nil || finishErr != nil {
		resultLabel = "failure"
	}
	service.settings.AIObserver.ObserveAI(context.WithoutCancel(ctx), AIObservation{
		Operation: snapshot.Operation, Result: resultLabel, Model: service.settings.Model,
		PromptVersion: service.promptVersion(snapshot.Operation), InputTokens: result.InputTokens,
		OutputTokens: result.OutputTokens, EstimatedCostUSD: result.CostUSD,
		ContextCycleCount: len(snapshot.PastCycles), CurrentTruncated: snapshot.CurrentTruncated,
		Duration: service.clock.Now().Sub(startedAt),
	})
}

func (service *Service) promptVersion(operation string) string {
	switch operation {
	case "goal_refine":
		return service.settings.GoalPromptVersion
	case "action_generate":
		return service.settings.GeneratePromptVersion
	case "action_refine":
		return service.settings.RefinePromptVersion
	default:
		return ""
	}
}

func (service *Service) threeIDs() (string, string, string, error) {
	first, err := service.ids.NewID()
	if err != nil {
		return "", "", "", err
	}
	second, err := service.ids.NewID()
	if err != nil {
		return "", "", "", err
	}
	third, err := service.ids.NewID()
	return first, second, third, err
}

func (service *Service) twoIDs() (string, string, error) {
	first, err := service.ids.NewID()
	if err != nil {
		return "", "", err
	}
	second, err := service.ids.NewID()
	return first, second, err
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

func specificAIInputError(operation string, err error) error {
	if !errors.Is(err, ErrAIInputIncomplete) {
		return err
	}
	switch operation {
	case "goal_refine":
		return ErrGoalRefineInputEmpty
	case "action_generate":
		return ErrActionGenerateInputIncomplete
	case "action_refine":
		return ErrActionRefineInputIncomplete
	default:
		return err
	}
}
