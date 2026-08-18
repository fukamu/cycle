package workspace

import (
	"context"
	"errors"
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
		results: []AIProviderResult{{Output: ""}, {Output: " 目標\r\n本文 "}},
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
}

func TestExecuteProviderPassesOnlySelectedSameGoalContext(t *testing.T) {
	provider := &scriptedProvider{results: []AIProviderResult{{Output: "次に行うこと"}}, errors: []error{nil}}
	service := &Service{provider: provider, settings: Settings{MaxProviderAttempts: 1}}
	past := []AIContextCycle{{ID: "cycle-1", GoalID: "goal-1", Plan: "P"}}
	_, err := service.executeProvider(context.Background(), AISnapshot{
		Operation: "action_generate", GoalBody: "目標", CurrentCycle: &AIContextCycle{ID: "cycle-2", GoalID: "goal-1"}, PastCycles: past,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := provider.inputs[0]
	if got.CurrentCycle == nil || got.CurrentCycle.GoalID != "goal-1" || len(got.PastCycles) != 1 || got.PastCycles[0].ID != "cycle-1" {
		t.Fatalf("provider context = %#v", got)
	}
	got.PastCycles[0].Plan = "mutated"
	if past[0].Plan != "P" {
		t.Fatal("provider was given the service snapshot backing slice")
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
