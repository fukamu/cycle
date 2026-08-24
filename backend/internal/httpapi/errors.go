package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"go.opentelemetry.io/otel/trace"

	"github.com/fukamu/cycle/backend/internal/application/account"
	"github.com/fukamu/cycle/backend/internal/application/ports"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type errorEnvelope struct {
	Error apiError `json:"error"`
}
type apiError struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	RequestID string         `json:"requestId"`
	Details   map[string]any `json:"details,omitempty"`
}

var (
	errSessionIdentityChanged    = errors.New("authenticated session identity changed")
	errAccountUpgradeFailed      = errors.New("account upgrade failed")
	errGoogleLoginFailed         = errors.New("google login failed")
	errGoalDraftSaveFailed       = errors.New("goal draft save failed")
	errGoalDraftDeleteFailed     = errors.New("goal draft delete failed")
	errGoalStartFailed           = errors.New("goal start failed")
	errFrameSaveFailed           = errors.New("frame save failed")
	errCycleCompletionFailed     = errors.New("cycle completion failed")
	errGoalReviewDraftSaveFailed = errors.New("goal review draft save failed")
	errGoalReviewContinueFailed  = errors.New("goal review continue failed")
	errGoalTerminationFailed     = errors.New("goal termination failed")
	errGoalDeleteFailed          = errors.New("goal delete failed")
)

func (server *api) writeError(writer http.ResponseWriter, request *http.Request, err error, details map[string]any) {
	status, code, message := classifyError(err)
	if details == nil {
		details = errorDetails(err)
	}
	if server.dependencies.Metrics != nil {
		if errors.Is(err, workspace.ErrAIContextIsolation) {
			server.dependencies.Metrics.AIContextIsolationViolation(request.Context())
		}
		server.dependencies.Metrics.ErrorCode(request.Context(), code)
	}
	if server.dependencies.Logger != nil {
		level := slog.LevelWarn
		if status >= 500 {
			level = slog.LevelError
		}
		server.dependencies.Logger.LogAttrs(request.Context(), level, "api error",
			slog.String("request_id", requestID(request.Context())),
			slog.String("trace_id", trace.SpanFromContext(request.Context()).SpanContext().TraceID().String()),
			slog.String("error_code", code), slog.Int("status_code", status))
	}
	writeJSON(writer, status, errorEnvelope{Error: apiError{Code: code, Message: message, RequestID: requestID(request.Context()), Details: details}})
}

func classifyError(err error) (int, string, string) {
	switch {
	case errors.Is(err, errRequestValidation), errors.Is(err, workspace.ErrInvalidTerminationRequest):
		return 400, "VALIDATION_ERROR", "入力内容を確認してください。"
	case errors.Is(err, appsession.ErrSessionMissing):
		return 401, "SESSION_MISSING", "セッションがありません。"
	case errors.Is(err, errSessionIdentityChanged):
		return 409, "SESSION_IDENTITY_CHANGED", "セッションの利用者が変更されています。ページを再読み込みしてください。"
	case errors.Is(err, appsession.ErrSessionExpired):
		return 401, "SESSION_EXPIRED", "セッションが切れました。入力内容は保持されています。"
	case errors.Is(err, appsession.ErrCSRFInvalid):
		return 403, "CSRF_INVALID", "ページを再読み込みして、もう一度お試しください。"
	case errors.Is(err, appsession.ErrBootstrapID):
		return 400, "VALIDATION_ERROR", "入力内容を確認してください。"
	case errors.Is(err, ports.ErrAnonymousCreationBlocked):
		return 403, "ANONYMOUS_CREATION_BLOCKED", "時間を空けてもう一度お試しください。"
	case errors.Is(err, ports.ErrAntiAbuseUnavailable):
		return 503, "ANTI_ABUSE_SERVICE_UNAVAILABLE", "現在、新しい利用を開始できません。"
	case errors.Is(err, goal.ErrTextRequired):
		return 400, "GOAL_TEXT_REQUIRED", "目標を入力してください。"
	case errors.Is(err, goal.ErrTextTooLong):
		return 400, "GOAL_TEXT_TOO_LONG", "目標は80文字以内で入力してください。"
	case errors.Is(err, cycle.ErrFrameTextTooLong):
		return 400, "FRAME_TEXT_TOO_LONG", "各項目は200文字以内で入力してください。"
	case errors.Is(err, goal.ErrForbiddenCharacter), errors.Is(err, cycle.ErrForbiddenCharacter), errors.Is(err, cycle.ErrInvalidFrame):
		return 400, "VALIDATION_ERROR", "入力内容を確認してください。"
	case errors.Is(err, workspace.ErrGoalDraftNotFound):
		return 404, "GOAL_DRAFT_NOT_FOUND", "目標の下書きが見つかりません。"
	case errors.Is(err, workspace.ErrCycleNotFound):
		return 404, "CYCLE_NOT_FOUND", "サイクルが見つかりません。"
	case errors.Is(err, workspace.ErrGoalNotFound), errors.Is(err, workspace.ErrNotFound):
		return 404, "GOAL_NOT_FOUND", "対象が見つかりません。"
	case errors.Is(err, workspace.ErrDraftAlreadyExists):
		return 409, "GOAL_CREATION_DRAFT_ALREADY_EXISTS", "目標の下書きはすでにあります。"
	case errors.Is(err, workspace.ErrDraftTypeMismatch):
		return 409, "GOAL_DRAFT_TYPE_MISMATCH", "正しい目標画面を開き直してください。"
	case errors.Is(err, workspace.ErrDraftRevisionConflict):
		return 409, "GOAL_DRAFT_REVISION_CONFLICT", "別の保存が先に反映されています。入力内容は保持されています。"
	case errors.Is(err, workspace.ErrReviewRevisionConflict):
		return 409, "GOAL_REVIEW_DRAFT_REVISION_CONFLICT", "別の保存が先に反映されています。入力内容は保持されています。"
	case errors.Is(err, workspace.ErrGoalRevisionConflict):
		return 409, "GOAL_VERSION_CONFLICT", "目標の状態が更新されています。"
	case errors.Is(err, workspace.ErrGoalActiveLimit):
		return 409, "GOAL_ACTIVE_LIMIT_EXCEEDED", "取り組んでいる目標が上限に達しています。いずれかの目標を達成・終了・削除してください。"
	case errors.Is(err, workspace.ErrGoalReviewNotActive):
		return 409, "GOAL_REVIEW_NOT_ACTIVE", "目標の見直し画面を開き直してください。"
	case errors.Is(err, workspace.ErrGoalReviewInvariant):
		return 500, "GOAL_REVIEW_INVARIANT_BROKEN", "目標の見直し状態を確認できませんでした。"
	case errors.Is(err, workspace.ErrGoalVersionConflict):
		return 409, "GOAL_VERSION_CONFLICT", "目標の版が更新されています。"
	case errors.Is(err, workspace.ErrGoalStateConflict):
		return 409, "GOAL_STATE_CONFLICT", "目標の状態が更新されています。"
	case errors.Is(err, workspace.ErrGoalAlreadyTerminal):
		return 409, "GOAL_ALREADY_TERMINAL", "この目標は終了しています。"
	case errors.Is(err, workspace.ErrInvalidGoalOutcome):
		return 400, "INVALID_GOAL_OUTCOME", "目標の終了方法を確認してください。"
	case errors.Is(err, workspace.ErrDeleteConfirmation):
		return 400, "GOAL_DELETE_CONFIRMATION_REQUIRED", "目標削除の確認が必要です。"
	case errors.Is(err, workspace.ErrDeleteConflict):
		return 409, "GOAL_DELETE_CONFLICT", "目標が更新されています。再確認してください。"
	case errors.Is(err, workspace.ErrDiscardConfirmation):
		return 400, "GOAL_REVIEW_DISCARD_CONFIRMATION_REQUIRED", "変更案を破棄する確認が必要です。"
	case errors.Is(err, cycle.ErrCycleNotActive):
		return 409, "CYCLE_NOT_ACTIVE", "このサイクルは編集できません。"
	case errors.Is(err, cycle.ErrRevisionConflict):
		return 409, "CYCLE_REVISION_CONFLICT", "別の保存が先に反映されています。入力内容は保持されています。"
	case errors.Is(err, cycle.ErrCycleIncomplete):
		return 400, "CYCLE_COMPLETION_INPUT_INCOMPLETE", "P/D/C/Aをすべて入力してください。"
	case errors.Is(err, workspace.ErrAIInProgress), errors.Is(err, cycle.ErrAIOperationRunning):
		return 409, "AI_OPERATION_IN_PROGRESS", "AI処理の完了をお待ちください。"
	case errors.Is(err, workspace.ErrGoalRefineInputEmpty):
		return 400, "GOAL_REFINE_INPUT_EMPTY", "目標を入力してから実行してください。"
	case errors.Is(err, workspace.ErrActionGenerateInputIncomplete):
		return 400, "ACTION_GENERATE_INPUT_INCOMPLETE", "P/D/Cを保存してから実行してください。"
	case errors.Is(err, workspace.ErrActionRefineInputIncomplete):
		return 400, "ACTION_REFINE_INPUT_INCOMPLETE", "P/D/C/Aを保存してから実行してください。"
	case errors.Is(err, workspace.ErrAIReplacementRequired):
		return 409, "ACTION_REPLACEMENT_CONFIRMATION_REQUIRED", "現在のアクションを置き換える確認が必要です。"
	case errors.Is(err, workspace.ErrAIContextStale):
		return 409, "GOAL_REFINE_CONTEXT_STALE", "下書きが変更されたため、この提案は採用できません。"
	case errors.Is(err, workspace.ErrAISuggestionNotFound):
		return 404, "AI_SUGGESTION_NOT_FOUND", "AIの提案が見つかりません。"
	case errors.Is(err, workspace.ErrAIResultAlreadyAdopted):
		return 409, "GOAL_REFINE_RESULT_ALREADY_ADOPTED", "この提案はすでに採用されています。"
	case errors.Is(err, workspace.ErrAIUserLimit):
		return 429, "AI_USER_ROLLING_LIMIT_EXCEEDED", "直近24時間のAI利用上限に達しました。"
	case errors.Is(err, workspace.ErrAIRateLimit):
		return 429, "AI_RATE_LIMIT_EXCEEDED", "短時間のAI利用が続いています。"
	case errors.Is(err, workspace.ErrAIBudget):
		return 503, "AI_SERVICE_BUDGET_EXCEEDED", "現在AI機能を一時停止しています。"
	case errors.Is(err, workspace.ErrAIInvalidResponse):
		return 502, "AI_INVALID_RESPONSE", "AIの応答を確認できませんでした。"
	case errors.Is(err, workspace.ErrAIProviderTimeout):
		return 504, "AI_PROVIDER_TIMEOUT", "AI処理が時間内に完了しませんでした。"
	case errors.Is(err, workspace.ErrAIProviderRejected), errors.Is(err, workspace.ErrAIProviderUnavailable):
		return 503, "AI_PROVIDER_UNAVAILABLE", "AIサービスに接続できません。"
	case errors.Is(err, workspace.ErrIdempotencyKeyReused):
		return 409, "IDEMPOTENCY_KEY_REUSED", "同じ操作IDを別の内容には使用できません。"
	case errors.Is(err, workspace.ErrInvalidCursor):
		return 400, "INVALID_CURSOR", "一覧を先頭から読み込み直してください。"
	case errors.Is(err, account.ErrGoogleTokenInvalid):
		return 400, "GOOGLE_ID_TOKEN_INVALID", "Googleアカウントを確認できませんでした。"
	case errors.Is(err, account.ErrGoogleIdentityLinked):
		return 409, "GOOGLE_IDENTITY_ALREADY_LINKED", "このGoogleアカウントは別のアカウントに接続されています。"
	case errors.Is(err, account.ErrGoogleAccountNotLinked):
		return 404, "GOOGLE_ACCOUNT_NOT_LINKED", "接続されたアカウントはありません。"
	case errors.Is(err, account.ErrGoogleVerificationFailed):
		return 503, "GOOGLE_IDENTITY_VERIFICATION_UNAVAILABLE", "Googleアカウントを確認できません。"
	case errors.Is(err, account.ErrDeleteConfirmationRequired):
		return 400, "ACCOUNT_DELETE_CONFIRMATION_REQUIRED", "アカウント削除の確認が必要です。"
	case errors.Is(err, errAccountUpgradeFailed):
		return 500, "ACCOUNT_UPGRADE_FAILED", "アカウントを接続できませんでした。匿名アカウントは維持されています。"
	case errors.Is(err, errGoogleLoginFailed):
		return 500, "GOOGLE_LOGIN_FAILED", "ログインできませんでした。現在のセッションは維持されています。"
	case errors.Is(err, errGoalDraftSaveFailed):
		return 500, "GOAL_DRAFT_SAVE_FAILED", "目標の下書きを保存できませんでした。入力内容は保持されています。"
	case errors.Is(err, errGoalDraftDeleteFailed):
		return 500, "GOAL_DRAFT_DELETE_FAILED", "目標の下書きを削除できませんでした。"
	case errors.Is(err, errGoalStartFailed):
		return 500, "GOAL_START_FAILED", "目標を開始できませんでした。下書きは維持されています。"
	case errors.Is(err, errFrameSaveFailed):
		return 500, "FRAME_SAVE_FAILED", "入力内容を保存できませんでした。"
	case errors.Is(err, errCycleCompletionFailed):
		return 500, "CYCLE_COMPLETION_FAILED", "サイクルを完了できませんでした。"
	case errors.Is(err, errGoalReviewDraftSaveFailed):
		return 500, "GOAL_REVIEW_DRAFT_SAVE_FAILED", "目標の見直し案を保存できませんでした。"
	case errors.Is(err, errGoalReviewContinueFailed):
		return 500, "GOAL_REVIEW_CONTINUE_FAILED", "次のサイクルを開始できませんでした。見直し案は維持されています。"
	case errors.Is(err, errGoalTerminationFailed):
		return 500, "GOAL_TERMINATION_FAILED", "目標を終了できませんでした。"
	case errors.Is(err, errGoalDeleteFailed):
		return 500, "GOAL_DELETE_FAILED", "目標を削除できませんでした。"
	case errors.Is(err, account.ErrAccountDeleteFailed):
		return 500, "ACCOUNT_DELETE_FAILED", "アカウントを削除できませんでした。データは保持されています。"
	default:
		return 500, "INTERNAL_ERROR", "処理中にエラーが発生しました。もう一度お試しください。"
	}
}

func errorDetails(err error) map[string]any {
	var draftConflict *workspace.DraftAlreadyExistsError
	if errors.As(err, &draftConflict) && draftConflict.DraftID != "" {
		return map[string]any{"draftId": draftConflict.DraftID}
	}
	var aiRunning *workspace.AIOperationInProgressError
	if errors.As(err, &aiRunning) && aiRunning.GenerationID != "" {
		return map[string]any{"generationId": aiRunning.GenerationID}
	}
	var incomplete *workspace.CycleCompletionIncompleteError
	if errors.As(err, &incomplete) {
		missingFrames := make([]string, len(incomplete.MissingFrames))
		for index, frame := range incomplete.MissingFrames {
			missingFrames[index] = string(frame)
		}
		return map[string]any{"missingFrames": missingFrames}
	}
	return nil
}

func stableUseCaseError(err, fallback error) error {
	status, code, _ := classifyError(err)
	if status == http.StatusInternalServerError && code == "INTERNAL_ERROR" {
		return fallback
	}
	return err
}
