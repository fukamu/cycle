package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type scriptedProvider struct {
	results []AIProviderResult
	errors  []error
	inputs  []AIProviderRequest
}

func (provider *scriptedProvider) Execute(_ context.Context, input AIProviderRequest) (AIProviderResult, error) {
	provider.inputs = append(provider.inputs, input)
	index := len(provider.inputs) - 1
	return provider.results[index], provider.errors[index]
}

func TestExecuteProviderRetriesInvalidResponseWithinOneLogicalOperation(t *testing.T) {
	provider := &scriptedProvider{
		results: []AIProviderResult{{Output: "", InputTokens: 10, OutputTokens: 2, CostUSD: 0.01}, {Output: " 目標\r\n本文 ", InputTokens: 11, OutputTokens: 3, CostUSD: 0.02}},
		errors:  []error{ErrAIInvalidResponse, nil},
	}
	service := &Service{provider: provider, settings: Settings{MaxProviderAttempts: 2}}
	result, err := service.executeProvider(context.Background(), AISnapshot{Operation: "goal_refine", SourceText: "元の目標"})
	if err != nil {
		t.Fatal(err)
	}
	if len(provider.inputs) != 2 || result.Attempts != 2 {
		t.Fatalf("attempts = %d calls = %d", result.Attempts, len(provider.inputs))
	}
	if result.Output != " 目標\n本文 " {
		t.Fatalf("output was not newline-normalized: %q", result.Output)
	}
	if result.InputTokens != 21 || result.OutputTokens != 5 || math.Abs(result.CostUSD-0.03) > 0.000001 {
		t.Fatalf("retry usage was not accumulated: %#v", result)
	}
}

func TestExecuteProviderRetriesDomainInvalidOutput(t *testing.T) {
	provider := &scriptedProvider{
		results: []AIProviderResult{{Output: strings.Repeat("長", 501)}, {Output: "意図を維持した目標"}},
		errors:  []error{nil, nil},
	}
	service := &Service{provider: provider, settings: Settings{MaxProviderAttempts: 2}}
	result, err := service.executeProvider(context.Background(), AISnapshot{Operation: "goal_refine"})
	if err != nil {
		t.Fatal(err)
	}
	if len(provider.inputs) != 2 || result.Output != "意図を維持した目標" {
		t.Fatalf("calls/result = %d/%#v", len(provider.inputs), result)
	}
}

func TestExecuteProviderPassesOnlySelectedSameGoalContext(t *testing.T) {
	provider := &scriptedProvider{results: []AIProviderResult{{Output: "次に行うこと"}}, errors: []error{nil}}
	service := &Service{provider: provider, settings: Settings{MaxProviderAttempts: 1}}
	past := []AIContextCycle{{ID: "cycle-1", GoalID: "goal-1", SequenceNumber: 1, Plan: "P"}}
	_, err := service.executeProvider(context.Background(), AISnapshot{
		Operation: "action_generate", GoalID: "goal-1", GoalBody: "目標", CurrentCycle: &AIContextCycle{ID: "cycle-2", GoalID: "goal-1", SequenceNumber: 2}, PastCycles: past,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := provider.inputs[0]
	if got.CurrentCycle == nil || got.CurrentCycle.SequenceNumber != 2 || len(got.PastCycles) != 1 || got.PastCycles[0].SequenceNumber != 1 {
		t.Fatalf("provider context = %#v", got)
	}
	got.PastCycles[0].Plan = "mutated"
	if past[0].Plan != "P" {
		t.Fatal("provider was given the service snapshot backing slice")
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "cycle-1") || strings.Contains(string(encoded), "goal-1") {
		t.Fatalf("provider payload leaked internal IDs: %s", encoded)
	}
}

func TestTerminateRejectsInvalidOutcomeBeforeStoreCall(t *testing.T) {
	service := &Service{}
	_, err := service.Terminate(context.Background(), TerminateInput{Outcome: goal.StatusActiveCycle})
	if !errors.Is(err, ErrInvalidGoalOutcome) {
		t.Fatalf("error = %v", err)
	}
}

func TestRequestHashIsStableAndBodySensitive(t *testing.T) {
	first := hashRequest(struct{ Body string }{"alpha"})
	if first != hashRequest(struct{ Body string }{"alpha"}) {
		t.Fatal("same canonical request produced a different hash")
	}
	if first == hashRequest(struct{ Body string }{"beta"}) {
		t.Fatal("different requests produced the same hash")
	}
}

func TestAIInputErrorsAreSpecificToEachOperation(t *testing.T) {
	tests := []struct {
		operation string
		want      error
	}{
		{"goal_refine", ErrGoalRefineInputEmpty},
		{"action_generate", ErrActionGenerateInputIncomplete},
		{"action_refine", ErrActionRefineInputIncomplete},
	}
	for _, test := range tests {
		if got := specificAIInputError(test.operation, ErrAIInputIncomplete); !errors.Is(got, test.want) {
			t.Fatalf("%s mapped to %v, want %v", test.operation, got, test.want)
		}
	}
}

func TestGoalRefineResponseIncludesZeroSourceDraftRevision(t *testing.T) {
	zero := int64(0)
	encoded, err := json.Marshal(AIResponse{
		GenerationID:        "generation-id",
		SourceDraftRevision: &zero,
		Suggestion:          "提案",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"sourceDraftRevision":0`) {
		t.Fatalf("zero source revision was omitted from response: %s", encoded)
	}
}

type replayOnlyStore struct {
	Store
	goalSnapshot   AISnapshot
	actionSnapshot AISnapshot
}

func (store *replayOnlyStore) BeginGoalRefine(context.Context, GoalRefineInput, AIContextSelector) (AISnapshot, error) {
	return store.goalSnapshot, nil
}

func (store *replayOnlyStore) BeginActionAI(context.Context, ActionAIInput, AIContextSelector) (AISnapshot, error) {
	return store.actionSnapshot, nil
}

type replayTestClock struct{}

func (replayTestClock) Now() time.Time {
	return time.Date(2026, time.August, 23, 0, 0, 0, 0, time.UTC)
}

type replayTestIDs struct{}

func (replayTestIDs) NewID() (string, error) {
	return "10000000-0000-7000-8000-000000000001", nil
}

func TestGoalRefineReplayPreservesOriginalResponseMetadata(t *testing.T) {
	output := "改善した目標"
	expectedGoalRevision := int64(7)
	store := &replayOnlyStore{goalSnapshot: AISnapshot{
		GenerationID:           "20000000-0000-7000-8000-000000000001",
		TargetRevision:         4,
		SourceGoalRevision:     99,
		ReplayedOutput:         &output,
		ReplayedContextChanged: true,
	}}
	provider := &scriptedProvider{}
	service := NewService(store, provider, replayTestClock{}, replayTestIDs{}, Settings{})

	response, err := service.RefineGoal(context.Background(), GoalRefineInput{
		ExpectedGoalRevision: &expectedGoalRevision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.GenerationID != store.goalSnapshot.GenerationID || response.Suggestion != output ||
		response.SourceDraftRevision == nil || *response.SourceDraftRevision != 4 ||
		response.SourceGoalRevision != expectedGoalRevision || !response.ContextChanged || !response.Replayed {
		t.Fatalf("goal replay response = %#v", response)
	}
	if len(provider.inputs) != 0 {
		t.Fatalf("provider calls on replay = %d", len(provider.inputs))
	}
}

func TestActionReplayPreservesOriginalContextChanged(t *testing.T) {
	output := "次の行動"
	store := &replayOnlyStore{actionSnapshot: AISnapshot{
		GenerationID:            "30000000-0000-7000-8000-000000000001",
		ReplayedOutput:          &output,
		ReplayedContextChanged:  true,
		ReplayedContentRevision: 9,
		ReplayedActionRevision:  3,
	}}
	provider := &scriptedProvider{}
	service := NewService(store, provider, replayTestClock{}, replayTestIDs{}, Settings{})

	response, err := service.RunActionAI(context.Background(), ActionAIInput{Operation: "action_refine"})
	if err != nil {
		t.Fatal(err)
	}
	if response.GenerationID != store.actionSnapshot.GenerationID || response.Action != output ||
		response.ContentRevision != 9 || response.ActionRevision != 3 ||
		!response.ContextChanged || !response.Replayed {
		t.Fatalf("action replay response = %#v", response)
	}
	if len(provider.inputs) != 0 {
		t.Fatalf("provider calls on replay = %d", len(provider.inputs))
	}
}

type saveReviewLeaseStore struct {
	Store
	userID                string
	goalID                string
	expectedReviewDraftID string
	body                  string
	expectedRevision      int64
	now                   time.Time
}

func (store *saveReviewLeaseStore) SaveReview(_ context.Context, userID, goalID, expectedReviewDraftID, body string, expectedRevision int64, now time.Time) (DraftView, error) {
	store.userID = userID
	store.goalID = goalID
	store.expectedReviewDraftID = expectedReviewDraftID
	store.body = body
	store.expectedRevision = expectedRevision
	store.now = now
	return DraftView{ID: expectedReviewDraftID, Body: body, Revision: expectedRevision + 1}, nil
}

func TestSaveReviewForwardsExpectedDraftGeneration(t *testing.T) {
	store := &saveReviewLeaseStore{}
	service := NewService(store, nil, replayTestClock{}, nil, Settings{})
	const (
		userID        = "10000000-0000-7000-8000-000000000001"
		goalID        = "20000000-0000-7000-8000-000000000001"
		reviewDraftID = "30000000-0000-7000-8000-000000000001"
	)

	view, err := service.SaveReview(context.Background(), userID, goalID, reviewDraftID, "local body", 4)
	if err != nil {
		t.Fatal(err)
	}
	if store.userID != userID || store.goalID != goalID || store.expectedReviewDraftID != reviewDraftID ||
		store.body != "local body" || store.expectedRevision != 4 || !store.now.Equal(replayTestClock{}.Now()) {
		t.Fatalf("SaveReview store input = %#v", store)
	}
	if view.ID != reviewDraftID || view.Body != "local body" || view.Revision != 5 {
		t.Fatalf("SaveReview view = %#v", view)
	}
}
