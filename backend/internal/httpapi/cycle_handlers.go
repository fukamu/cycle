package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

type activeCycleEnvelope struct {
	Cycle activeCycleDTO `json:"cycle"`
}

type activeCycleDTO struct {
	ID                        string         `json:"id"`
	SequenceNumber            int32          `json:"sequenceNumber"`
	Status                    string         `json:"status"`
	StartedAt                 time.Time      `json:"startedAt"`
	CompletedAt               *time.Time     `json:"completedAt"`
	Plan                      string         `json:"plan"`
	Do                        string         `json:"do"`
	Check                     string         `json:"check"`
	Action                    string         `json:"action"`
	ContentRevision           int64          `json:"contentRevision"`
	FrameRevisions            frameRevisions `json:"frameRevisions"`
	ActionUserModifiedAfterAI bool           `json:"actionUserModifiedAfterAI"`
}

type frameRevisions struct {
	Plan   int64 `json:"plan"`
	Do     int64 `json:"do"`
	Check  int64 `json:"check"`
	Action int64 `json:"action"`
}

type saveFrameRequest struct {
	Content               *string `json:"content"`
	ExpectedFrameRevision int64   `json:"expectedFrameRevision"`
}

type saveFrameResponse struct {
	CycleID         string    `json:"cycleId"`
	Frame           string    `json:"frame"`
	Content         string    `json:"content"`
	FrameRevision   int64     `json:"frameRevision"`
	ContentRevision int64     `json:"contentRevision"`
	SavedAt         time.Time `json:"savedAt"`
}

type completeCycleRequest struct {
	OperationID             string `json:"operationId"`
	ExpectedContentRevision int64  `json:"expectedContentRevision"`
}

type completeCycleResponse struct {
	CompletedCycle struct {
		ID             string    `json:"id"`
		SequenceNumber int32     `json:"sequenceNumber"`
		CompletedAt    time.Time `json:"completedAt"`
	} `json:"completedCycle"`
	NextCycle activeCycleDTO `json:"nextCycle"`
}

type completedListResponse struct {
	Items      []completedSummaryDTO `json:"items"`
	NextCursor *string               `json:"nextCursor"`
}

type completedSummaryDTO struct {
	ID             string    `json:"id"`
	SequenceNumber int32     `json:"sequenceNumber"`
	StartedAt      time.Time `json:"startedAt"`
	CompletedAt    time.Time `json:"completedAt"`
	PlanPreview    string    `json:"planPreview"`
}

type completedDetailEnvelope struct {
	Cycle completedDetailDTO `json:"cycle"`
}

type completedDetailDTO struct {
	ID             string    `json:"id"`
	SequenceNumber int32     `json:"sequenceNumber"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"startedAt"`
	CompletedAt    time.Time `json:"completedAt"`
	Plan           string    `json:"plan"`
	Do             string    `json:"do"`
	Check          string    `json:"check"`
	Action         string    `json:"action"`
}

func (server *api) getActiveCycle(writer http.ResponseWriter, request *http.Request) {
	record, _ := authenticatedSession(request.Context())
	result, err := server.dependencies.Cycles.GetActive(request.Context(), record.UserID)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, activeCycleEnvelope{Cycle: mapActiveCycle(result)})
}

func (server *api) saveFrame(writer http.ResponseWriter, request *http.Request) {
	started := time.Now()
	metricResult := "failure"
	defer func() {
		if server.dependencies.Metrics != nil {
			server.dependencies.Metrics.ObserveAutosave(request.Context(), metricResult, time.Since(started))
		}
	}()
	cycleID := chi.URLParam(request, "cycleId")
	frame, frameErr := domaincycle.ParseFrame(chi.URLParam(request, "frame"))
	if !isCanonicalUUID(cycleID) || frameErr != nil {
		server.writeError(writer, request, domaincycle.ErrInvalidFrame, nil)
		return
	}
	var input saveFrameRequest
	if err := decodeJSON(writer, request, &input, defaultBodyLimit); err != nil || input.Content == nil || input.ExpectedFrameRevision < 0 {
		server.writeError(writer, request, domaincycle.ErrInvalidText, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	result, err := server.dependencies.Cycles.SaveFrame(
		request.Context(), record.UserID, domaincycle.ID(cycleID), frame, *input.Content, input.ExpectedFrameRevision,
	)
	if err != nil {
		details := map[string]any(nil)
		if errors.Is(err, domaincycle.ErrRevisionConflict) {
			details = map[string]any{"localDraftPreserved": true}
		}
		server.writeError(writer, request, err, details)
		return
	}
	writeJSON(writer, http.StatusOK, saveFrameResponse{
		CycleID: string(result.Cycle.ID), Frame: string(frame), Content: result.Cycle.FrameContent(frame),
		FrameRevision: result.Cycle.FrameRevision(frame), ContentRevision: result.Cycle.ContentRevision, SavedAt: result.SavedAt,
	})
	metricResult = "success"
}

func (server *api) completeCycle(writer http.ResponseWriter, request *http.Request) {
	cycleID := chi.URLParam(request, "cycleId")
	var input completeCycleRequest
	if !isCanonicalUUID(cycleID) || decodeJSON(writer, request, &input, defaultBodyLimit) != nil || !isCanonicalUUID(input.OperationID) || input.ExpectedContentRevision < 0 {
		server.writeError(writer, request, domaincycle.ErrInvalidTransition, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	result, err := server.dependencies.Cycles.Complete(
		request.Context(), record.UserID, domaincycle.ID(cycleID), domaincycle.OperationID(input.OperationID), input.ExpectedContentRevision,
	)
	if err != nil {
		var incomplete *domaincycle.IncompleteError
		details := map[string]any(nil)
		if errors.As(err, &incomplete) {
			details = map[string]any{"missingFrames": incomplete.MissingFrames}
		}
		server.writeError(writer, request, err, details)
		return
	}
	var response completeCycleResponse
	response.CompletedCycle.ID = string(result.Completed.ID)
	response.CompletedCycle.SequenceNumber = result.Completed.SequenceNumber
	response.CompletedCycle.CompletedAt = *result.Completed.CompletedAt
	response.NextCycle = mapActiveCycle(result.Next)
	if server.dependencies.Metrics != nil {
		server.dependencies.Metrics.CycleCompleted(request.Context())
	}
	writeJSON(writer, http.StatusOK, response)
}

func (server *api) listCompletedCycles(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Query().Get("status") != "completed" {
		server.writeError(writer, request, domaincycle.ErrInvalidText, nil)
		return
	}
	limit := 0
	if raw := request.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			server.writeError(writer, request, domaincycle.ErrInvalidText, nil)
			return
		}
		limit = parsed
	}
	record, _ := authenticatedSession(request.Context())
	page, err := server.dependencies.Cycles.ListCompleted(request.Context(), record.UserID, request.URL.Query().Get("cursor"), limit)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	response := completedListResponse{Items: make([]completedSummaryDTO, 0, len(page.Items))}
	for _, item := range page.Items {
		response.Items = append(response.Items, completedSummaryDTO{
			ID: string(item.ID), SequenceNumber: item.SequenceNumber, StartedAt: item.StartedAt,
			CompletedAt: item.CompletedAt, PlanPreview: item.PlanPreview,
		})
	}
	if page.NextCursor != "" {
		response.NextCursor = &page.NextCursor
	}
	writeJSON(writer, http.StatusOK, response)
}

func (server *api) getCompletedCycle(writer http.ResponseWriter, request *http.Request) {
	cycleID := chi.URLParam(request, "cycleId")
	if !isCanonicalUUID(cycleID) {
		server.writeError(writer, request, domaincycle.ErrInvalidText, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	result, err := server.dependencies.Cycles.GetCompleted(request.Context(), record.UserID, domaincycle.ID(cycleID))
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, completedDetailEnvelope{Cycle: completedDetailDTO{
		ID: string(result.ID), SequenceNumber: result.SequenceNumber, Status: string(result.Status),
		StartedAt: result.StartedAt, CompletedAt: *result.CompletedAt,
		Plan: result.Plan, Do: result.Do, Check: result.Check, Action: result.Action,
	}})
}

func mapActiveCycle(value domaincycle.PDCACycle) activeCycleDTO {
	return activeCycleDTO{
		ID: string(value.ID), SequenceNumber: value.SequenceNumber, Status: string(value.Status),
		StartedAt: value.StartedAt, CompletedAt: value.CompletedAt,
		Plan: value.Plan, Do: value.Do, Check: value.Check, Action: value.Action,
		ContentRevision:           value.ContentRevision,
		FrameRevisions:            frameRevisions{Plan: value.PlanRevision, Do: value.DoRevision, Check: value.CheckRevision, Action: value.ActionRevision},
		ActionUserModifiedAfterAI: value.ActionUserModifiedAfterAI,
	}
}
