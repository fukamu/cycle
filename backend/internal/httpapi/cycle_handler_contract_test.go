package httpapi_test

import (
	"context"
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
