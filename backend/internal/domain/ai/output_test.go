package ai

import (
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

func TestValidateGoalSuggestionCanonicalizesNewlinesAndPreservesWhitespace(t *testing.T) {
	t.Parallel()

	got, err := ValidateGoalSuggestion(" \t目標\r\nを改善\rする \t")
	if err != nil {
		t.Fatal(err)
	}
	if want := " \t目標\nを改善\nする \t"; got != want {
		t.Fatalf("suggestion = %q, want %q", got, want)
	}
}

func TestValidateGoalSuggestionBoundaries(t *testing.T) {
	t.Parallel()

	atLimit := strings.Repeat("🌱", goal.MaxGoalCodePoints)
	if got, err := ValidateGoalSuggestion(atLimit); err != nil || got != atLimit {
		t.Fatalf("80-code-point suggestion = %q, %v", got, err)
	}
	if got, err := ValidateGoalSuggestion(atLimit + "🌱"); !errors.Is(err, goal.ErrTextTooLong) || got != "" {
		t.Fatalf("81-code-point suggestion = %q, %v", got, err)
	}
}

func TestValidateGoalSuggestionRejectsBlankAndControlCharacters(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name  string
		value string
	}{
		{name: "blank", value: " \n\t "},
		{name: "NUL", value: "目\x00標"},
		{name: "C0", value: "目\x01標"},
		{name: "DEL", value: "目\x7f標"},
		{name: "C1", value: "目\u0085標"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := ValidateGoalSuggestion(test.value); !errors.Is(err, ErrInvalidGoalSuggestion) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestRenderGeneratedActions(t *testing.T) {
	t.Parallel()

	got, err := RenderGeneratedActions([]string{" \t最初\r\nの行動 \t", "\r次\r\n"})
	if err != nil {
		t.Fatal(err)
	}
	if got != "1. 最初\nの行動\n\n2. 次" {
		t.Fatalf("rendered = %q", got)
	}
}

func TestRenderGeneratedActionsBoundaries(t *testing.T) {
	t.Parallel()

	atLimit := strings.Repeat("🌱", cycle.MaxFrameCodePoints-len("1. "))
	want := "1. " + atLimit
	if got, err := RenderGeneratedActions([]string{atLimit}); err != nil || got != want {
		t.Fatalf("200-code-point generated action = %q, %v", got, err)
	}
	if got, err := RenderGeneratedActions([]string{atLimit + "🌱"}); !errors.Is(err, cycle.ErrFrameTextTooLong) || got != "" {
		t.Fatalf("201-code-point generated action = %q, %v", got, err)
	}
}

func TestRenderGeneratedActionsRejectsInvalidCountTextAndControlCharacters(t *testing.T) {
	t.Parallel()

	if got, err := RenderGeneratedActions([]string{"一", "二", "三"}); err != nil || got != "1. 一\n\n2. 二\n\n3. 三" {
		t.Fatalf("three actions = %q, %v", got, err)
	}
	if _, err := RenderGeneratedActions(nil); !errors.Is(err, ErrInvalidActionCount) {
		t.Fatalf("empty error = %v", err)
	}
	if _, err := RenderGeneratedActions([]string{"1", "2", "3", "4"}); !errors.Is(err, ErrInvalidActionCount) {
		t.Fatalf("four error = %v", err)
	}
	for _, value := range []string{" \n\t ", "行\x00動", "行\x01動", "行\x7f動", "行\u0085動"} {
		if _, err := RenderGeneratedActions([]string{value}); !errors.Is(err, ErrInvalidActionText) {
			t.Fatalf("value %q error = %v", value, err)
		}
	}
}

func TestValidateRefinedActionCanonicalizesNewlinesAndPreservesWhitespace(t *testing.T) {
	t.Parallel()

	got, err := ValidateRefinedAction(" \t具体的に\r\n試す\r \t")
	if err != nil || got != " \t具体的に\n試す\n \t" {
		t.Fatalf("ValidateRefinedAction() = %q, %v", got, err)
	}
}

func TestValidateRefinedActionBoundaries(t *testing.T) {
	t.Parallel()

	atLimit := strings.Repeat("🌱", cycle.MaxFrameCodePoints)
	if got, err := ValidateRefinedAction(atLimit); err != nil || got != atLimit {
		t.Fatalf("200-code-point refined action = %q, %v", got, err)
	}
	if got, err := ValidateRefinedAction(atLimit + "🌱"); !errors.Is(err, cycle.ErrFrameTextTooLong) || got != "" {
		t.Fatalf("201-code-point refined action = %q, %v", got, err)
	}
}

func TestValidateRefinedActionRejectsBlankAndControlCharacters(t *testing.T) {
	t.Parallel()

	for _, value := range []string{" \n\t ", "行\x00動", "行\x01動", "行\x7f動", "行\u0085動"} {
		if _, err := ValidateRefinedAction(value); !errors.Is(err, ErrInvalidActionText) {
			t.Fatalf("value %q error = %v", value, err)
		}
	}
}
