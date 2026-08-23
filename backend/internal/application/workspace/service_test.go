package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
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
	actionSnapshot AISnapshot
}

func (store *replayOnlyStore) BeginActionAI(context.Context, ActionAIInput, AIContextSelector) (AISnapshot, error) {
	return store.actionSnapshot, nil
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
	service := NewService(store, serviceTestGoalDraftUOW{tx: tx}, provider, replayTestClock{}, replayTestIDs{}, Settings{})

	response, err := service.RefineGoal(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if response.GenerationID != generationID || response.Suggestion != output ||
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
	service := NewService(store, serviceTestGoalDraftUOW{}, provider, replayTestClock{}, replayTestIDs{}, Settings{})

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
	service := NewService(store, serviceTestGoalDraftUOW{tx: tx}, nil, replayTestClock{}, nil, Settings{})
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

func TestValidateAIOutputUsesCodePointAndExactWhitespaceSemantics(t *testing.T) {
	goalAtLimit := strings.Repeat("🌱", goal.MaxGoalCodePoints)
	if output, err := validateAIOutput("goal_refine", goalAtLimit); err != nil || output != goalAtLimit {
		t.Fatalf("80-code-point Goal AI output = %q, %v", output, err)
	}
	if _, err := validateAIOutput("goal_refine", goalAtLimit+"🌱"); !errors.Is(err, ErrAIInvalidResponse) {
		t.Fatalf("81-code-point Goal AI output error = %v, want %v", err, ErrAIInvalidResponse)
	}

	frameAtLimit := strings.Repeat("🌱", cycle.MaxFrameCodePoints)
	if output, err := validateAIOutput("action_refine", frameAtLimit); err != nil || output != frameAtLimit {
		t.Fatalf("200-code-point Frame AI output = %q, %v", output, err)
	}
	if _, err := validateAIOutput("action_refine", frameAtLimit+"🌱"); !errors.Is(err, ErrAIInvalidResponse) {
		t.Fatalf("201-code-point Frame AI output error = %v, want %v", err, ErrAIInvalidResponse)
	}

	const input = "  目標\r\n本文\r末尾 \t"
	const want = "  目標\n本文\n末尾 \t"
	if output, err := validateAIOutput("goal_refine", input); err != nil || output != want {
		t.Fatalf("Goal AI newline/whitespace output = %q, %v, want %q", output, err, want)
	}
	if output, err := validateAIOutput("action_refine", input); err != nil || output != want {
		t.Fatalf("Frame AI newline/whitespace output = %q, %v, want %q", output, err, want)
	}
}
