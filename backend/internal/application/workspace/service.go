package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	"github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/goal"
)

type Settings struct {
	MaxProgressingGoals int
	MaxProviderAttempts int
	MaxRetryBackoff     time.Duration
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
	return service.store.GetDraft(ctx, userID, draftID)
}

func (service *Service) SaveDraft(ctx context.Context, userID, draftID, body string, expectedRevision int64) (DraftView, error) {
	return service.store.SaveDraft(ctx, userID, draftID, body, expectedRevision, service.clock.Now().UTC())
}

func (service *Service) AbandonDraft(ctx context.Context, userID, draftID string) error {
	return service.store.AbandonDraft(ctx, userID, draftID, service.clock.Now().UTC())
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
	return service.store.StartGoal(ctx, StartGoalInput{
		UserID: userID, DraftID: draftID, OperationID: operationID,
		ExpectedDraftRevision: expectedDraftRevision, RequestHash: requestHash,
		GoalID: goalID, VersionID: versionID, CycleID: cycleID, Now: service.clock.Now().UTC(),
	}, service.settings.MaxProgressingGoals)
}

func (service *Service) ListGoals(ctx context.Context, userID, scope, cursor string, limit int) (GoalPage, error) {
	return service.store.ListGoals(ctx, userID, scope, cursor, limit)
}

func (service *Service) GetGoal(ctx context.Context, userID, goalID string) (GoalView, error) {
	return service.store.GetGoal(ctx, userID, goalID)
}

func (service *Service) GetReview(ctx context.Context, userID, goalID string) (ReviewView, error) {
	return service.store.GetReview(ctx, userID, goalID)
}

func (service *Service) SaveReview(ctx context.Context, userID, goalID, body string, expectedRevision int64) (DraftView, error) {
	return service.store.SaveReview(ctx, userID, goalID, body, expectedRevision, service.clock.Now().UTC())
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
	return service.store.ContinueReview(ctx, ContinueReviewInput{
		UserID: userID, GoalID: goalID, OperationID: operationID,
		ExpectedGoalRevision: expectedGoalRevision, ExpectedDraftRevision: expectedDraftRevision,
		RequestHash: requestHash, VersionID: versionID, CycleID: cycleID, Now: service.clock.Now().UTC(),
	})
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
	return service.store.Terminate(ctx, input)
}

func (service *Service) DeleteGoal(ctx context.Context, userID, goalID string, confirmed bool, expectedRevision int64, idempotencyKey string) error {
	return service.store.DeleteGoal(ctx, userID, goalID, confirmed, expectedRevision, idempotencyKey,
		hashRequest(struct {
			GoalID    string `json:"goalId"`
			Confirmed bool   `json:"confirmed"`
			Revision  int64  `json:"revision"`
		}{goalID, confirmed, expectedRevision}), service.clock.Now().UTC())
}

func (service *Service) ListCycles(ctx context.Context, userID, goalID, cursor string, limit int) (CyclePage, error) {
	return service.store.ListCycles(ctx, userID, goalID, cursor, limit)
}

func (service *Service) GetCycle(ctx context.Context, userID, goalID, cycleID string) (CycleView, error) {
	return service.store.GetCycle(ctx, userID, goalID, cycleID)
}

func (service *Service) SaveFrame(ctx context.Context, input SaveFrameInput) (SaveFrameResult, error) {
	input.Now = service.clock.Now().UTC()
	return service.store.SaveFrame(ctx, input)
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
	return service.store.CompleteCycle(ctx, input)
}

func (service *Service) RefineGoal(ctx context.Context, input GoalRefineInput) (AIResponse, error) {
	generationID, err := service.ids.NewID()
	if err != nil {
		return AIResponse{}, err
	}
	input.GenerationID = generationID
	input.Now = service.clock.Now().UTC()
	snapshot, err := service.store.BeginGoalRefine(ctx, input)
	if err != nil {
		return AIResponse{}, err
	}
	if snapshot.ReplayedOutput != nil {
		return AIResponse{GenerationID: snapshot.GenerationID, SourceDraftRevision: snapshot.TargetRevision, Suggestion: *snapshot.ReplayedOutput}, nil
	}
	result, providerErr := service.executeProvider(ctx, snapshot)
	return service.store.FinishGoalRefine(ctx, snapshot, result, providerErr, service.clock.Now().UTC())
}

func (service *Service) AdoptGoalSuggestion(ctx context.Context, userID, draftID, generationID string, expectedDraftRevision int64, expectedGoalRevision *int64) (DraftView, error) {
	return service.store.AdoptGoalSuggestion(ctx, userID, draftID, generationID, expectedDraftRevision, expectedGoalRevision, service.clock.Now().UTC())
}

func (service *Service) RunActionAI(ctx context.Context, input ActionAIInput) (AIResponse, error) {
	generationID, err := service.ids.NewID()
	if err != nil {
		return AIResponse{}, err
	}
	input.GenerationID = generationID
	input.Now = service.clock.Now().UTC()
	snapshot, err := service.store.BeginActionAI(ctx, input)
	if err != nil {
		return AIResponse{}, err
	}
	if snapshot.ReplayedOutput != nil {
		return AIResponse{GenerationID: snapshot.GenerationID, Action: *snapshot.ReplayedOutput}, nil
	}
	result, providerErr := service.executeProvider(ctx, snapshot)
	return service.store.FinishActionAI(ctx, snapshot, result, providerErr, service.clock.Now().UTC())
}

func (service *Service) executeProvider(ctx context.Context, snapshot AISnapshot) (AIProviderResult, error) {
	request := AIProviderRequest{
		Operation: snapshot.Operation, GoalBody: snapshot.GoalBody, SourceText: snapshot.SourceText,
		CurrentCycle: snapshot.CurrentCycle, PastCycles: append([]AIContextCycle(nil), snapshot.PastCycles...),
	}
	var result AIProviderResult
	var err error
	attempts := service.settings.MaxProviderAttempts
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		result, err = service.provider.Execute(ctx, request)
		result.Attempts = int16(attempt)
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
	if err == nil {
		switch snapshot.Operation {
		case "goal_refine":
			if normalized, validationErr := goal.NormalizeText(result.Output, false); validationErr != nil {
				err = ErrAIInvalidResponse
			} else {
				result.Output = normalized
			}
		case "action_generate", "action_refine":
			if normalized, validationErr := cycle.NormalizeAndValidateText(result.Output); validationErr != nil || strings.TrimSpace(normalized) == "" {
				err = ErrAIInvalidResponse
			} else {
				result.Output = normalized
			}
		}
	}
	return result, err
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
