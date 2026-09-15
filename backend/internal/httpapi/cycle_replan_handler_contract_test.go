package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/httpapi"
)

type cycleReplanContractWorkspaceStub struct {
	httpapi.WorkspaceService
	replan func(context.Context, workspace.ReplanCycleInput) (workspace.ReplanCycleResult, error)
}

func (stub *cycleReplanContractWorkspaceStub) ReplanCycle(
	ctx context.Context,
	input workspace.ReplanCycleInput,
) (workspace.ReplanCycleResult, error) {
	if stub.replan == nil {
		panic("unexpected ReplanCycle call")
	}
	return stub.replan(ctx, input)
}

func TestReplanCycleHTTPContract(t *testing.T) {
	const successorCycleID = contractGenerationID
	want := workspace.ReplanCycleResult{
		CanceledCycle: workspace.CycleView{ID: contractCycleID, Status: cycle.StatusCanceled},
		Goal:          workspace.GoalView{ID: contractGoalID},
		Cycle:         workspace.CycleView{ID: successorCycleID, Status: cycle.StatusActive},
	}
	called := 0
	spaces := &cycleReplanContractWorkspaceStub{replan: func(
		_ context.Context,
		input workspace.ReplanCycleInput,
	) (workspace.ReplanCycleResult, error) {
		called++
		assertReplanCycleInput(t, input, true)
		return want, nil
	}}
	router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
	response := serveContract(
		router,
		http.MethodPost,
		"/api/v1/goals/"+contractGoalID+"/cycles/"+contractCycleID+"/replan",
		replanCycleContractBody(true),
		addContractAuthentication,
	)

	if called != 1 {
		t.Fatalf("ReplanCycle calls = %d, want 1", called)
	}
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	var got workspace.ReplanCycleResult
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.CanceledCycle.ID != want.CanceledCycle.ID || got.CanceledCycle.Status != cycle.StatusCanceled ||
		got.Goal.ID != want.Goal.ID || got.Cycle.ID != successorCycleID || got.Cycle.Status != cycle.StatusActive {
		t.Fatalf("Replan response = %#v", got)
	}
}

func TestReplanCycleErrorHTTPContract(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		confirmed bool
		status    int
		code      string
	}{
		{"confirmation", workspace.ErrReplanConfirmation, false, http.StatusBadRequest, "CYCLE_REPLAN_CONFIRMATION_REQUIRED"},
		{"Goal not found", workspace.ErrGoalNotFound, true, http.StatusNotFound, "GOAL_NOT_FOUND"},
		{"Cycle not found", workspace.ErrCycleNotFound, true, http.StatusNotFound, "CYCLE_NOT_FOUND"},
		{"Goal revision", workspace.ErrGoalRevisionConflict, true, http.StatusConflict, "GOAL_VERSION_CONFLICT"},
		{"Goal state", workspace.ErrGoalStateConflict, true, http.StatusConflict, "GOAL_STATE_CONFLICT"},
		{"Cycle inactive", cycle.ErrCycleNotActive, true, http.StatusConflict, "CYCLE_NOT_ACTIVE"},
		{"Cycle revision", cycle.ErrRevisionConflict, true, http.StatusConflict, "CYCLE_REVISION_CONFLICT"},
		{"AI running", workspace.ErrAIInProgress, true, http.StatusConflict, "AI_OPERATION_IN_PROGRESS"},
		{"operation reused", workspace.ErrIdempotencyKeyReused, true, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED"},
		{"unexpected", errors.New("storage unavailable"), true, http.StatusInternalServerError, "CYCLE_REPLAN_FAILED"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := 0
			spaces := &cycleReplanContractWorkspaceStub{replan: func(
				_ context.Context,
				input workspace.ReplanCycleInput,
			) (workspace.ReplanCycleResult, error) {
				called++
				assertReplanCycleInput(t, input, test.confirmed)
				return workspace.ReplanCycleResult{}, test.err
			}}
			router := contractRouter(authenticatedContractSessions(), spaces, &contractAccountStub{}, nil)
			response := serveContract(
				router,
				http.MethodPost,
				"/api/v1/goals/"+contractGoalID+"/cycles/"+contractCycleID+"/replan",
				replanCycleContractBody(test.confirmed),
				addContractAuthentication,
			)

			if called != 1 {
				t.Fatalf("ReplanCycle calls = %d, want 1", called)
			}
			assertContractError(t, response, test.status, test.code, nil)
		})
	}
}

func assertReplanCycleInput(t *testing.T, input workspace.ReplanCycleInput, confirmed bool) {
	t.Helper()
	if input.UserID != contractUserID || input.GoalID != contractGoalID || input.CycleID != contractCycleID ||
		input.OperationID != contractOperationID || input.ExpectedGoalRevision != 5 ||
		input.ExpectedContentRevision != 7 || input.ExpectedReviewScheduleRevision != 3 ||
		input.Confirmed != confirmed {
		t.Fatalf("ReplanCycle input = %#v", input)
	}
}

func replanCycleContractBody(confirmed bool) string {
	value := "false"
	if confirmed {
		value = "true"
	}
	return `{"operationId":"` + contractOperationID +
		`","expectedGoalRevision":5,"expectedContentRevision":7,"expectedReviewScheduleRevision":3,"confirmed":` +
		value + `}`
}
