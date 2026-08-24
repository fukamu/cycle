package httpapi

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

func TestCycleCompletionIncompleteErrorContract(t *testing.T) {
	err := fmt.Errorf("complete Cycle: %w", &workspace.CycleCompletionIncompleteError{
		MissingFrames: []cycle.Frame{
			cycle.FramePlan,
			cycle.FrameDo,
			cycle.FrameCheck,
			cycle.FrameAction,
		},
	})

	stable := stableUseCaseError(err, errCycleCompletionFailed)
	status, code, _ := classifyError(stable)
	if status != 400 || code != "CYCLE_COMPLETION_INPUT_INCOMPLETE" {
		t.Fatalf("classifyError() = %d/%s, want 400/CYCLE_COMPLETION_INPUT_INCOMPLETE", status, code)
	}
	want := map[string]any{"missingFrames": []string{"plan", "do", "check", "action"}}
	if details := errorDetails(stable); !reflect.DeepEqual(details, want) {
		t.Fatalf("errorDetails() = %#v, want %#v", details, want)
	}
}

func TestCycleCompletionErrorPrecedenceSurvivesStableFallback(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"goal not found", workspace.ErrGoalNotFound, 404, "GOAL_NOT_FOUND"},
		{"cycle not found", workspace.ErrCycleNotFound, 404, "CYCLE_NOT_FOUND"},
		{"stale Goal revision", workspace.ErrGoalRevisionConflict, 409, "GOAL_VERSION_CONFLICT"},
		{"Goal state mismatch", workspace.ErrGoalStateConflict, 409, "GOAL_STATE_CONFLICT"},
		{"Cycle revision mismatch", cycle.ErrRevisionConflict, 409, "CYCLE_REVISION_CONFLICT"},
		{"AI operation running", cycle.ErrAIOperationRunning, 409, "AI_OPERATION_IN_PROGRESS"},
		{"idempotency key reused", workspace.ErrIdempotencyKeyReused, 409, "IDEMPOTENCY_KEY_REUSED"},
		{"unexpected failure", errors.New("storage unavailable"), 500, "CYCLE_COMPLETION_FAILED"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stable := stableUseCaseError(fmt.Errorf("complete Cycle: %w", test.err), errCycleCompletionFailed)
			status, code, _ := classifyError(stable)
			if status != test.status || code != test.code {
				t.Fatalf("classifyError() = %d/%s, want %d/%s", status, code, test.status, test.code)
			}
		})
	}
}
