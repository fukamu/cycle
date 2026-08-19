package httpapi

import (
	"testing"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
)

func TestClassifyErrorKeepsResourceSpecificNotFoundCodes(t *testing.T) {
	tests := []struct {
		err  error
		code string
	}{
		{workspace.ErrGoalDraftNotFound, "GOAL_DRAFT_NOT_FOUND"},
		{workspace.ErrGoalNotFound, "GOAL_NOT_FOUND"},
		{workspace.ErrCycleNotFound, "CYCLE_NOT_FOUND"},
	}
	for _, test := range tests {
		status, code, _ := classifyError(test.err)
		if status != 404 || code != test.code {
			t.Fatalf("%v classified as %d/%s", test.err, status, code)
		}
	}
}

func TestClassifyErrorUsesStableReviewAndAIContractCodes(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{workspace.ErrGoalReviewInvariant, 500, "GOAL_REVIEW_INVARIANT_BROKEN"},
		{workspace.ErrGoalRefineInputEmpty, 400, "GOAL_REFINE_INPUT_EMPTY"},
		{workspace.ErrActionGenerateInputIncomplete, 400, "ACTION_GENERATE_INPUT_INCOMPLETE"},
		{workspace.ErrActionRefineInputIncomplete, 400, "ACTION_REFINE_INPUT_INCOMPLETE"},
	}
	for _, test := range tests {
		status, code, _ := classifyError(test.err)
		if status != test.status || code != test.code {
			t.Fatalf("%v classified as %d/%s", test.err, status, code)
		}
	}
}
