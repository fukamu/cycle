package ai

import (
	"errors"
	"strings"
	"testing"

	"github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

func TestRenderGeneratedActions(t *testing.T) {
	t.Parallel()

	got, err := RenderGeneratedActions([]string{"最初", "次"})
	if err != nil {
		t.Fatal(err)
	}
	if got != "1. 最初\n\n2. 次" {
		t.Fatalf("rendered = %q", got)
	}
}

func TestRenderGeneratedActionsRejectsInvalidCountAndOversize(t *testing.T) {
	t.Parallel()

	if _, err := RenderGeneratedActions(nil); !errors.Is(err, ErrInvalidActionCount) {
		t.Fatalf("empty error = %v", err)
	}
	if _, err := RenderGeneratedActions([]string{"1", "2", "3", "4"}); !errors.Is(err, ErrInvalidActionCount) {
		t.Fatalf("four error = %v", err)
	}
	if _, err := RenderGeneratedActions([]string{strings.Repeat("長", cycle.MaxFrameCodePoints)}); !errors.Is(err, cycle.ErrFrameTooLong) {
		t.Fatalf("oversize error = %v", err)
	}
}

func TestValidateRefinedAction(t *testing.T) {
	t.Parallel()

	if _, err := ValidateRefinedAction(" \n\t "); !errors.Is(err, ErrInvalidActionText) {
		t.Fatalf("blank error = %v", err)
	}
	got, err := ValidateRefinedAction("具体的に試す")
	if err != nil || got != "具体的に試す" {
		t.Fatalf("ValidateRefinedAction() = %q, %v", got, err)
	}
}
