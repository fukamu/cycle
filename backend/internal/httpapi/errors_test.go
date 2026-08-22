package httpapi

import (
	"errors"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
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
		{workspace.ErrDraftTypeMismatch, 409, "GOAL_DRAFT_TYPE_MISMATCH"},
		{workspace.ErrGoalVersionConflict, 409, "GOAL_VERSION_CONFLICT"},
		{workspace.ErrGoalStateConflict, 409, "GOAL_STATE_CONFLICT"},
	}
	for _, test := range tests {
		status, code, _ := classifyError(test.err)
		if status != test.status || code != test.code {
			t.Fatalf("%v classified as %d/%s", test.err, status, code)
		}
	}
}

func TestClassifyErrorReportsCurrentTextLimits(t *testing.T) {
	tests := []struct {
		err     error
		code    string
		message string
	}{
		{goal.ErrTextTooLong, "GOAL_TEXT_TOO_LONG", "目標は80文字以内で入力してください。"},
		{cycle.ErrFrameTextTooLong, "FRAME_TEXT_TOO_LONG", "各項目は200文字以内で入力してください。"},
	}
	for _, test := range tests {
		status, code, message := classifyError(test.err)
		if status != 400 || code != test.code || message != test.message {
			t.Fatalf("%v classified as %d/%s/%s", test.err, status, code, message)
		}
	}
}

func TestErrorDetailsExposeOnlyRecoveryIdentifiers(t *testing.T) {
	if details := errorDetails(&workspace.DraftAlreadyExistsError{DraftID: "draft-id"}); details["draftId"] != "draft-id" {
		t.Fatalf("draft details = %#v", details)
	}
	if details := errorDetails(&workspace.AIOperationInProgressError{GenerationID: "generation-id"}); details["generationId"] != "generation-id" {
		t.Fatalf("AI details = %#v", details)
	}
}

func TestStableUseCaseErrorOnlyReclassifiesUnexpectedFailures(t *testing.T) {
	known := stableUseCaseError(workspace.ErrDraftRevisionConflict, errGoalDraftSaveFailed)
	if !errors.Is(known, workspace.ErrDraftRevisionConflict) {
		t.Fatalf("known error changed to %v", known)
	}
	unexpected := stableUseCaseError(errors.New("database unavailable"), errGoalDraftSaveFailed)
	status, code, _ := classifyError(unexpected)
	if status != 500 || code != "GOAL_DRAFT_SAVE_FAILED" {
		t.Fatalf("unexpected error classified as %d/%s", status, code)
	}
}
