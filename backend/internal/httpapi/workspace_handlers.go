package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
	"github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/goal"
)

type createDraftRequest struct {
	InitialBody string `json:"initialBody"`
}
type saveDraftRequest struct {
	Body             string `json:"body"`
	ExpectedRevision int64  `json:"expectedRevision"`
}
type startGoalRequest struct {
	OperationID           string `json:"operationId"`
	ExpectedDraftRevision int64  `json:"expectedDraftRevision"`
}
type refineGoalRequest struct {
	ExpectedDraftRevision int64  `json:"expectedDraftRevision"`
	ExpectedGoalRevision  *int64 `json:"expectedGoalRevision,omitempty"`
}
type adoptSuggestionRequest struct {
	ExpectedDraftRevision int64  `json:"expectedDraftRevision"`
	ExpectedGoalRevision  *int64 `json:"expectedGoalRevision,omitempty"`
}
type continueReviewRequest struct {
	OperationID           string `json:"operationId"`
	ExpectedGoalRevision  int64  `json:"expectedGoalRevision"`
	ExpectedDraftRevision int64  `json:"expectedDraftRevision"`
}
type saveFrameRequest struct {
	Content               string `json:"content"`
	ExpectedFrameRevision int64  `json:"expectedFrameRevision"`
}
type actionGenerateRequest struct {
	ExpectedContentRevision int64 `json:"expectedContentRevision"`
	ConfirmReplace          bool  `json:"confirmReplace"`
}
type actionRefineRequest struct {
	ExpectedContentRevision int64 `json:"expectedContentRevision"`
}
type completeCycleRequest struct {
	OperationID             string `json:"operationId"`
	ExpectedGoalRevision    int64  `json:"expectedGoalRevision"`
	ExpectedContentRevision int64  `json:"expectedContentRevision"`
}
type terminateGoalRequest struct {
	OperationID                  string      `json:"operationId"`
	Outcome                      goal.Status `json:"outcome"`
	ExpectedGoalRevision         int64       `json:"expectedGoalRevision"`
	ExpectedState                goal.Status `json:"expectedState"`
	ActiveCycleID                string      `json:"activeCycleId,omitempty"`
	ExpectedCycleContentRevision *int64      `json:"expectedCycleContentRevision,omitempty"`
	ConfirmDiscardReviewDraft    bool        `json:"confirmDiscardReviewDraft,omitempty"`
}
type deleteGoalRequest struct {
	Confirmed            bool  `json:"confirmed"`
	ExpectedGoalRevision int64 `json:"expectedGoalRevision"`
}

func (server *api) getHome(writer http.ResponseWriter, request *http.Request) {
	view, err := server.dependencies.Workspace.Home(request.Context(), currentUserID(request))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) createGoalDraft(writer http.ResponseWriter, request *http.Request) {
	var input createDraftRequest
	if err := decodeJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.CreateDraft(request.Context(), currentUserID(request), input.InitialBody)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{"draft": view})
}

func (server *api) getGoalDraft(writer http.ResponseWriter, request *http.Request) {
	view, err := server.dependencies.Workspace.GetDraft(request.Context(), currentUserID(request), chi.URLParam(request, "draftId"))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"draft": view})
}

func (server *api) saveGoalDraft(writer http.ResponseWriter, request *http.Request) {
	var input saveDraftRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.SaveDraft(request.Context(), currentUserID(request), chi.URLParam(request, "draftId"), input.Body, input.ExpectedRevision)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"draft": view})
}

func (server *api) abandonGoalDraft(writer http.ResponseWriter, request *http.Request) {
	if err := server.dependencies.Workspace.AbandonDraft(request.Context(), currentUserID(request), chi.URLParam(request, "draftId")); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *api) startGoal(writer http.ResponseWriter, request *http.Request) {
	var input startGoalRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil || !isCanonicalUUID(input.OperationID) {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.StartGoal(request.Context(), currentUserID(request), chi.URLParam(request, "draftId"), input.OperationID, input.ExpectedDraftRevision)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) refineGoalDraft(writer http.ResponseWriter, request *http.Request) {
	server.refineGoal(writer, request, chi.URLParam(request, "draftId"), "")
}

func (server *api) refineGoalReview(writer http.ResponseWriter, request *http.Request) {
	goalID := chi.URLParam(request, "goalId")
	review, err := server.dependencies.Workspace.GetReview(request.Context(), currentUserID(request), goalID)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	server.refineGoal(writer, request, review.ReviewDraft.ID, goalID)
}

func (server *api) refineGoal(writer http.ResponseWriter, request *http.Request, draftID, goalID string) {
	var input refineGoalRequest
	key := idempotencyKey(request)
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil || key == "" {
		server.writeError(writer, request, workspace.ErrIdempotencyKeyReused, nil)
		return
	}
	view, err := server.dependencies.Workspace.RefineGoal(request.Context(), workspace.GoalRefineInput{
		UserID: currentUserID(request), DraftID: draftID, GoalID: goalID,
		ExpectedDraftRevision: input.ExpectedDraftRevision, ExpectedGoalRevision: input.ExpectedGoalRevision,
		IdempotencyKey: key, SessionID: sessionID(request), RemoteAddress: server.remoteIP(request),
	})
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) adoptGoalDraftSuggestion(writer http.ResponseWriter, request *http.Request) {
	server.adoptSuggestion(writer, request, chi.URLParam(request, "draftId"), false)
}

func (server *api) adoptGoalReviewSuggestion(writer http.ResponseWriter, request *http.Request) {
	review, err := server.dependencies.Workspace.GetReview(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	server.adoptSuggestion(writer, request, review.ReviewDraft.ID, true)
}

func (server *api) adoptSuggestion(writer http.ResponseWriter, request *http.Request, draftID string, review bool) {
	var input adoptSuggestionRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.AdoptGoalSuggestion(request.Context(), currentUserID(request), draftID,
		chi.URLParam(request, "generationId"), input.ExpectedDraftRevision, input.ExpectedGoalRevision)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	key := "draft"
	if review {
		key = "reviewDraft"
	}
	writeJSON(writer, http.StatusOK, map[string]any{key: view, "adoptedGenerationId": chi.URLParam(request, "generationId")})
}

func (server *api) listGoals(writer http.ResponseWriter, request *http.Request) {
	view, err := server.dependencies.Workspace.ListGoals(request.Context(), currentUserID(request), request.URL.Query().Get("scope"), request.URL.Query().Get("cursor"), pageLimit(request))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) getGoal(writer http.ResponseWriter, request *http.Request) {
	view, err := server.dependencies.Workspace.GetGoal(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"goal": view})
}

func (server *api) getGoalReview(writer http.ResponseWriter, request *http.Request) {
	view, err := server.dependencies.Workspace.GetReview(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) saveGoalReview(writer http.ResponseWriter, request *http.Request) {
	var input saveDraftRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.SaveReview(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), input.Body, input.ExpectedRevision)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"reviewDraft": view})
}

func (server *api) continueGoalReview(writer http.ResponseWriter, request *http.Request) {
	var input continueReviewRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil || !isCanonicalUUID(input.OperationID) {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.ContinueReview(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), input.OperationID, input.ExpectedGoalRevision, input.ExpectedDraftRevision)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) terminateGoal(writer http.ResponseWriter, request *http.Request) {
	var input terminateGoalRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil || !isCanonicalUUID(input.OperationID) {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.Terminate(request.Context(), workspace.TerminateInput{
		UserID: currentUserID(request), GoalID: chi.URLParam(request, "goalId"), OperationID: input.OperationID,
		Outcome: input.Outcome, ExpectedGoalRevision: input.ExpectedGoalRevision, ExpectedState: input.ExpectedState,
		ActiveCycleID: input.ActiveCycleID, ExpectedCycleContentRevision: input.ExpectedCycleContentRevision,
		ConfirmDiscardReviewDraft: input.ConfirmDiscardReviewDraft,
	})
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) deleteGoal(writer http.ResponseWriter, request *http.Request) {
	var input deleteGoalRequest
	key := idempotencyKey(request)
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil || key == "" {
		server.writeError(writer, request, workspace.ErrIdempotencyKeyReused, nil)
		return
	}
	if err := server.dependencies.Workspace.DeleteGoal(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), input.Confirmed, input.ExpectedGoalRevision, key); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *api) listGoalCycles(writer http.ResponseWriter, request *http.Request) {
	view, err := server.dependencies.Workspace.ListCycles(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), request.URL.Query().Get("cursor"), pageLimit(request))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) getGoalCycle(writer http.ResponseWriter, request *http.Request) {
	view, err := server.dependencies.Workspace.GetCycle(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), chi.URLParam(request, "cycleId"))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"cycle": view})
}

func (server *api) saveGoalCycleFrame(writer http.ResponseWriter, request *http.Request) {
	var input saveFrameRequest
	frame, frameErr := cycle.ParseFrame(chi.URLParam(request, "frame"))
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil || frameErr != nil {
		server.writeError(writer, request, cycle.ErrInvalidFrame, nil)
		return
	}
	view, err := server.dependencies.Workspace.SaveFrame(request.Context(), workspace.SaveFrameInput{
		UserID: currentUserID(request), GoalID: chi.URLParam(request, "goalId"), CycleID: chi.URLParam(request, "cycleId"),
		Frame: frame, Content: input.Content, ExpectedFrameRevision: input.ExpectedFrameRevision,
	})
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) generateAction(writer http.ResponseWriter, request *http.Request) {
	var input actionGenerateRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil {
		server.writeError(writer, request, workspace.ErrAIInputIncomplete, nil)
		return
	}
	server.runActionAI(writer, request, "action_generate", input.ExpectedContentRevision, input.ConfirmReplace)
}

func (server *api) refineAction(writer http.ResponseWriter, request *http.Request) {
	var input actionRefineRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil {
		server.writeError(writer, request, workspace.ErrAIInputIncomplete, nil)
		return
	}
	server.runActionAI(writer, request, "action_refine", input.ExpectedContentRevision, false)
}

func (server *api) runActionAI(writer http.ResponseWriter, request *http.Request, operation string, revision int64, confirmReplace bool) {
	key := idempotencyKey(request)
	if key == "" {
		server.writeError(writer, request, workspace.ErrIdempotencyKeyReused, nil)
		return
	}
	view, err := server.dependencies.Workspace.RunActionAI(request.Context(), workspace.ActionAIInput{
		UserID: currentUserID(request), GoalID: chi.URLParam(request, "goalId"), CycleID: chi.URLParam(request, "cycleId"),
		Operation: operation, ExpectedContentRevision: revision, ConfirmReplace: confirmReplace,
		IdempotencyKey: key, SessionID: sessionID(request), RemoteAddress: server.remoteIP(request),
	})
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) completeGoalCycle(writer http.ResponseWriter, request *http.Request) {
	var input completeCycleRequest
	if decodeJSON(writer, request, &input, defaultBodyLimit) != nil || !isCanonicalUUID(input.OperationID) {
		server.writeError(writer, request, goal.ErrForbiddenCharacter, nil)
		return
	}
	view, err := server.dependencies.Workspace.CompleteCycle(request.Context(), workspace.CompleteCycleInput{
		UserID: currentUserID(request), GoalID: chi.URLParam(request, "goalId"), CycleID: chi.URLParam(request, "cycleId"),
		OperationID: input.OperationID, ExpectedGoalRevision: input.ExpectedGoalRevision, ExpectedContentRevision: input.ExpectedContentRevision,
	})
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	if server.dependencies.Metrics != nil {
		server.dependencies.Metrics.CycleCompleted(request.Context())
	}
	writeJSON(writer, http.StatusOK, view)
}

func pageLimit(request *http.Request) int {
	value, err := strconv.Atoi(request.URL.Query().Get("limit"))
	if err != nil || value <= 0 {
		return 20
	}
	return value
}

func idempotencyKey(request *http.Request) string {
	value := strings.ToLower(strings.TrimSpace(request.Header.Get("Idempotency-Key")))
	if !isCanonicalUUID(value) {
		return ""
	}
	return value
}
