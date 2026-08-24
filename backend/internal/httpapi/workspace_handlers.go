package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type createDraftRequest struct {
	InitialBody string `json:"initialBody"`
}
type saveDraftRequest struct {
	Body             string `json:"body"`
	ExpectedRevision int64  `json:"expectedRevision" validate:"gte=0"`
}
type saveReviewRequest struct {
	Body                  string `json:"body"`
	ExpectedReviewDraftID string `json:"expectedReviewDraftId" validate:"required,uuid_v7"`
	ExpectedRevision      int64  `json:"expectedRevision" validate:"gte=0"`
}
type startGoalRequest struct {
	OperationID           string `json:"operationId" validate:"required,uuid_v7"`
	ExpectedDraftRevision int64  `json:"expectedDraftRevision" validate:"gte=0"`
}
type refineGoalRequest struct {
	ExpectedDraftRevision int64  `json:"expectedDraftRevision" validate:"gte=0"`
	ExpectedGoalRevision  *int64 `json:"expectedGoalRevision,omitempty" validate:"omitempty,gte=0"`
}
type adoptSuggestionRequest struct {
	ExpectedDraftRevision int64  `json:"expectedDraftRevision" validate:"gte=0"`
	ExpectedGoalRevision  *int64 `json:"expectedGoalRevision,omitempty" validate:"omitempty,gte=0"`
}
type continueReviewRequest struct {
	OperationID           string `json:"operationId" validate:"required,uuid_v7"`
	ExpectedGoalRevision  int64  `json:"expectedGoalRevision" validate:"gte=0"`
	ExpectedDraftRevision int64  `json:"expectedDraftRevision" validate:"gte=0"`
}
type saveFrameRequest struct {
	Content               string `json:"content"`
	ExpectedFrameRevision int64  `json:"expectedFrameRevision" validate:"gte=0"`
}
type actionGenerateRequest struct {
	ExpectedContentRevision int64 `json:"expectedContentRevision" validate:"gte=0"`
	ConfirmReplace          bool  `json:"confirmReplace"`
}
type actionRefineRequest struct {
	ExpectedContentRevision int64 `json:"expectedContentRevision" validate:"gte=0"`
}
type completeCycleRequest struct {
	OperationID             string `json:"operationId" validate:"required,uuid_v7"`
	ExpectedGoalRevision    int64  `json:"expectedGoalRevision" validate:"gte=0"`
	ExpectedContentRevision int64  `json:"expectedContentRevision" validate:"gte=0"`
}
type optionalJSONField[T any] struct {
	Value   T
	Present bool
	Null    bool
}

func (field *optionalJSONField[T]) UnmarshalJSON(data []byte) error {
	field.Present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		field.Null = true
		return nil
	}
	return json.Unmarshal(data, &field.Value)
}

type terminateGoalRequest struct {
	OperationID                  string                    `json:"operationId" validate:"required,uuid_v7"`
	Outcome                      goal.Status               `json:"outcome" validate:"required"`
	ExpectedGoalRevision         *int64                    `json:"expectedGoalRevision" validate:"required,gte=0"`
	ExpectedState                goal.Status               `json:"expectedState" validate:"required"`
	ActiveCycleID                optionalJSONField[string] `json:"activeCycleId"`
	ExpectedCycleContentRevision optionalJSONField[int64]  `json:"expectedCycleContentRevision"`
	ConfirmDiscardReviewDraft    optionalJSONField[bool]   `json:"confirmDiscardReviewDraft"`
}

func (input terminateGoalRequest) variant() (string, *int64, bool, error) {
	switch input.ExpectedState {
	case goal.StatusActiveCycle:
		if !input.ActiveCycleID.Present || input.ActiveCycleID.Null ||
			!isCanonicalUUIDv7(input.ActiveCycleID.Value) ||
			!input.ExpectedCycleContentRevision.Present || input.ExpectedCycleContentRevision.Null ||
			input.ExpectedCycleContentRevision.Value < 0 ||
			input.ConfirmDiscardReviewDraft.Present {
			return "", nil, false, errRequestValidation
		}
		revision := input.ExpectedCycleContentRevision.Value
		return input.ActiveCycleID.Value, &revision, false, nil
	case goal.StatusGoalReview:
		if input.ActiveCycleID.Present || input.ExpectedCycleContentRevision.Present ||
			!input.ConfirmDiscardReviewDraft.Present || input.ConfirmDiscardReviewDraft.Null {
			return "", nil, false, errRequestValidation
		}
		return "", nil, input.ConfirmDiscardReviewDraft.Value, nil
	default:
		return "", nil, false, errRequestValidation
	}
}

type deleteGoalRequest struct {
	Confirmed            bool  `json:"confirmed"`
	ExpectedGoalRevision int64 `json:"expectedGoalRevision" validate:"gte=0"`
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
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
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
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.SaveDraft(request.Context(), currentUserID(request), chi.URLParam(request, "draftId"), input.Body, input.ExpectedRevision)
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoalDraftSaveFailed), nil)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"draft": view})
}

func (server *api) abandonGoalDraft(writer http.ResponseWriter, request *http.Request) {
	if err := server.dependencies.Workspace.AbandonDraft(request.Context(), currentUserID(request), chi.URLParam(request, "draftId")); err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoalDraftDeleteFailed), nil)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *api) startGoal(writer http.ResponseWriter, request *http.Request) {
	var input startGoalRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.StartGoal(request.Context(), currentUserID(request), chi.URLParam(request, "draftId"), input.OperationID, input.ExpectedDraftRevision)
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoalStartFailed), nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) refineGoalDraft(writer http.ResponseWriter, request *http.Request) {
	server.refineGoal(writer, request, chi.URLParam(request, "draftId"), "")
}

func (server *api) refineGoalReview(writer http.ResponseWriter, request *http.Request) {
	goalID := chi.URLParam(request, "goalId")
	server.refineGoal(writer, request, "", goalID)
}

func (server *api) refineGoal(writer http.ResponseWriter, request *http.Request, draftID, goalID string) {
	var input refineGoalRequest
	key := idempotencyKey(request)
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	if (goalID == "" && input.ExpectedGoalRevision != nil) || (goalID != "" && input.ExpectedGoalRevision == nil) {
		server.writeError(writer, request, errRequestValidation, nil)
		return
	}
	if key == "" {
		server.writeError(writer, request, errRequestValidation, nil)
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
	server.adoptSuggestion(writer, request, chi.URLParam(request, "draftId"), "", false)
}

func (server *api) adoptGoalReviewSuggestion(writer http.ResponseWriter, request *http.Request) {
	server.adoptSuggestion(writer, request, "", chi.URLParam(request, "goalId"), true)
}

func (server *api) adoptSuggestion(writer http.ResponseWriter, request *http.Request, draftID, goalID string, review bool) {
	var input adoptSuggestionRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	if (review && input.ExpectedGoalRevision == nil) || (!review && input.ExpectedGoalRevision != nil) {
		server.writeError(writer, request, errRequestValidation, nil)
		return
	}
	view, err := server.dependencies.Workspace.AdoptGoalSuggestion(request.Context(), currentUserID(request), draftID, goalID,
		chi.URLParam(request, "generationId"), input.ExpectedDraftRevision, input.ExpectedGoalRevision)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	key := "draft"
	if review {
		key = "reviewDraft"
	}
	response := map[string]any{key: view, "adoptedGenerationId": chi.URLParam(request, "generationId")}
	if view.Replayed {
		response["replayed"] = true
	}
	writeJSON(writer, http.StatusOK, response)
}

func (server *api) listGoals(writer http.ResponseWriter, request *http.Request) {
	scope, limit, err := goalListQuery(request)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.ListGoals(request.Context(), currentUserID(request), scope, request.URL.Query().Get("cursor"), limit)
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
	var input saveReviewRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.SaveReview(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), input.ExpectedReviewDraftID, input.Body, input.ExpectedRevision)
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoalReviewDraftSaveFailed), nil)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"reviewDraft": view})
}

func (server *api) continueGoalReview(writer http.ResponseWriter, request *http.Request) {
	var input continueReviewRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.ContinueReview(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), input.OperationID, input.ExpectedGoalRevision, input.ExpectedDraftRevision)
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoalReviewContinueFailed), nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) terminateGoal(writer http.ResponseWriter, request *http.Request) {
	var input terminateGoalRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	if input.Outcome != goal.StatusAchieved && input.Outcome != goal.StatusEnded {
		server.writeError(writer, request, workspace.ErrInvalidGoalOutcome, nil)
		return
	}
	activeCycleID, expectedCycleContentRevision, confirmDiscardReviewDraft, err := input.variant()
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.Terminate(request.Context(), workspace.TerminateInput{
		UserID: currentUserID(request), GoalID: chi.URLParam(request, "goalId"), OperationID: input.OperationID,
		Outcome: input.Outcome, ExpectedGoalRevision: *input.ExpectedGoalRevision, ExpectedState: input.ExpectedState,
		ActiveCycleID: activeCycleID, ExpectedCycleContentRevision: expectedCycleContentRevision,
		ConfirmDiscardReviewDraft: confirmDiscardReviewDraft,
	})
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoalTerminationFailed), nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) deleteGoal(writer http.ResponseWriter, request *http.Request) {
	var input deleteGoalRequest
	key := idempotencyKey(request)
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	if key == "" {
		server.writeError(writer, request, errRequestValidation, nil)
		return
	}
	if err := server.dependencies.Workspace.DeleteGoal(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), input.Confirmed, input.ExpectedGoalRevision, key); err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoalDeleteFailed), nil)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (server *api) listGoalCycles(writer http.ResponseWriter, request *http.Request) {
	limit, err := pageLimit(request)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.ListCycles(request.Context(), currentUserID(request), chi.URLParam(request, "goalId"), request.URL.Query().Get("cursor"), limit)
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
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	if frameErr != nil {
		server.writeError(writer, request, errRequestValidation, nil)
		return
	}
	view, err := server.dependencies.Workspace.SaveFrame(request.Context(), workspace.SaveFrameInput{
		UserID: currentUserID(request), GoalID: chi.URLParam(request, "goalId"), CycleID: chi.URLParam(request, "cycleId"),
		Frame: frame, Content: input.Content, ExpectedFrameRevision: input.ExpectedFrameRevision,
	})
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errFrameSaveFailed), nil)
		return
	}
	writeJSON(writer, http.StatusOK, view)
}

func (server *api) generateAction(writer http.ResponseWriter, request *http.Request) {
	var input actionGenerateRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	server.runActionAI(writer, request, "action_generate", input.ExpectedContentRevision, input.ConfirmReplace)
}

func (server *api) refineAction(writer http.ResponseWriter, request *http.Request) {
	var input actionRefineRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	server.runActionAI(writer, request, "action_refine", input.ExpectedContentRevision, false)
}

func (server *api) runActionAI(writer http.ResponseWriter, request *http.Request, operation string, revision int64, confirmReplace bool) {
	key := idempotencyKey(request)
	if key == "" {
		server.writeError(writer, request, errRequestValidation, nil)
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
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Workspace.CompleteCycle(request.Context(), workspace.CompleteCycleInput{
		UserID: currentUserID(request), GoalID: chi.URLParam(request, "goalId"), CycleID: chi.URLParam(request, "cycleId"),
		OperationID: input.OperationID, ExpectedGoalRevision: input.ExpectedGoalRevision, ExpectedContentRevision: input.ExpectedContentRevision,
	})
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errCycleCompletionFailed), nil)
		return
	}
	if view.Replay != nil {
		writeJSON(writer, http.StatusOK, view.Replay)
		return
	}
	if !view.Replayed && server.dependencies.Metrics != nil {
		server.dependencies.Metrics.CycleCompleted(request.Context())
	}
	writeJSON(writer, http.StatusOK, view)
}

func goalListQuery(request *http.Request) (string, int, error) {
	scope := request.URL.Query().Get("scope")
	if scope == "" {
		scope = "all"
	}
	if scope != "all" && scope != "progressing" && scope != "history" {
		return "", 0, errRequestValidation
	}
	limit, err := pageLimit(request)
	return scope, limit, err
}

func pageLimit(request *http.Request) (int, error) {
	raw := request.URL.Query().Get("limit")
	if raw == "" {
		return 20, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 || value > 50 {
		return 0, errRequestValidation
	}
	return value, nil
}

func idempotencyKey(request *http.Request) string {
	value := strings.ToLower(strings.TrimSpace(request.Header.Get("Idempotency-Key")))
	if !isCanonicalUUIDv7(value) {
		return ""
	}
	return value
}
