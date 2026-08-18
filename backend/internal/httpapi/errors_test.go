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
		{workspace.ErrGoalReviewNotFound, "GOAL_REVIEW_NOT_FOUND"},
	}
	for _, test := range tests {
		status, code, _ := classifyError(test.err)
		if status != 404 || code != test.code {
			t.Fatalf("%v classified as %d/%s", test.err, status, code)
		}
	}
}
