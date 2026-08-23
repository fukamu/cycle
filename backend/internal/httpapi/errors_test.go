package httpapi

import (
	"errors"
	"fmt"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/account"
	"github.com/fukamu/cycle/backend/internal/application/ports"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
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

func TestClassifyErrorMatchesPublicStatusCodeMatrix(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"request validation", errRequestValidation, 400, "VALIDATION_ERROR"},
		{"session missing", appsession.ErrSessionMissing, 401, "SESSION_MISSING"},
		{"session expired", appsession.ErrSessionExpired, 401, "SESSION_EXPIRED"},
		{"csrf invalid", appsession.ErrCSRFInvalid, 403, "CSRF_INVALID"},
		{"bootstrap ID", appsession.ErrBootstrapID, 400, "VALIDATION_ERROR"},
		{"anonymous blocked", ports.ErrAnonymousCreationBlocked, 403, "ANONYMOUS_CREATION_BLOCKED"},
		{"anti-abuse unavailable", ports.ErrAntiAbuseUnavailable, 503, "ANTI_ABUSE_SERVICE_UNAVAILABLE"},
		{"goal text required", goal.ErrTextRequired, 400, "GOAL_TEXT_REQUIRED"},
		{"goal text too long", goal.ErrTextTooLong, 400, "GOAL_TEXT_TOO_LONG"},
		{"frame text too long", cycle.ErrFrameTextTooLong, 400, "FRAME_TEXT_TOO_LONG"},
		{"goal forbidden character", goal.ErrForbiddenCharacter, 400, "VALIDATION_ERROR"},
		{"cycle forbidden character", cycle.ErrForbiddenCharacter, 400, "VALIDATION_ERROR"},
		{"invalid frame", cycle.ErrInvalidFrame, 400, "VALIDATION_ERROR"},
		{"draft not found", workspace.ErrGoalDraftNotFound, 404, "GOAL_DRAFT_NOT_FOUND"},
		{"cycle not found", workspace.ErrCycleNotFound, 404, "CYCLE_NOT_FOUND"},
		{"goal not found", workspace.ErrGoalNotFound, 404, "GOAL_NOT_FOUND"},
		{"generic owner not found", workspace.ErrNotFound, 404, "GOAL_NOT_FOUND"},
		{"draft exists", workspace.ErrDraftAlreadyExists, 409, "GOAL_CREATION_DRAFT_ALREADY_EXISTS"},
		{"draft type", workspace.ErrDraftTypeMismatch, 409, "GOAL_DRAFT_TYPE_MISMATCH"},
		{"draft revision", workspace.ErrDraftRevisionConflict, 409, "GOAL_DRAFT_REVISION_CONFLICT"},
		{"review revision", workspace.ErrReviewRevisionConflict, 409, "GOAL_REVIEW_DRAFT_REVISION_CONFLICT"},
		{"goal revision", workspace.ErrGoalRevisionConflict, 409, "GOAL_VERSION_CONFLICT"},
		{"goal version", workspace.ErrGoalVersionConflict, 409, "GOAL_VERSION_CONFLICT"},
		{"goal active limit", workspace.ErrGoalActiveLimit, 409, "GOAL_ACTIVE_LIMIT_EXCEEDED"},
		{"review inactive", workspace.ErrGoalReviewNotActive, 409, "GOAL_REVIEW_NOT_ACTIVE"},
		{"review invariant", workspace.ErrGoalReviewInvariant, 500, "GOAL_REVIEW_INVARIANT_BROKEN"},
		{"goal state", workspace.ErrGoalStateConflict, 409, "GOAL_STATE_CONFLICT"},
		{"goal terminal", workspace.ErrGoalAlreadyTerminal, 409, "GOAL_ALREADY_TERMINAL"},
		{"invalid outcome", workspace.ErrInvalidGoalOutcome, 400, "INVALID_GOAL_OUTCOME"},
		{"goal delete confirmation", workspace.ErrDeleteConfirmation, 400, "GOAL_DELETE_CONFIRMATION_REQUIRED"},
		{"goal delete conflict", workspace.ErrDeleteConflict, 409, "GOAL_DELETE_CONFLICT"},
		{"review discard", workspace.ErrDiscardConfirmation, 400, "GOAL_REVIEW_DISCARD_CONFIRMATION_REQUIRED"},
		{"cycle inactive", cycle.ErrCycleNotActive, 409, "CYCLE_NOT_ACTIVE"},
		{"cycle revision", cycle.ErrRevisionConflict, 409, "CYCLE_REVISION_CONFLICT"},
		{"cycle incomplete", cycle.ErrCycleIncomplete, 400, "CYCLE_COMPLETION_INPUT_INCOMPLETE"},
		{"AI running workspace", workspace.ErrAIInProgress, 409, "AI_OPERATION_IN_PROGRESS"},
		{"AI running cycle", cycle.ErrAIOperationRunning, 409, "AI_OPERATION_IN_PROGRESS"},
		{"goal refine input", workspace.ErrGoalRefineInputEmpty, 400, "GOAL_REFINE_INPUT_EMPTY"},
		{"action generate input", workspace.ErrActionGenerateInputIncomplete, 400, "ACTION_GENERATE_INPUT_INCOMPLETE"},
		{"action refine input", workspace.ErrActionRefineInputIncomplete, 400, "ACTION_REFINE_INPUT_INCOMPLETE"},
		{"action replacement", workspace.ErrAIReplacementRequired, 409, "ACTION_REPLACEMENT_CONFIRMATION_REQUIRED"},
		{"goal refine stale", workspace.ErrAIContextStale, 409, "GOAL_REFINE_CONTEXT_STALE"},
		{"AI suggestion missing", workspace.ErrAISuggestionNotFound, 404, "AI_SUGGESTION_NOT_FOUND"},
		{"AI adopted", workspace.ErrAIResultAlreadyAdopted, 409, "GOAL_REFINE_RESULT_ALREADY_ADOPTED"},
		{"AI user quota", workspace.ErrAIUserLimit, 429, "AI_USER_ROLLING_LIMIT_EXCEEDED"},
		{"AI rate", workspace.ErrAIRateLimit, 429, "AI_RATE_LIMIT_EXCEEDED"},
		{"AI budget", workspace.ErrAIBudget, 503, "AI_SERVICE_BUDGET_EXCEEDED"},
		{"AI invalid response", workspace.ErrAIInvalidResponse, 502, "AI_INVALID_RESPONSE"},
		{"AI timeout", workspace.ErrAIProviderTimeout, 504, "AI_PROVIDER_TIMEOUT"},
		{"AI unavailable", workspace.ErrAIProviderUnavailable, 503, "AI_PROVIDER_UNAVAILABLE"},
		{"idempotency reuse", workspace.ErrIdempotencyKeyReused, 409, "IDEMPOTENCY_KEY_REUSED"},
		{"invalid cursor", workspace.ErrInvalidCursor, 400, "INVALID_CURSOR"},
		{"Google token", account.ErrGoogleTokenInvalid, 400, "GOOGLE_ID_TOKEN_INVALID"},
		{"Google linked", account.ErrGoogleIdentityLinked, 409, "GOOGLE_IDENTITY_ALREADY_LINKED"},
		{"Google not linked", account.ErrGoogleAccountNotLinked, 404, "GOOGLE_ACCOUNT_NOT_LINKED"},
		{"Google unavailable", account.ErrGoogleVerificationFailed, 503, "GOOGLE_IDENTITY_VERIFICATION_UNAVAILABLE"},
		{"account confirmation", account.ErrDeleteConfirmationRequired, 400, "ACCOUNT_DELETE_CONFIRMATION_REQUIRED"},
		{"account upgrade fallback", errAccountUpgradeFailed, 500, "ACCOUNT_UPGRADE_FAILED"},
		{"Google login fallback", errGoogleLoginFailed, 500, "GOOGLE_LOGIN_FAILED"},
		{"draft save fallback", errGoalDraftSaveFailed, 500, "GOAL_DRAFT_SAVE_FAILED"},
		{"draft delete fallback", errGoalDraftDeleteFailed, 500, "GOAL_DRAFT_DELETE_FAILED"},
		{"goal start fallback", errGoalStartFailed, 500, "GOAL_START_FAILED"},
		{"frame save fallback", errFrameSaveFailed, 500, "FRAME_SAVE_FAILED"},
		{"cycle complete fallback", errCycleCompletionFailed, 500, "CYCLE_COMPLETION_FAILED"},
		{"review save fallback", errGoalReviewDraftSaveFailed, 500, "GOAL_REVIEW_DRAFT_SAVE_FAILED"},
		{"review continue fallback", errGoalReviewContinueFailed, 500, "GOAL_REVIEW_CONTINUE_FAILED"},
		{"goal termination fallback", errGoalTerminationFailed, 500, "GOAL_TERMINATION_FAILED"},
		{"goal delete fallback", errGoalDeleteFailed, 500, "GOAL_DELETE_FAILED"},
		{"account delete fallback", account.ErrAccountDeleteFailed, 500, "ACCOUNT_DELETE_FAILED"},
		{"unexpected", errors.New("storage secret"), 500, "INTERNAL_ERROR"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, code, _ := classifyError(fmt.Errorf("wrapped: %w", test.err))
			if status != test.status || code != test.code {
				t.Fatalf("classifyError(%v) = %d/%s, want %d/%s", test.err, status, code, test.status, test.code)
			}
		})
	}
}
