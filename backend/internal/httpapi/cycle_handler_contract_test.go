package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/httpapi"
)

type cycleCompletionContractWorkspaceStub struct {
	httpapi.WorkspaceService
	complete func(context.Context, workspace.CompleteCycleInput) (workspace.CompleteCycleResult, error)
}

type cycleViewResponseContractWorkspaceStub struct {
	httpapi.WorkspaceService
	first     workspace.CycleView
	active    workspace.CycleView
	completed workspace.CycleView
	canceled  workspace.CycleView
}

func (stub *cycleViewResponseContractWorkspaceStub) StartGoal(
	context.Context, string, string, string, string, int64,
) (workspace.StartGoalResult, error) {
	return workspace.StartGoalResult{Cycle: stub.first}, nil
}

func (stub *cycleViewResponseContractWorkspaceStub) GetReview(
	context.Context, string, string,
) (workspace.ReviewView, error) {
	return workspace.ReviewView{TriggerCycle: stub.completed}, nil
}

func (stub *cycleViewResponseContractWorkspaceStub) GetCycle(
	context.Context, string, string, string,
) (workspace.CycleView, error) {
	return stub.active, nil
}

func (stub *cycleViewResponseContractWorkspaceStub) ListCycles(
	context.Context, string, string, string, int,
) (workspace.CyclePage, error) {
	return workspace.CyclePage{Items: []workspace.CycleSummary{{
		ID: stub.completed.ID, SequenceNumber: stub.completed.SequenceNumber, Status: stub.completed.Status,
	}}}, nil
}

func (stub *cycleViewResponseContractWorkspaceStub) SaveFrame(
	context.Context, workspace.SaveFrameInput,
) (workspace.SaveFrameResult, error) {
	return workspace.SaveFrameResult{CycleID: stub.active.ID, Frame: cycle.FramePlan, Content: "plan"}, nil
}

func (stub *cycleViewResponseContractWorkspaceStub) ContinueReview(
	context.Context, string, string, string, int64, int64,
) (workspace.ContinueReviewResult, error) {
	return workspace.ContinueReviewResult{Cycle: stub.active}, nil
}

func (stub *cycleViewResponseContractWorkspaceStub) CompleteCycle(
	context.Context, workspace.CompleteCycleInput,
) (workspace.CompleteCycleResult, error) {
	return workspace.CompleteCycleResult{CompletedCycle: stub.completed}, nil
}

func (stub *cycleViewResponseContractWorkspaceStub) Terminate(
	context.Context, workspace.TerminateInput,
) (workspace.TerminateResult, error) {
	return workspace.TerminateResult{CanceledCycle: &stub.canceled}, nil
}

func (stub *cycleCompletionContractWorkspaceStub) CompleteCycle(
	ctx context.Context,
	input workspace.CompleteCycleInput,
) (workspace.CompleteCycleResult, error) {
	if stub.complete == nil {
		panic("unexpected CompleteCycle call")
	}
	return stub.complete(ctx, input)
}

func TestCompleteCycleErrorHTTPContract(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		status  int
		code    string
		details map[string]any
	}{
		{
			name: "missing frames preserve PDCA order",
			err: &workspace.CycleCompletionIncompleteError{MissingFrames: []cycle.Frame{
				cycle.FramePlan,
				cycle.FrameDo,
				cycle.FrameCheck,
				cycle.FrameAction,
			}},
			status: http.StatusBadRequest,
			code:   "CYCLE_COMPLETION_INPUT_INCOMPLETE",
			details: map[string]any{
				"missingFrames": []any{"plan", "do", "check", "action"},
			},
		},
		{
			name:   "stale Goal revision",
			err:    workspace.ErrGoalRevisionConflict,
			status: http.StatusConflict,
			code:   "GOAL_VERSION_CONFLICT",
		},
		{
			name:   "Goal state mismatch",
			err:    workspace.ErrGoalStateConflict,
			status: http.StatusConflict,
			code:   "GOAL_STATE_CONFLICT",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			completeCalls := 0
			spaces := &cycleCompletionContractWorkspaceStub{complete: func(
				_ context.Context,
				input workspace.CompleteCycleInput,
			) (workspace.CompleteCycleResult, error) {
				completeCalls++
				if input.UserID != contractUserID || input.GoalID != contractGoalID || input.CycleID != contractCycleID ||
					input.OperationID != contractOperationID || input.ExpectedGoalRevision != 5 || input.ExpectedContentRevision != 7 {
					t.Fatalf("CompleteCycle input = %#v", input)
				}
				return workspace.CompleteCycleResult{}, test.err
			}}
			router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
			response := serveContract(
				router,
				http.MethodPost,
				"/api/v1/goals/"+contractGoalID+"/cycles/"+contractCycleID+"/complete",
				`{"operationId":"`+contractOperationID+`","expectedGoalRevision":5,"expectedContentRevision":7}`,
				addContractAuthentication,
			)

			if completeCalls != 1 {
				t.Fatalf("CompleteCycle calls = %d, want 1", completeCalls)
			}
			assertContractError(t, response, test.status, test.code, test.details)
		})
	}
}

func TestFullCycleViewHTTPResponsesRequireNullablePreviousCompletedAction(t *testing.T) {
	previous := &workspace.PreviousCompletedCycleActionView{
		CycleID:             contractCycleID,
		CycleSequenceNumber: 1,
		GoalVersionNumber:   1,
		Action:              "次は通知を切る",
	}
	spaces := &cycleViewResponseContractWorkspaceStub{
		first:     workspace.CycleView{ID: contractCycleID, SequenceNumber: 1, Status: cycle.StatusActive},
		active:    workspace.CycleView{ID: contractGenerationID, SequenceNumber: 2, Status: cycle.StatusActive, PreviousCompletedCycleAction: previous},
		completed: workspace.CycleView{ID: contractCycleID, SequenceNumber: 1, Status: cycle.StatusCompleted},
		canceled:  workspace.CycleView{ID: contractGenerationID, SequenceNumber: 2, Status: cycle.StatusCanceled},
	}
	router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
	tests := []struct {
		name     string
		method   string
		path     string
		body     string
		cycleKey string
		want     *workspace.PreviousCompletedCycleActionView
	}{
		{
			name: "Start", method: http.MethodPost, path: "/api/v1/goal-drafts/" + contractDraftID + "/start",
			body: `{"operationId":"` + contractOperationID + `","expectedDraftRevision":0}`, cycleKey: "cycle",
		},
		{
			name: "GET Cycle", method: http.MethodGet,
			path:     "/api/v1/goals/" + contractGoalID + "/cycles/" + contractGenerationID,
			cycleKey: "cycle", want: previous,
		},
		{
			name: "Review trigger", method: http.MethodGet,
			path: "/api/v1/goals/" + contractGoalID + "/review", cycleKey: "triggerCycle",
		},
		{
			name: "Complete", method: http.MethodPost,
			path:     "/api/v1/goals/" + contractGoalID + "/cycles/" + contractCycleID + "/complete",
			body:     `{"operationId":"` + contractOperationID + `","expectedGoalRevision":1,"expectedContentRevision":4}`,
			cycleKey: "completedCycle",
		},
		{
			name: "Continue", method: http.MethodPost,
			path:     "/api/v1/goals/" + contractGoalID + "/review/continue",
			body:     `{"operationId":"` + contractOperationID + `","expectedGoalRevision":1,"expectedDraftRevision":0}`,
			cycleKey: "cycle", want: previous,
		},
		{
			name: "Terminate", method: http.MethodPost,
			path: "/api/v1/goals/" + contractGoalID + "/termination",
			body: `{"operationId":"` + contractOperationID + `","outcome":"ended","expectedGoalRevision":1,` +
				`"expectedState":"active_cycle","activeCycleId":"` + contractGenerationID + `","expectedCycleContentRevision":0}`,
			cycleKey: "canceledCycle",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := serveContract(router, test.method, test.path, test.body, addContractAuthentication)
			if response.Code != http.StatusOK {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			cyclePayload, ok := payload[test.cycleKey]
			if !ok {
				t.Fatalf("%s is missing from %s", test.cycleKey, response.Body.String())
			}
			var cyclePayloadObject map[string]json.RawMessage
			if err := json.Unmarshal(cyclePayload, &cyclePayloadObject); err != nil {
				t.Fatal(err)
			}
			field, ok := cyclePayloadObject["previousCompletedCycleAction"]
			if !ok {
				t.Fatalf("required nullable field is missing from %s", cyclePayload)
			}
			if test.want == nil {
				if string(field) != "null" {
					t.Fatalf("previousCompletedCycleAction = %s, want null", field)
				}
				return
			}
			var got workspace.PreviousCompletedCycleActionView
			if err := json.Unmarshal(field, &got); err != nil || got != *test.want {
				t.Fatalf("previousCompletedCycleAction = %#v, error = %v, want %#v", got, err, *test.want)
			}
		})
	}
}

func TestPreviousCompletedActionIsAbsentFromSummaryAndFramePatchWire(t *testing.T) {
	spaces := &cycleViewResponseContractWorkspaceStub{
		active:    workspace.CycleView{ID: contractGenerationID, SequenceNumber: 2, Status: cycle.StatusActive},
		completed: workspace.CycleView{ID: contractCycleID, SequenceNumber: 1, Status: cycle.StatusCompleted},
	}
	router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)

	listResponse := serveContract(
		router, http.MethodGet, "/api/v1/goals/"+contractGoalID+"/cycles", "", addContractAuthentication,
	)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("Cycle list response = %d %s", listResponse.Code, listResponse.Body.String())
	}
	var page struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &page); err != nil || len(page.Items) != 1 {
		t.Fatalf("Cycle list = %#v, error = %v", page, err)
	}
	if _, exists := page.Items[0]["previousCompletedCycleAction"]; exists {
		t.Fatalf("Cycle summary leaked full-view field: %s", listResponse.Body.String())
	}

	patchResponse := serveContract(
		router,
		http.MethodPatch,
		"/api/v1/goals/"+contractGoalID+"/cycles/"+contractGenerationID+"/frames/plan",
		`{"content":"plan","expectedFrameRevision":0}`,
		addContractAuthentication,
	)
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("Frame PATCH response = %d %s", patchResponse.Code, patchResponse.Body.String())
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(patchResponse.Body.Bytes(), &frame); err != nil {
		t.Fatal(err)
	}
	if _, exists := frame["previousCompletedCycleAction"]; exists {
		t.Fatalf("Frame PATCH leaked full-view field: %s", patchResponse.Body.String())
	}
}
