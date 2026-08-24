package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
	"github.com/fukamu/cycle/backend/internal/infrastructure/system"
)

func TestWorkspaceHTTPTerminationRejectsHistoricalCycleBeforeStaleRevision(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	now := integrationNow()
	store := NewWorkspaceStore(pool)
	provider := &contractRejectProvider{}
	service := workspace.NewService(store, store, store, store, store, store, store, store, provider, provider,
		contractIntegrationClock{now: now.Add(10 * time.Minute)}, system.RandomGenerator{}, workspace.Settings{
			MaxProgressingGoals: 2,
			CursorSigningKey:    []byte("test-cursor-key"),
			MaxProviderAttempts: 1,
		})
	router := newContractIntegrationRouter(pool, service)
	owner := bootstrapContractClient(t, router, "0198c20b-7b95-7000-8000-000000000005")
	fixture := progressingGoalFixtures()[0]
	review := prepareReviewTransitionReview(t, store, owner.userID, fixture, 2,
		"61000000-0000-7000-8000-000000000401",
		"71000000-0000-7000-8000-000000000401", now)
	continued, err := executeContinueReviewUseCase(store, context.Background(), workspace.ContinueReviewInput{
		UserID: owner.userID, GoalID: fixture.goalID,
		OperationID:          "72000000-0000-7000-8000-000000000401",
		ExpectedGoalRevision: review.Goal.Revision, ExpectedDraftRevision: review.ReviewDraft.Revision,
		CycleID: "41000000-0000-7000-8000-000000000401", Now: now.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	beforeGoal, err := executeGoalGetUseCase(store, context.Background(), owner.userID, fixture.goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeHistorical, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixture.goalID, fixture.cycleID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeActive, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixture.goalID, continued.Cycle.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	beforeCounts := readOwnerWorkspaceCounts(t, pool, owner.userID)
	operationID, err := (system.RandomGenerator{}).NewID()
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"operationId":%q,"outcome":"ended","expectedGoalRevision":%d,
"expectedState":"active_cycle","activeCycleId":%q,"expectedCycleContentRevision":4}`,
		operationID, continued.Goal.Revision+99, fixture.cycleID)
	response := performContractAuthorized(router, owner, http.MethodPost,
		"/api/v1/goals/"+fixture.goalID+"/termination", body, "")
	if response.Code != http.StatusConflict {
		t.Fatalf("historical Cycle termination = %d %s", response.Code, response.Body.String())
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Error.Code != "GOAL_STATE_CONFLICT" {
		t.Fatalf("historical Cycle termination envelope = %#v, decode error = %v", envelope, err)
	}
	afterGoal, err := executeGoalGetUseCase(store, context.Background(), owner.userID, fixture.goalID, now)
	if err != nil {
		t.Fatal(err)
	}
	afterHistorical, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixture.goalID, fixture.cycleID, now)
	if err != nil {
		t.Fatal(err)
	}
	afterActive, err := executeCycleGetUseCase(store, context.Background(), owner.userID, fixture.goalID, continued.Cycle.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(beforeGoal, afterGoal) || !reflect.DeepEqual(beforeHistorical, afterHistorical) ||
		!reflect.DeepEqual(beforeActive, afterActive) || readOwnerWorkspaceCounts(t, pool, owner.userID) != beforeCounts {
		t.Fatalf("historical Cycle termination changed state\nbefore: %#v / %#v / %#v\nafter: %#v / %#v / %#v",
			beforeGoal, beforeHistorical, beforeActive, afterGoal, afterHistorical, afterActive)
	}
	if provider.calls != 0 {
		t.Fatalf("provider calls = %d", provider.calls)
	}
}
