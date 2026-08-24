package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type scriptedProvider struct {
	goalResults     []GoalRefineAIResult
	generateResults []GenerateActionAIResult
	refineResults   []RefineActionAIResult
	usages          []AIUsage
	errors          []error
	goalInputs      []RefineGoalAIInput
	generateInputs  []GenerateActionAIInput
	refineInputs    []RefineActionAIInput
}

func (provider *scriptedProvider) attempt(index int) (AIUsage, error) {
	var usage AIUsage
	var err error
	if index < len(provider.usages) {
		usage = provider.usages[index]
	}
	if index < len(provider.errors) {
		err = provider.errors[index]
	}
	return usage, err
}

func (provider *scriptedProvider) RefineGoal(_ context.Context, input RefineGoalAIInput) (GoalRefineAIResult, AIUsage, error) {
	provider.goalInputs = append(provider.goalInputs, input)
	index := len(provider.goalInputs) - 1
	usage, err := provider.attempt(index)
	return provider.goalResults[index], usage, err
}

func (provider *scriptedProvider) GenerateAction(_ context.Context, input GenerateActionAIInput) (GenerateActionAIResult, AIUsage, error) {
	provider.generateInputs = append(provider.generateInputs, input)
	index := len(provider.generateInputs) - 1
	usage, err := provider.attempt(index)
	return provider.generateResults[index], usage, err
}

func (provider *scriptedProvider) RefineAction(_ context.Context, input RefineActionAIInput) (RefineActionAIResult, AIUsage, error) {
	provider.refineInputs = append(provider.refineInputs, input)
	index := len(provider.refineInputs) - 1
	usage, err := provider.attempt(index)
	return provider.refineResults[index], usage, err
}

func (provider *scriptedProvider) callCount() int {
	return len(provider.goalInputs) + len(provider.generateInputs) + len(provider.refineInputs)
}

func TestExecuteAIRetriesInvalidResponseWithinOneLogicalOperation(t *testing.T) {
	provider := &scriptedProvider{
		goalResults: []GoalRefineAIResult{{}, {Suggestion: " goal\r\ntext "}},
		usages: []AIUsage{
			{InputTokens: 10, OutputTokens: 2, CostUSD: 0.01, ProviderRequestID: "request-1"},
			{InputTokens: 11, OutputTokens: 3, CostUSD: 0.02, ProviderRequestID: "request-2"},
		},
		errors: []error{ErrAIInvalidResponse, nil},
	}
	service := &Service{
		goalRefiner: provider,
		settings: Settings{
			MaxProviderAttempts: 2, Model: "test-model", GoalRefineInstructions: "goal instructions",
			GoalPromptVersion: "goal-v2",
		},
	}
	snapshot := AISnapshot{
		Operation: domainai.OperationGoalRefine, SourceText: "source", MaxOutputTokens: 400,
	}
	result, err := service.executeAI(context.Background(), &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(provider.goalInputs) != 2 || result.Attempts != 2 {
		t.Fatalf("attempts = %d calls = %d", result.Attempts, len(provider.goalInputs))
	}
	if result.Output != " goal\ntext " {
		t.Fatalf("output was not newline-normalized: %q", result.Output)
	}
	if result.Usage.InputTokens != 21 || result.Usage.OutputTokens != 5 ||
		math.Abs(result.Usage.CostUSD-0.03) > 0.000001 || result.Usage.ProviderRequestID != "request-2" {
		t.Fatalf("retry usage was not accumulated: %#v", result)
	}
	if strings.Contains(provider.goalInputs[0].Instructions, invalidResponseRetryInstruction) ||
		!strings.Contains(provider.goalInputs[1].Instructions, invalidResponseRetryInstruction) {
		t.Fatalf("retry instructions = %#v", provider.goalInputs)
	}
	if snapshot.CanonicalProviderInputHash == "" {
		t.Fatal("canonical provider input hash was not attached")
	}
}

func TestExecuteAIRetriesProviderUnavailableWithoutValidationReinforcement(t *testing.T) {
	provider := &scriptedProvider{
		goalResults: []GoalRefineAIResult{{}, {Suggestion: "recovered goal"}},
		usages: []AIUsage{
			{InputTokens: 7, OutputTokens: 1, CostUSD: 0.01, ProviderRequestID: "request-1"},
			{InputTokens: 8, OutputTokens: 2, CostUSD: 0.02, ProviderRequestID: "request-2"},
		},
		errors: []error{ErrAIProviderUnavailable, nil},
	}
	service := &Service{
		goalRefiner: provider,
		settings: Settings{
			MaxProviderAttempts: 2, Model: "test-model", GoalRefineInstructions: "goal instructions",
			GoalPromptVersion: "goal-v2",
		},
	}
	snapshot := AISnapshot{
		Operation: domainai.OperationGoalRefine, SourceText: "source", MaxOutputTokens: 400,
	}

	result, err := service.executeAI(context.Background(), &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != "recovered goal" || result.Attempts != 2 || len(provider.goalInputs) != 2 {
		t.Fatalf("result/calls = %#v/%d", result, len(provider.goalInputs))
	}
	if result.Usage.InputTokens != 15 || result.Usage.OutputTokens != 3 ||
		math.Abs(result.Usage.CostUSD-0.03) > 0.000001 || result.Usage.ProviderRequestID != "request-2" {
		t.Fatalf("retry usage was not accumulated: %#v", result.Usage)
	}
	for index, input := range provider.goalInputs {
		if strings.Contains(input.Instructions, invalidResponseRetryInstruction) {
			t.Fatalf("provider-unavailable attempt %d received validation reinforcement: %q", index+1, input.Instructions)
		}
	}
}

func TestExecuteAIStopsAfterOneAttemptForNonRetryableFailuresAndCancellation(t *testing.T) {
	nonRetryableErr := errors.New("non-retryable provider failure")
	tests := []struct {
		name          string
		providerError error
		cancelContext bool
		wantError     error
	}{
		{name: "provider timeout", providerError: ErrAIProviderTimeout, wantError: ErrAIProviderTimeout},
		{name: "non-retryable provider error", providerError: nonRetryableErr, wantError: nonRetryableErr},
		{
			name: "context cancellation before retry", providerError: ErrAIProviderUnavailable,
			cancelContext: true, wantError: context.Canceled,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			provider := &scriptedProvider{
				goalResults: []GoalRefineAIResult{{}, {Suggestion: "must not be used"}},
				usages: []AIUsage{
					{InputTokens: 7, OutputTokens: 1, CostUSD: 0.01, ProviderRequestID: "request-1"},
					{InputTokens: 99, OutputTokens: 99, CostUSD: 9.99, ProviderRequestID: "request-2"},
				},
				errors: []error{test.providerError, nil},
			}
			service := &Service{
				goalRefiner: provider,
				settings: Settings{
					MaxProviderAttempts: 2, MaxRetryBackoff: 0, Model: "test-model",
					GoalRefineInstructions: "goal instructions", GoalPromptVersion: "goal-v2",
				},
			}
			ctx := context.Background()
			if test.cancelContext {
				canceledCtx, cancel := context.WithCancel(ctx)
				cancel()
				ctx = canceledCtx
			}

			result, err := service.executeAI(ctx, &AISnapshot{
				Operation: domainai.OperationGoalRefine, SourceText: "source", MaxOutputTokens: 400,
			})
			if !errors.Is(err, test.wantError) {
				t.Fatalf("error = %v, want %v", err, test.wantError)
			}
			if result.Attempts != 1 || len(provider.goalInputs) != 1 {
				t.Fatalf("attempts/calls = %d/%d", result.Attempts, len(provider.goalInputs))
			}
			if result.Usage.InputTokens != 7 || result.Usage.OutputTokens != 1 ||
				result.Usage.CostUSD != 0.01 || result.Usage.ProviderRequestID != "request-1" {
				t.Fatalf("usage includes an unexecuted retry: %#v", result.Usage)
			}
			if strings.Contains(provider.goalInputs[0].Instructions, invalidResponseRetryInstruction) {
				t.Fatalf("first attempt received validation reinforcement: %q", provider.goalInputs[0].Instructions)
			}
		})
	}
}

func TestExecuteAIRetriesDomainInvalidRawGoalResult(t *testing.T) {
	rawInvalid := strings.Repeat("x", 81)
	provider := &scriptedProvider{
		goalResults: []GoalRefineAIResult{
			{Suggestion: rawInvalid},
			{Suggestion: "preserve the intent"},
		},
		errors: []error{nil, nil},
	}
	service := &Service{
		goalRefiner: provider,
		settings: Settings{
			MaxProviderAttempts: 2, Model: "test-model", GoalRefineInstructions: "goal instructions",
			GoalPromptVersion: "goal-v2",
		},
	}
	snapshot := AISnapshot{Operation: domainai.OperationGoalRefine, MaxOutputTokens: 400}
	result, err := service.executeAI(context.Background(), &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(provider.goalInputs) != 2 || result.Attempts != 2 || result.Output != "preserve the intent" {
		t.Fatalf("calls/result = %d/%#v", len(provider.goalInputs), result)
	}
	if provider.goalInputs[0].Instructions != "goal instructions" ||
		provider.goalInputs[1].Instructions != "goal instructions"+invalidResponseRetryInstruction {
		t.Fatalf("retry changed more than validation instructions: %#v", provider.goalInputs)
	}
	encodedRetry, err := json.Marshal(provider.goalInputs[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encodedRetry), rawInvalid) {
		t.Fatalf("raw invalid output was reinserted into retry input: %s", encodedRetry)
	}
}

func TestExecuteAIValidatesAndRendersRawGeneratedActionsWithSelectedContext(t *testing.T) {
	provider := &scriptedProvider{
		generateResults: []GenerateActionAIResult{{Actions: []string{" first ", "second"}}},
		errors:          []error{nil},
	}
	service := &Service{
		actionGenerator: provider,
		settings: Settings{
			MaxProviderAttempts: 1, Model: "test-model", ActionGenerateInstructions: "generate instructions",
			GeneratePromptVersion: "generate-v2",
		},
	}
	past := []AIContextCycle{{ID: "cycle-1", GoalID: "goal-1", SequenceNumber: 1, Plan: "P"}}
	snapshot := AISnapshot{
		Operation: domainai.OperationActionGenerate, GoalID: "goal-1", GoalBody: "goal",
		CurrentCycle: &AIContextCycle{ID: "cycle-2", GoalID: "goal-1", SequenceNumber: 2},
		PastCycles:   past, MaxOutputTokens: 800,
	}
	result, err := service.executeAI(context.Background(), &snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != "1. first\n\n2. second" || len(provider.generateInputs) != 1 {
		t.Fatalf("result/calls = %#v/%d", result, len(provider.generateInputs))
	}
	got := provider.generateInputs[0]
	if got.CurrentCycle == nil || got.CurrentCycle.SequenceNumber != 2 ||
		len(got.PastCycles) != 1 || got.PastCycles[0].SequenceNumber != 1 {
		t.Fatalf("provider context = %#v", got)
	}
	got.PastCycles[0].Plan = "mutated"
	if past[0].Plan != "P" {
		t.Fatal("provider received the snapshot backing slice")
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "cycle-1") || strings.Contains(string(encoded), "goal-1") {
		t.Fatalf("provider payload leaked internal IDs: %s", encoded)
	}
}

func TestExecuteAIValidatesRawRefinedAction(t *testing.T) {
	provider := &scriptedProvider{
		refineResults: []RefineActionAIResult{{RefinedAction: " improve\r\naction "}},
		errors:        []error{nil},
	}
	service := &Service{
		actionGenerator: provider,
		settings: Settings{
			MaxProviderAttempts: 1, Model: "test-model", ActionRefineInstructions: "refine instructions",
			RefinePromptVersion: "refine-v2",
		},
	}
	snapshot := AISnapshot{
		Operation: domainai.OperationActionRefine, MaxOutputTokens: 800,
		CurrentCycle: &AIContextCycle{GoalID: "goal-1", Action: "action"},
	}
	result, err := service.executeAI(context.Background(), &snapshot)
	if err != nil || result.Output != " improve\naction " || len(provider.refineInputs) != 1 {
		t.Fatalf("result/error/calls = %#v/%v/%d", result, err, len(provider.refineInputs))
	}
}

func TestTerminateRejectsInvalidOutcomeBeforeTransaction(t *testing.T) {
	useCases := NewReviewTransitionUseCases(nil, nil, nil)
	_, err := useCases.Terminate(context.Background(), TerminateInput{Outcome: goal.StatusActiveCycle})
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
		operation domainai.OperationType
		want      error
	}{
		{domainai.OperationGoalRefine, ErrGoalRefineInputEmpty},
		{domainai.OperationActionGenerate, ErrActionGenerateInputIncomplete},
		{domainai.OperationActionRefine, ErrActionRefineInputIncomplete},
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
}

type serviceTestGoalDraftUOW struct{ tx GoalDraftTx }

func (uow serviceTestGoalDraftUOW) WithinGoalDraftTransaction(ctx context.Context, operation func(GoalDraftTx) error) error {
	return operation(uow.tx)
}

type replayGoalDraftTx struct {
	GoalDraftTx
	draft  goal.Draft
	replay GoalRefineReplayState
}

func (tx *replayGoalDraftTx) LockUser(context.Context, string) error { return nil }

func (tx *replayGoalDraftTx) LockExpiredGenerations(context.Context, string, time.Time) ([]ExpiredGeneration, error) {
	return nil, nil
}

func (tx *replayGoalDraftTx) SumLockedReservationsByMonth(context.Context, []string) ([]MonthlyReservation, error) {
	return nil, nil
}

func (tx *replayGoalDraftTx) LockDraftByID(context.Context, string, string) (goal.Draft, error) {
	return tx.draft, nil
}

func (tx *replayGoalDraftTx) FindGoalRefineReplay(context.Context, string, string) (*GoalRefineReplayState, error) {
	return &tx.replay, nil
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
	const generationID = "20000000-0000-7000-8000-000000000001"
	input := GoalRefineInput{
		UserID:                "10000000-0000-7000-8000-000000000011",
		DraftID:               "10000000-0000-7000-8000-000000000012",
		ExpectedDraftRevision: 4, ExpectedGoalRevision: &expectedGoalRevision,
		IdempotencyKey: "10000000-0000-7000-8000-000000000013",
	}
	tx := &replayGoalDraftTx{
		draft: goal.Draft{ID: input.DraftID, UserID: input.UserID, Type: goal.DraftCreation, Body: "元の目標", Revision: 4},
		replay: GoalRefineReplayState{
			GenerationID: generationID, InputHash: goalRefineRequestHash(input), Status: aiStatusSucceeded,
			TargetRevision: 4, Output: &output, ContextChanged: true,
		},
	}
	store := &replayOnlyStore{}
	provider := &scriptedProvider{}
	service := NewService(store, serviceTestGoalDraftUOW{tx: tx}, nil, nil, nil, nil, nil, nil, provider, provider, replayTestClock{}, replayTestIDs{}, Settings{})

	response, err := service.RefineGoal(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if response.GenerationID != generationID || response.Suggestion != output ||
		response.SourceDraftRevision == nil || *response.SourceDraftRevision != 4 ||
		response.SourceGoalRevision != expectedGoalRevision || !response.ContextChanged || !response.Replayed {
		t.Fatalf("goal replay response = %#v", response)
	}
	if provider.callCount() != 0 {
		t.Fatalf("provider calls on replay = %d", provider.callCount())
	}
}

func TestActionReplayPreservesOriginalContextChanged(t *testing.T) {
	output := "次の行動"
	snapshot := AISnapshot{
		GenerationID:            "30000000-0000-7000-8000-000000000001",
		ReplayedOutput:          &output,
		ReplayedContextChanged:  true,
		ReplayedContentRevision: 9,
		ReplayedActionRevision:  3,
	}
	provider := &scriptedProvider{}
	service := &Service{goalRefiner: provider, actionGenerator: provider}

	response, err := service.runActionAI(
		context.Background(), "user-id", domainai.OperationActionRefine,
		func(AIContextSelector) (AISnapshot, error) { return snapshot, nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.GenerationID != snapshot.GenerationID || response.Action != output ||
		response.ContentRevision != 9 || response.ActionRevision != 3 ||
		!response.ContextChanged || !response.Replayed {
		t.Fatalf("action replay response = %#v", response)
	}
	if provider.callCount() != 0 {
		t.Fatalf("provider calls on replay = %d", provider.callCount())
	}
}

type saveReviewLeaseStore struct{ Store }

type saveReviewLeaseTx struct {
	GoalDraftTx
	userID                string
	goalID                string
	expectedReviewDraftID string
	saved                 goal.Draft
	expectedRevision      int64
}

func (tx *saveReviewLeaseTx) LockGoalWithCurrentVersion(_ context.Context, userID, goalID string) (GoalTargetState, error) {
	tx.userID = userID
	tx.goalID = goalID
	return GoalTargetState{Status: goal.StatusGoalReview}, nil
}

func (tx *saveReviewLeaseTx) LockDraftByID(_ context.Context, userID, draftID string) (goal.Draft, error) {
	tx.userID = userID
	tx.expectedReviewDraftID = draftID
	goalID := tx.goalID
	return goal.Draft{
		ID: draftID, UserID: userID, Type: goal.DraftReview, GoalID: &goalID,
		Body: "server body", Revision: 4,
	}, nil
}

func (tx *saveReviewLeaseTx) SaveDraftCAS(_ context.Context, draft goal.Draft, expectedRevision int64) (int64, error) {
	tx.saved = draft
	tx.expectedRevision = expectedRevision
	return 1, nil
}

func TestSaveReviewForwardsExpectedDraftGeneration(t *testing.T) {
	store := &saveReviewLeaseStore{}
	tx := &saveReviewLeaseTx{}
	service := NewService(store, serviceTestGoalDraftUOW{tx: tx}, nil, nil, nil, nil, nil, nil, nil, nil, replayTestClock{}, nil, Settings{})
	const (
		userID        = "10000000-0000-7000-8000-000000000001"
		goalID        = "20000000-0000-7000-8000-000000000001"
		reviewDraftID = "30000000-0000-7000-8000-000000000001"
	)

	view, err := service.SaveReview(context.Background(), userID, goalID, reviewDraftID, "local body", 4)
	if err != nil {
		t.Fatal(err)
	}
	if tx.userID != userID || tx.goalID != goalID || tx.expectedReviewDraftID != reviewDraftID ||
		tx.saved.Body != "local body" || tx.expectedRevision != 4 || !tx.saved.UpdatedAt.Equal(replayTestClock{}.Now()) {
		t.Fatalf("SaveReview transaction input = %#v", tx)
	}
	if view.ID != reviewDraftID || view.Body != "local body" || view.Revision != 5 {
		t.Fatalf("SaveReview view = %#v", view)
	}
}
