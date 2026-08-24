package workspace

import (
	"context"
	"errors"
	"testing"

	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type perUserAIEntitlements struct {
	limits map[user.ID]Entitlements
}

func (policy perUserAIEntitlements) Limits(_ context.Context, userID user.ID) (Entitlements, error) {
	limits, ok := policy.limits[userID]
	if !ok {
		return Entitlements{}, errors.New("test user has no entitlement")
	}
	return limits, nil
}

func TestSelectAIContextForUserAppliesEntitledInputAndOutputLimits(t *testing.T) {
	service := contextTestService()
	const userID = "10000000-0000-7000-8000-000000000001"
	snapshot := AISnapshot{
		Operation: domainai.OperationActionGenerate, GoalID: "goal-1", GoalBody: "goal",
		CurrentCycle: &AIContextCycle{
			ID: "cycle-2", GoalID: "goal-1", SequenceNumber: 2, Status: cycle.StatusActive,
			Plan: "plan", Do: "do", Check: "check",
		},
		PastCycles: []AIContextCycle{{
			ID: "cycle-1", GoalID: "goal-1", SequenceNumber: 1, Status: cycle.StatusCompleted,
			GoalBody: "old goal", Plan: "old plan",
		}},
	}
	withoutPast := cloneAISnapshot(snapshot)
	withoutPast.PastCycles = nil
	inputLimit, err := service.countProviderInput(context.Background(), withoutPast)
	if err != nil {
		t.Fatal(err)
	}
	service.entitlements = perUserAIEntitlements{limits: map[user.ID]Entitlements{
		user.ID(userID): {MaxAIInputTokens: inputLimit, ActionOutputTokens: 321},
	}}

	selected, err := service.selectAIContextForUser(userID)(context.Background(), snapshot)
	if err != nil {
		t.Fatal(err)
	}
	wantHash, err := service.canonicalProviderInputHash(selected)
	if err != nil {
		t.Fatal(err)
	}
	if selected.MaxOutputTokens != 321 || len(selected.PastCycles) != 0 ||
		selected.CanonicalProviderInputHash == "" || selected.CanonicalProviderInputHash != wantHash {
		t.Fatalf("selected entitlement limits/hash = output %d, past %#v, hash %q want %q",
			selected.MaxOutputTokens, selected.PastCycles, selected.CanonicalProviderInputHash, wantHash)
	}
}

func TestCanonicalProviderInputHashIsDeterministicAndContractSensitive(t *testing.T) {
	service := contextTestService()
	service.settings.Model = "model-a"
	service.settings.GeneratePromptVersion = "action-generate-v2"
	base := AISnapshot{
		Operation: domainai.OperationActionGenerate, TargetRevision: 7, SourceGoalRevision: 4,
		GoalID: "goal-1", GoalBody: "goal", MaxOutputTokens: 800,
		CurrentCycle: &AIContextCycle{
			ID: "cycle-current", GoalID: "goal-1", SequenceNumber: 3, Status: cycle.StatusActive,
			Plan: "plan", Do: "do", Check: "check",
		},
		PastCycles: []AIContextCycle{
			{ID: "cycle-2", GoalID: "goal-1", SequenceNumber: 2, Status: cycle.StatusCompleted, GoalBody: "goal-v1", Plan: "p2"},
			{ID: "cycle-1", GoalID: "goal-1", SequenceNumber: 1, Status: cycle.StatusCanceled, GoalBody: "goal-v1", Plan: "p1"},
		},
	}
	first, second := cloneAISnapshot(base), cloneAISnapshot(base)
	if err := service.setCanonicalProviderInputHash(&first); err != nil {
		t.Fatal(err)
	}
	if err := service.setCanonicalProviderInputHash(&second); err != nil {
		t.Fatal(err)
	}
	if first.CanonicalProviderInputHash == "" || first.CanonicalProviderInputHash != second.CanonicalProviderInputHash {
		t.Fatalf("canonical hashes = %q / %q", first.CanonicalProviderInputHash, second.CanonicalProviderInputHash)
	}

	assertChanged := func(name string, changedService *Service, changed AISnapshot) {
		t.Helper()
		if err := changedService.setCanonicalProviderInputHash(&changed); err != nil {
			t.Fatal(err)
		}
		if changed.CanonicalProviderInputHash == first.CanonicalProviderInputHash {
			t.Fatalf("%s did not change canonical hash", name)
		}
	}
	changed := cloneAISnapshot(base)
	changed.TargetRevision++
	assertChanged("revision", service, changed)
	changed = cloneAISnapshot(base)
	changed.CurrentCycle.Plan = "changed plan"
	assertChanged("selected data", service, changed)
	changed = cloneAISnapshot(base)
	changed.PastCycles[0].ID = "different-cycle-id"
	assertChanged("context id", service, changed)
	changed = cloneAISnapshot(base)
	changed.PastCycles[0], changed.PastCycles[1] = changed.PastCycles[1], changed.PastCycles[0]
	assertChanged("context order", service, changed)
	modelChanged := *service
	modelChanged.settings.Model = "model-b"
	assertChanged("model", &modelChanged, cloneAISnapshot(base))
	promptChanged := *service
	promptChanged.settings.GeneratePromptVersion = "action-generate-v3"
	assertChanged("prompt version", &promptChanged, cloneAISnapshot(base))

	transportControlChanged := cloneAISnapshot(base)
	transportControlChanged.MaxOutputTokens++
	if err := service.setCanonicalProviderInputHash(&transportControlChanged); err != nil {
		t.Fatal(err)
	}
	if transportControlChanged.CanonicalProviderInputHash != first.CanonicalProviderInputHash {
		t.Fatal("transport-only max output tokens changed the logical provider input hash")
	}
}
