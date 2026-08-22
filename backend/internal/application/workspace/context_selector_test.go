package workspace

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

type runeTokenCounter struct{}

func (runeTokenCounter) Count(_ context.Context, _, value string) (int, error) {
	return utf8.RuneCountInString(value), nil
}

func (runeTokenCounter) Truncate(_ context.Context, _, value string, maximum int, marker string) (string, error) {
	if utf8.RuneCountInString(value) <= maximum {
		return value, nil
	}
	markerLength := utf8.RuneCountInString(marker)
	if maximum < markerLength {
		return "", nil
	}
	runes := []rune(value)
	return string(runes[:maximum-markerLength]) + marker, nil
}

func contextTestService() *Service {
	return &Service{settings: Settings{
		Model: "test-model", MaxInputTokens: 10_000, MaxContextCycles: 10,
		GoalRefineMaxOutputTokens: 400, ActionMaxOutputTokens: 800,
		GoalRefineInstructions: "goal instructions", ActionGenerateInstructions: "generate instructions",
		ActionRefineInstructions: "refine instructions", TokenCounter: runeTokenCounter{},
	}}
}

func TestSelectAIContextIncludesNewestCyclesAsWholeUnitsWithinBudget(t *testing.T) {
	service := contextTestService()
	snapshot := AISnapshot{
		Operation: "action_generate", GoalID: "goal-1", GoalBody: "current goal",
		CurrentCycle: &AIContextCycle{ID: "cycle-3", GoalID: "goal-1", SequenceNumber: 3, Status: cycle.StatusActive, Plan: "plan", Do: "do", Check: "check"},
		PastCycles: []AIContextCycle{
			{ID: "cycle-2", GoalID: "goal-1", SequenceNumber: 2, Status: cycle.StatusCompleted, GoalBody: "v1", Plan: strings.Repeat("a", 30)},
			{ID: "cycle-1", GoalID: "goal-1", SequenceNumber: 1, Status: cycle.StatusCompleted, GoalBody: "v1", Plan: strings.Repeat("b", 30)},
		},
	}
	oneCycle := cloneAISnapshot(snapshot)
	oneCycle.PastCycles = oneCycle.PastCycles[:1]
	limit, err := service.countProviderInput(context.Background(), oneCycle)
	if err != nil {
		t.Fatal(err)
	}
	service.settings.MaxInputTokens = limit

	selected, err := service.selectAIContext(context.Background(), snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected.PastCycles) != 1 || selected.PastCycles[0].ID != "cycle-2" {
		t.Fatalf("selected cycles = %#v", selected.PastCycles)
	}
}

func TestSelectAIContextTruncatesOnlyProviderCopyWhenCurrentInputExceedsBudget(t *testing.T) {
	service := contextTestService()
	snapshot := AISnapshot{Operation: "goal_refine", SourceText: strings.Repeat("あ", 80), GoalBody: strings.Repeat("い", 80)}
	empty := snapshot
	empty.SourceText = ""
	empty.GoalBody = ""
	fixed, err := service.countProviderInput(context.Background(), empty)
	if err != nil {
		t.Fatal(err)
	}
	service.settings.MaxInputTokens = fixed + 20

	selected, err := service.selectAIContext(context.Background(), snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !selected.CurrentTruncated || selected.SourceText == snapshot.SourceText {
		t.Fatalf("selected snapshot was not truncated: %#v", selected)
	}
	if snapshot.SourceText != strings.Repeat("あ", 80) {
		t.Fatal("saved snapshot source was mutated")
	}
	count, err := service.countProviderInput(context.Background(), selected)
	if err != nil || count > service.settings.MaxInputTokens {
		t.Fatalf("selected token count/error = %d/%v", count, err)
	}
}

func TestSelectAIContextRejectsAnotherGoalBeforeProviderCall(t *testing.T) {
	service := contextTestService()
	_, err := service.selectAIContext(context.Background(), AISnapshot{
		Operation: "goal_refine", GoalID: "goal-1", SourceText: "draft",
		PastCycles: []AIContextCycle{{ID: "cycle-2", GoalID: "goal-2"}},
	})
	if !errors.Is(err, ErrAIContextIsolation) {
		t.Fatalf("error = %v", err)
	}
}
