package httpapi

import (
	"errors"
	"net/http"

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
	case errors.Is(err, appsession.ErrBootstrapID), errors.Is(err, domaincycle.ErrInvalidFrame), errors.Is(err, domaincycle.ErrInvalidText), errors.Is(err, domaincycle.ErrFrameTooLong), errors.Is(err, domaincycle.ErrInvalidTransition):
		return http.StatusBadRequest, "VALIDATION_ERROR", "入力内容を確認してください。"
	case errors.Is(err, ports.ErrAnonymousCreationBlocked):
		return http.StatusForbidden, "ANONYMOUS_CREATION_BLOCKED", "時間を空けてもう一度お試しください。"
	case errors.Is(err, ports.ErrAntiAbuseUnavailable):
		return http.StatusServiceUnavailable, "ANTI_ABUSE_SERVICE_UNAVAILABLE", "現在、新しい利用を開始できません。しばらくしてからお試しください。"
	case errors.Is(err, appcycle.ErrCycleNotFound):
		return http.StatusNotFound, "CYCLE_NOT_FOUND", "サイクルが見つかりません。"
	case errors.Is(err, appcycle.ErrCycleNotCompleted):
		return http.StatusConflict, "CYCLE_NOT_COMPLETED", "このサイクルはまだ完了していません。"
	case errors.Is(err, appcycle.ErrInvalidCursor):
		return http.StatusBadRequest, "INVALID_CURSOR", "一覧を先頭から読み込み直してください。"
	case errors.Is(err, appcycle.ErrInvalidPageLimit):
		return http.StatusBadRequest, "VALIDATION_ERROR", "取得件数を確認してください。"
	case errors.Is(err, domaincycle.ErrCycleNotActive):
		return http.StatusConflict, "CYCLE_NOT_ACTIVE", "現在のサイクルを読み込み直してください。"
	case errors.Is(err, domaincycle.ErrRevisionConflict):
		return http.StatusConflict, "CYCLE_REVISION_CONFLICT", "別の保存が先に反映されています。入力内容は保持されています。"
	case errors.Is(err, domaincycle.ErrAIOperationRunning):
		return http.StatusConflict, "AI_OPERATION_IN_PROGRESS", "AI処理の完了をお待ちください。"
	case errors.Is(err, domaincycle.ErrCycleIncomplete):
		return http.StatusBadRequest, "CYCLE_COMPLETION_INPUT_INCOMPLETE", "P/D/C/Aをすべて入力してください。"
	default:
		return http.StatusInternalServerError, "INTERNAL_ERROR", "処理中にエラーが発生しました。もう一度お試しください。"
	}
}
