package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/matoruru/PDCAI/backend/internal/domain/goal"
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
