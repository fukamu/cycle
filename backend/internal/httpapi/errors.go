package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/matoruru/PDCAI/backend/internal/application/account"
	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	appcycle "github.com/matoruru/PDCAI/backend/internal/application/cycle"
	"github.com/matoruru/PDCAI/backend/internal/application/ports"
	appsession "github.com/matoruru/PDCAI/backend/internal/application/session"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
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

func (server *api) writeError(writer http.ResponseWriter, request *http.Request, err error, details map[string]any) {
	status, code, message := classifyError(err)
	if server.dependencies.Logger != nil {
		level := slog.LevelWarn
		if status >= http.StatusInternalServerError {
			level = slog.LevelError
		}
		server.dependencies.Logger.LogAttrs(request.Context(), level, "api error",
			slog.String("request_id", requestID(request.Context())), slog.String("error_code", code), slog.Int("status_code", status))
	}
	writeJSON(writer, status, errorEnvelope{Error: apiError{
		Code: code, Message: message, RequestID: requestID(request.Context()), Details: details,
	}})
}

func classifyError(err error) (int, string, string) {
	switch {
	case errors.Is(err, appsession.ErrSessionMissing):
		return http.StatusUnauthorized, "SESSION_MISSING", "セッションがありません。"
	case errors.Is(err, appsession.ErrSessionExpired):
		return http.StatusUnauthorized, "SESSION_EXPIRED", "セッションが切れました。入力内容は保持されています。"
	case errors.Is(err, appsession.ErrCSRFInvalid):
		return http.StatusForbidden, "CSRF_INVALID", "ページを再読み込みして、もう一度お試しください。"
	case errors.Is(err, account.ErrGoogleTokenInvalid):
		return http.StatusBadRequest, "GOOGLE_ID_TOKEN_INVALID", "Googleアカウントを確認できませんでした。"
	case errors.Is(err, account.ErrGoogleIdentityLinked):
		return http.StatusConflict, "GOOGLE_IDENTITY_ALREADY_LINKED", "このGoogleアカウントは別のPDCAIアカウントに接続されています。"
	case errors.Is(err, account.ErrGoogleAccountNotLinked):
		return http.StatusNotFound, "GOOGLE_ACCOUNT_NOT_LINKED", "このGoogleアカウントに接続されたPDCAIアカウントはありません。"
	case errors.Is(err, account.ErrGoogleVerificationFailed):
		return http.StatusServiceUnavailable, "GOOGLE_IDENTITY_VERIFICATION_UNAVAILABLE", "Googleアカウントを確認できません。もう一度お試しください。"
	case errors.Is(err, account.ErrAccountUpgradeFailed):
		return http.StatusInternalServerError, "ACCOUNT_UPGRADE_FAILED", "アカウントを接続できませんでした。匿名データは保持されています。"
	case errors.Is(err, account.ErrGoogleLoginFailed):
		return http.StatusInternalServerError, "GOOGLE_LOGIN_FAILED", "Googleアカウントでログインできませんでした。"
	case errors.Is(err, account.ErrDeleteConfirmationRequired):
		return http.StatusBadRequest, "ACCOUNT_DELETE_CONFIRMATION_REQUIRED", "アカウント削除の確認が必要です。"
	case errors.Is(err, account.ErrAccountDeleteFailed):
		return http.StatusInternalServerError, "ACCOUNT_DELETE_FAILED", "アカウントを削除できませんでした。データは保持されています。"
	case errors.Is(err, appsession.ErrBootstrapID), errors.Is(err, domaincycle.ErrInvalidFrame), errors.Is(err, domaincycle.ErrInvalidText), errors.Is(err, domaincycle.ErrFrameTooLong), errors.Is(err, domaincycle.ErrInvalidTransition):
		return http.StatusBadRequest, "VALIDATION_ERROR", "入力内容を確認してください。"
	case errors.Is(err, ports.ErrAnonymousCreationBlocked):
		return http.StatusForbidden, "ANONYMOUS_CREATION_BLOCKED", "時間を空けてもう一度お試しください。"
	case errors.Is(err, ports.ErrAntiAbuseUnavailable):
		return http.StatusServiceUnavailable, "ANTI_ABUSE_SERVICE_UNAVAILABLE", "現在、新しい利用を開始できません。しばらくしてからお試しください。"
	case errors.Is(err, appcycle.ErrCycleNotFound):
		return http.StatusNotFound, "CYCLE_NOT_FOUND", "サイクルが見つかりません。"
	case errors.Is(err, appai.ErrTargetGone):
		return http.StatusNotFound, "CYCLE_NOT_FOUND", "サイクルが見つかりません。"
	case errors.Is(err, appcycle.ErrCycleNotCompleted):
		return http.StatusConflict, "CYCLE_NOT_COMPLETED", "このサイクルはまだ完了していません。"
	case errors.Is(err, appcycle.ErrInvalidCursor):
		return http.StatusBadRequest, "INVALID_CURSOR", "一覧を先頭から読み込み直してください。"
	case errors.Is(err, appcycle.ErrInvalidPageLimit):
		return http.StatusBadRequest, "VALIDATION_ERROR", "取得件数を確認してください。"
	case errors.Is(err, domaincycle.ErrCycleNotActive):
		return http.StatusConflict, "CYCLE_NOT_ACTIVE", "現在のサイクルを読み込み直してください。"
	case errors.Is(err, domaincycle.ErrRevisionConflict), errors.Is(err, appai.ErrRevisionConflict):
		return http.StatusConflict, "CYCLE_REVISION_CONFLICT", "別の保存が先に反映されています。入力内容は保持されています。"
	case errors.Is(err, domaincycle.ErrAIOperationRunning), errors.Is(err, appai.ErrOperationInProgress):
		return http.StatusConflict, "AI_OPERATION_IN_PROGRESS", "AI処理の完了をお待ちください。"
	case errors.Is(err, appai.ErrReplacementRequired):
		return http.StatusConflict, "ACTION_REPLACEMENT_CONFIRMATION_REQUIRED", "現在のアクションを置き換える確認が必要です。"
	case errors.Is(err, appai.ErrGenerateInputIncomplete):
		return http.StatusBadRequest, "AI_GENERATE_INPUT_INCOMPLETE", "P/Dを入力し、実行後にCも記録してください。"
	case errors.Is(err, appai.ErrRefineInputIncomplete):
		return http.StatusBadRequest, "AI_REFINE_INPUT_INCOMPLETE", "P/D/C/Aをすべて入力してください。"
	case errors.Is(err, appai.ErrUserRollingLimit):
		return http.StatusTooManyRequests, "AI_USER_ROLLING_LIMIT_EXCEEDED", "直近24時間のAI利用上限に達しました。"
	case errors.Is(err, appai.ErrRateLimit):
		return http.StatusTooManyRequests, "AI_RATE_LIMIT_EXCEEDED", "短時間のAI利用が続いています。少し待ってお試しください。"
	case errors.Is(err, appai.ErrServiceBudget):
		return http.StatusServiceUnavailable, "AI_SERVICE_BUDGET_EXCEEDED", "現在AI機能を一時停止しています。"
	case errors.Is(err, appai.ErrProviderTimeout):
		return http.StatusGatewayTimeout, "AI_PROVIDER_TIMEOUT", "AI処理が時間内に完了しませんでした。もう一度お試しください。"
	case errors.Is(err, appai.ErrInvalidResponse):
		return http.StatusBadGateway, "AI_INVALID_RESPONSE", "AIの応答を確認できませんでした。もう一度お試しください。"
	case errors.Is(err, appai.ErrProviderUnavailable):
		return http.StatusServiceUnavailable, "AI_PROVIDER_UNAVAILABLE", "AIサービスに接続できません。もう一度お試しください。"
	case errors.Is(err, domaincycle.ErrCycleIncomplete):
		return http.StatusBadRequest, "CYCLE_COMPLETION_INPUT_INCOMPLETE", "P/D/C/Aをすべて入力してください。"
	default:
		return http.StatusInternalServerError, "INTERNAL_ERROR", "処理中にエラーが発生しました。もう一度お試しください。"
	}
}
