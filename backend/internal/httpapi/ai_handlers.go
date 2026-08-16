package httpapi

import (
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

type generateActionRequest struct {
	ExpectedContentRevision int64 `json:"expectedContentRevision"`
	ConfirmReplace          bool  `json:"confirmReplace"`
}

type refineActionRequest struct {
	ExpectedContentRevision int64 `json:"expectedContentRevision"`
}

type aiActionResponse struct {
	GenerationID    string `json:"generationId"`
	Action          string `json:"action"`
	ContentRevision int64  `json:"contentRevision"`
	ActionRevision  int64  `json:"actionRevision"`
	ContextChanged  bool   `json:"contextChanged"`
}

func (server *api) generateAction(writer http.ResponseWriter, request *http.Request) {
	cycleID := strings.ToLower(chi.URLParam(request, "cycleId"))
	idempotencyKey := strings.ToLower(strings.TrimSpace(request.Header.Get("Idempotency-Key")))
	var input generateActionRequest
	if !isCanonicalUUID(cycleID) || !isCanonicalUUID(idempotencyKey) ||
		decodeJSON(writer, request, &input, defaultBodyLimit) != nil || input.ExpectedContentRevision < 0 {
		server.writeError(writer, request, domaincycle.ErrInvalidText, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	result, err := server.dependencies.GenerateAction.Execute(request.Context(), appai.GenerateCommand{
		UserID: record.UserID, CycleID: domaincycle.ID(cycleID), IdempotencyKey: idempotencyKey,
		ExpectedContentRevision: input.ExpectedContentRevision, ConfirmReplace: input.ConfirmReplace,
		Scope: appai.RequestScope{SessionID: record.ID, IP: remoteIP(request)},
	})
	if err != nil {
		server.writeAIError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, mapAIResult(result))
}

func (server *api) refineAction(writer http.ResponseWriter, request *http.Request) {
	cycleID := strings.ToLower(chi.URLParam(request, "cycleId"))
	idempotencyKey := strings.ToLower(strings.TrimSpace(request.Header.Get("Idempotency-Key")))
	var input refineActionRequest
	if !isCanonicalUUID(cycleID) || !isCanonicalUUID(idempotencyKey) ||
		decodeJSON(writer, request, &input, defaultBodyLimit) != nil || input.ExpectedContentRevision < 0 {
		server.writeError(writer, request, domaincycle.ErrInvalidText, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	result, err := server.dependencies.RefineAction.Execute(request.Context(), appai.RefineCommand{
		UserID: record.UserID, CycleID: domaincycle.ID(cycleID), IdempotencyKey: idempotencyKey,
		ExpectedContentRevision: input.ExpectedContentRevision,
		Scope:                   appai.RequestScope{SessionID: record.ID, IP: remoteIP(request)},
	})
	if err != nil {
		server.writeAIError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, mapAIResult(result))
}

func (server *api) writeAIError(writer http.ResponseWriter, request *http.Request, err error) {
	var incomplete *appai.IncompleteError
	details := map[string]any(nil)
	if errors.As(err, &incomplete) {
		details = map[string]any{"missingFrames": incomplete.MissingFrames}
	}
	server.writeError(writer, request, err, details)
}

func mapAIResult(result appai.Result) aiActionResponse {
	return aiActionResponse{
		GenerationID: result.GenerationID, Action: result.Action,
		ContentRevision: result.ContentRevision, ActionRevision: result.ActionRevision,
		ContextChanged: result.ContextChanged,
	}
}

func remoteIP(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err == nil {
		return host
	}
	return request.RemoteAddr
}
