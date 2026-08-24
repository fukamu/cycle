package workspace

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type actionAIUnitTestUOW struct {
	tx        *actionAIUnitTestTx
	commits   int
	rollbacks int
}

func (uow *actionAIUnitTestUOW) WithinActionAITransaction(ctx context.Context, operation func(ActionAITx) error) error {
	err := operation(uow.tx)
	if err != nil {
		uow.rollbacks++
		return err
	}
	uow.commits++
	return nil
}

type actionAIUnitTestTx struct {
	ActionAITx
	calls            []string
	target           GoalTargetState
	current          cycle.PDCACycle
	replays          []*ActionAIReplayState
	replayCalls      int
	expired          []ExpiredGeneration
	monthly          []MonthlyReservation
	usageCount       int
	budget           AIBudgetState
	rateCounts       []int
	generationRecord ActionAIGenerationRecord
	usageRecord      AIUsageRecord
	locator          *AIGenerationLocator
	settlement       ActionAISettlementState
	applyRecord      ActionAIApplyRecord
	generationSettle ActionAIGenerationSettlement
	usageSettle      AIUsageSettlement
	applyRows        int64
	terminalRows     int64
	budgetRows       int64
	usageRows        int64
	terminalCalls    int
}

func (tx *actionAIUnitTestTx) call(name string) { tx.calls = append(tx.calls, name) }

func (tx *actionAIUnitTestTx) LockUser(context.Context, string) error {
	tx.call("user")
	return nil
}

func (tx *actionAIUnitTestTx) LockGoalWithCurrentVersion(context.Context, string, string) (GoalTargetState, error) {
	tx.call("goal")
	return tx.target, nil
}

func (tx *actionAIUnitTestTx) LockActionCycle(context.Context, string, string, string) (cycle.PDCACycle, error) {
	tx.call("cycle")
	return tx.current, nil
}

func (tx *actionAIUnitTestTx) FindActionAIReplay(context.Context, string, domainai.OperationType, string) (*ActionAIReplayState, error) {
	tx.call("replay")
	index := tx.replayCalls
	tx.replayCalls++
	if index >= len(tx.replays) {
		return nil, nil
	}
	return tx.replays[index], nil
}

func (tx *actionAIUnitTestTx) LockExpiredGenerations(context.Context, string, time.Time) ([]ExpiredGeneration, error) {
	tx.call("recover")
	return tx.expired, nil
}

func (tx *actionAIUnitTestTx) SumLockedReservationsByMonth(context.Context, []string) ([]MonthlyReservation, error) {
	tx.call("sum")
	return tx.monthly, nil
}

func (tx *actionAIUnitTestTx) ReleaseBudgetReservationCAS(context.Context, time.Time, string, time.Time) (int64, error) {
	tx.call("release")
	return 1, nil
}

func (tx *actionAIUnitTestTx) ExpireGenerationCAS(context.Context, string, string, time.Time) (int64, error) {
	tx.call("expire_generation")
	return 1, nil
}

func (tx *actionAIUnitTestTx) ExpireUsageCAS(context.Context, string, time.Time, string) (int64, error) {
	tx.call("expire_usage")
	return 1, nil
}

func (tx *actionAIUnitTestTx) ListAIContextCycles(context.Context, string, string, string, int) ([]AIContextCycle, error) {
	tx.call("context")
	return nil, nil
}

func (tx *actionAIUnitTestTx) HasRunningCycleGeneration(context.Context, string, string, string) (bool, error) {
	tx.call("running")
	return false, nil
}

func (tx *actionAIUnitTestTx) CountRollingUsage(context.Context, string, time.Time) (int, error) {
	tx.call("quota")
	return tx.usageCount, nil
}

func (tx *actionAIUnitTestTx) EnsureBudgetMonth(context.Context, time.Time, time.Time) error {
	tx.call("ensure_budget")
	return nil
}

func (tx *actionAIUnitTestTx) LockBudgetMonth(context.Context, time.Time) (AIBudgetState, error) {
	tx.call("lock_budget")
	return tx.budget, nil
}

func (tx *actionAIUnitTestTx) IncrementRateBucket(_ context.Context, bucket AIRateBucket) (int, error) {
	tx.call("rate_" + bucket.Scope)
	index := len(tx.calls)
	_ = index
	if len(tx.rateCounts) == 0 {
		return 1, nil
	}
	value := tx.rateCounts[0]
	tx.rateCounts = tx.rateCounts[1:]
	return value, nil
}

func (tx *actionAIUnitTestTx) ReserveBudgetCAS(context.Context, time.Time, string, time.Time) (int64, error) {
	tx.call("reserve")
	return 1, nil
}

func (tx *actionAIUnitTestTx) InsertActionAIGeneration(_ context.Context, record ActionAIGenerationRecord) (int64, error) {
	tx.call("insert_generation")
	tx.generationRecord = record
	return 1, nil
}

func (tx *actionAIUnitTestTx) InsertAcceptedUsage(_ context.Context, record AIUsageRecord) (int64, error) {
	tx.call("insert_usage")
	tx.usageRecord = record
	return 1, nil
}

func (tx *actionAIUnitTestTx) FindGenerationLocator(context.Context, string) (*AIGenerationLocator, error) {
	tx.call("locator")
	return tx.locator, nil
}

func (tx *actionAIUnitTestTx) LockActionAIGeneration(context.Context, ActionAIGenerationKey) (ActionAISettlementState, error) {
	tx.call("generation")
	return tx.settlement, nil
}

func (tx *actionAIUnitTestTx) ApplyActionAICAS(_ context.Context, record ActionAIApplyRecord) (int64, error) {
	tx.call("apply")
	tx.applyRecord = record
	return tx.applyRows, nil
}

func (tx *actionAIUnitTestTx) TerminalizeActionAIGenerationCAS(_ context.Context, settlement ActionAIGenerationSettlement) (int64, error) {
	tx.call("terminal")
	tx.terminalCalls++
	tx.generationSettle = settlement
	return tx.terminalRows, nil
}

func (tx *actionAIUnitTestTx) SettleBudgetCAS(context.Context, time.Time, string, string, time.Time) (int64, error) {
	tx.call("settle_budget")
	return tx.budgetRows, nil
}

func (tx *actionAIUnitTestTx) FinalizeUsageCAS(_ context.Context, settlement AIUsageSettlement) (int64, error) {
	tx.call("finalize_usage")
	tx.usageSettle = settlement
	return tx.usageRows, nil
}

type actionAIUnitTestClock struct{ now time.Time }

func (clock actionAIUnitTestClock) Now() time.Time { return clock.now }

type actionAIUnitTestIDs struct {
	value string
	calls int
}

func (ids *actionAIUnitTestIDs) NewID() (string, error) {
	ids.calls++
	return ids.value, nil
}

func actionAIUnitFixture(now time.Time) cycle.PDCACycle {
	return cycle.PDCACycle{
		ID: "30000000-0000-7000-8000-000000000001", UserID: "10000000-0000-7000-8000-000000000001",
		GoalID: "20000000-0000-7000-8000-000000000001", GoalVersionID: "21000000-0000-7000-8000-000000000001",
		SequenceNumber: 2, Status: cycle.StatusActive, Plan: "plan", Do: "do", Check: "check", Action: "old action",
		Revisions: cycle.Revisions{Content: 7, Plan: 2, Do: 2, Check: 2, Action: 2}, UpdatedAt: now.Add(-time.Minute),
	}
}

func newActionAIUnitUseCases(tx *actionAIUnitTestTx, now time.Time, ids *actionAIUnitTestIDs) (*ActionAIUseCases, *actionAIUnitTestUOW) {
	uow := &actionAIUnitTestUOW{tx: tx}
	policy := NewStaticEntitlementPolicy(Entitlements{
		MaxProgressingGoals: 2, MaxAIOperationsPer24Hours: 10,
		MaxAIInputTokens: 12000, GoalRefineOutputTokens: 400, ActionOutputTokens: 800,
	})
	useCases := NewActionAIUseCases(uow, policy, actionAIUnitTestClock{now}, ids, ActionAIUseCaseSettings{
		Provider: "test", Model: "test-model", GeneratePromptVersion: "action-generate-v2",
		RefinePromptVersion: "action-refine-v2", MonthlyBudgetUSD: 1, ReservationUSD: 0.05,
		LeaseDuration: 2 * time.Minute, RateHashKey: []byte("rate-key"),
		AIPerUserMinute: 3, AIPerSessionMinute: 3, AIPerIPMinute: 10,
	})
	return useCases, uow
}

func actionAIUnitSelector(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
	snapshot.MaxOutputTokens = 800
	if snapshot.Operation == domainai.OperationActionGenerate && snapshot.CurrentCycle != nil {
		snapshot.CurrentCycle.Action = ""
	}
	return snapshot, nil
}

func TestBeginActionAIRejectsHistoricalCycleBeforeRecoveryOrPaidSideEffects(t *testing.T) {
	now := time.Date(2026, time.August, 24, 5, 0, 0, 0, time.UTC)
	current := actionAIUnitFixture(now)
	current.Status = cycle.StatusCompleted
	tx := &actionAIUnitTestTx{
		target:  GoalTargetState{Status: goal.StatusActiveCycle, CurrentVersionID: current.GoalVersionID, Body: "goal"},
		current: current,
	}
	ids := &actionAIUnitTestIDs{value: "40000000-0000-7000-8000-000000000001"}
	useCases, uow := newActionAIUnitUseCases(tx, now, ids)
	selectorCalls := 0
	_, err := useCases.BeginGenerate(context.Background(), ActionGenerateInput{
		UserID: current.UserID, GoalID: current.GoalID, CycleID: current.ID,
		ExpectedContentRevision: current.Revisions.Content, ConfirmReplace: true,
		IdempotencyKey: "50000000-0000-7000-8000-000000000001",
	}, func(ctx context.Context, snapshot AISnapshot) (AISnapshot, error) {
		selectorCalls++
		return actionAIUnitSelector(ctx, snapshot)
	})
	if !errors.Is(err, cycle.ErrCycleNotActive) {
		t.Fatalf("error = %v, want %v", err, cycle.ErrCycleNotActive)
	}
	if want := []string{"user", "replay", "goal", "cycle"}; !reflect.DeepEqual(tx.calls, want) {
		t.Fatalf("calls = %v, want %v", tx.calls, want)
	}
	if selectorCalls != 0 || ids.calls != 0 || uow.commits != 0 || uow.rollbacks != 1 {
		t.Fatalf("selector/ids/commits/rollbacks = %d/%d/%d/%d", selectorCalls, ids.calls, uow.commits, uow.rollbacks)
	}
}

func TestBeginActionAIOwnsLockPolicyAndExactReservationOrder(t *testing.T) {
	now := time.Date(2026, time.August, 24, 5, 0, 0, 0, time.UTC)
	current := actionAIUnitFixture(now)
	tx := &actionAIUnitTestTx{
		target:  GoalTargetState{Status: goal.StatusActiveCycle, Revision: 4, CurrentVersionID: current.GoalVersionID, Body: "goal"},
		current: current, budget: AIBudgetState{ReservedCostUSD: "0", ActualCostUSD: "0", UnattributedCostUSD: "0"},
	}
	ids := &actionAIUnitTestIDs{value: "40000000-0000-7000-8000-000000000001"}
	useCases, uow := newActionAIUnitUseCases(tx, now, ids)
	input := ActionGenerateInput{
		UserID: current.UserID, GoalID: current.GoalID, CycleID: current.ID,
		ExpectedContentRevision: current.Revisions.Content, ConfirmReplace: true,
		IdempotencyKey: "50000000-0000-7000-8000-000000000001",
		SessionID:      "session", RemoteAddress: "203.0.113.1",
	}
	snapshot, err := useCases.BeginGenerate(context.Background(), input, actionAIUnitSelector)
	if err != nil {
		t.Fatal(err)
	}
	wantCalls := []string{
		"user", "replay", "goal", "cycle", "recover", "sum", "context", "running", "quota",
		"ensure_budget", "lock_budget", "rate_ai_user_minute", "rate_ai_session_minute", "rate_ai_ip_minute",
		"reserve", "insert_generation", "insert_usage",
	}
	if !reflect.DeepEqual(tx.calls, wantCalls) {
		t.Fatalf("calls = %v, want %v", tx.calls, wantCalls)
	}
	if uow.commits != 1 || uow.rollbacks != 0 || ids.calls != 1 || snapshot.GenerationID != ids.value {
		t.Fatalf("commit/rollback/ids/snapshot = %d/%d/%d/%#v", uow.commits, uow.rollbacks, ids.calls, snapshot)
	}
	if tx.generationRecord.Operation != domainai.OperationActionGenerate ||
		tx.generationRecord.IdempotencyRequestHash != actionAIRequestHash(actionAIInput{
			UserID: input.UserID, GoalID: input.GoalID, CycleID: input.CycleID,
			Operation: domainai.OperationActionGenerate, ExpectedContentRevision: input.ExpectedContentRevision,
			ConfirmReplace: true, IdempotencyKey: input.IdempotencyKey,
		}) || tx.generationRecord.SourceText != nil || tx.generationRecord.ReservedCostUSD != "0.05000000" ||
		tx.usageRecord.Operation != domainai.OperationActionGenerate || !tx.usageRecord.QuotaRetainUntil.Equal(AIUsageQuotaRetainUntil(now)) {
		t.Fatalf("generation/usage = %#v / %#v", tx.generationRecord, tx.usageRecord)
	}
}

func TestBeginActionAISameKeyExpiredReplayCommitsRecoveryWithoutNewUsage(t *testing.T) {
	now := time.Date(2026, time.August, 24, 5, 0, 0, 0, time.UTC)
	current := actionAIUnitFixture(now)
	input := actionAIInput{
		UserID: current.UserID, GoalID: current.GoalID, CycleID: current.ID,
		Operation: domainai.OperationActionRefine, ExpectedContentRevision: current.Revisions.Content,
		IdempotencyKey: "50000000-0000-7000-8000-000000000001",
	}
	expires := now
	generationID := "40000000-0000-7000-8000-000000000001"
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	tx := &actionAIUnitTestTx{
		target:  GoalTargetState{Status: goal.StatusActiveCycle, CurrentVersionID: current.GoalVersionID, Body: "goal"},
		current: current,
		replays: []*ActionAIReplayState{
			{GenerationID: generationID, GoalID: current.GoalID, CycleID: current.ID,
				IdempotencyRequestHash: actionAIRequestHash(input), Status: aiStatusRunning,
				TargetRevision: current.Revisions.Content, LeaseExpiresAt: &expires},
			{GenerationID: generationID, GoalID: current.GoalID, CycleID: current.ID,
				IdempotencyRequestHash: actionAIRequestHash(input), Status: aiStatusFailed,
				TargetRevision: current.Revisions.Content, FailureCode: "lease_expired"},
		},
		expired: []ExpiredGeneration{{ID: generationID, BudgetMonthUtc: month, ReservedCostUSD: "0.05"}},
		monthly: []MonthlyReservation{{MonthUtc: month, AmountUSD: "0.05"}},
	}
	ids := &actionAIUnitTestIDs{value: "unused"}
	useCases, uow := newActionAIUnitUseCases(tx, now, ids)
	_, err := useCases.BeginRefine(context.Background(), ActionRefineInput{
		UserID: input.UserID, GoalID: input.GoalID, CycleID: input.CycleID,
		ExpectedContentRevision: input.ExpectedContentRevision, IdempotencyKey: input.IdempotencyKey,
	}, actionAIUnitSelector)
	if !errors.Is(err, ErrAIProviderUnavailable) {
		t.Fatalf("error = %v, want %v", err, ErrAIProviderUnavailable)
	}
	want := []string{"user", "replay", "goal", "cycle", "recover", "sum", "release", "expire_generation", "expire_usage", "replay"}
	if !reflect.DeepEqual(tx.calls, want) || uow.commits != 1 || uow.rollbacks != 0 || ids.calls != 0 {
		t.Fatalf("calls/commit/rollback/ids = %v/%d/%d/%d", tx.calls, uow.commits, uow.rollbacks, ids.calls)
	}
}

func TestFinishActionAIAllowsPDCDriftAndAppliesOnlyAction(t *testing.T) {
	now := time.Date(2026, time.August, 24, 5, 3, 0, 0, time.UTC)
	current := actionAIUnitFixture(now)
	current.Plan, current.Do, current.Check = "new plan", "new do", "new check"
	current.Revisions.Content = 9
	generationID := "40000000-0000-7000-8000-000000000001"
	month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	tx := &actionAIUnitTestTx{
		target:  GoalTargetState{Status: goal.StatusActiveCycle, CurrentVersionID: current.GoalVersionID, Body: "goal"},
		current: current,
		locator: &AIGenerationLocator{UserID: current.UserID, GoalID: current.GoalID, CycleID: current.ID,
			Operation: domainai.OperationActionGenerate, Status: aiStatusRunning},
		settlement: ActionAISettlementState{GoalVersionID: current.GoalVersionID, BudgetMonthUtc: month,
			ReservedCostUSD: "0.05", TargetRevision: 7},
		applyRows: 1, terminalRows: 1, budgetRows: 1, usageRows: 1,
	}
	useCases, uow := newActionAIUnitUseCases(tx, now, &actionAIUnitTestIDs{})
	result := AIExecutionResult{Output: "new action", Usage: AIUsage{
		InputTokens: 10, OutputTokens: 3, ProviderRequestID: "provider-request", CostUSD: 0.0125,
	}, Attempts: 2}
	response, err := useCases.Finish(context.Background(), AISnapshot{
		GenerationID: generationID, Operation: domainai.OperationActionGenerate, TargetRevision: 7,
	}, result, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if !response.ContextChanged || response.Action != "new action" || response.ContentRevision != 10 || response.ActionRevision != 3 {
		t.Fatalf("response = %#v", response)
	}
	if tx.applyRecord.Action != "new action" || tx.applyRecord.ExpectedContentRevision != 9 ||
		tx.applyRecord.NewContentRevision != 10 || tx.applyRecord.ExpectedActionRevision != 2 || tx.applyRecord.NewActionRevision != 3 {
		t.Fatalf("apply = %#v", tx.applyRecord)
	}
	if tx.generationSettle.Status != aiStatusSucceeded || tx.generationSettle.AppliedAt == nil ||
		tx.generationSettle.EstimatedCostUSD != "0.01250000" || tx.generationSettle.AttemptCount != 2 ||
		tx.usageSettle.Status != aiStatusSucceeded || uow.commits != 1 || uow.rollbacks != 0 {
		t.Fatalf("generation/usage/transaction = %#v / %#v / %d/%d", tx.generationSettle, tx.usageSettle, uow.commits, uow.rollbacks)
	}
	wantCalls := []string{"locator", "user", "goal", "cycle", "generation", "apply", "terminal", "settle_budget", "finalize_usage"}
	if !reflect.DeepEqual(tx.calls, wantCalls) {
		t.Fatalf("calls = %v, want %v", tx.calls, wantCalls)
	}
}

func TestFinishActionAIRollsBackAllSettlementWhenActionCASMisses(t *testing.T) {
	now := time.Date(2026, time.August, 24, 5, 3, 0, 0, time.UTC)
	current := actionAIUnitFixture(now)
	generationID := "40000000-0000-7000-8000-000000000001"
	tx := &actionAIUnitTestTx{
		target: GoalTargetState{Status: goal.StatusActiveCycle, CurrentVersionID: current.GoalVersionID}, current: current,
		locator: &AIGenerationLocator{UserID: current.UserID, GoalID: current.GoalID, CycleID: current.ID,
			Operation: domainai.OperationActionRefine, Status: aiStatusRunning},
		settlement: ActionAISettlementState{GoalVersionID: current.GoalVersionID, ReservedCostUSD: "0.05",
			BudgetMonthUtc: time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC), TargetRevision: current.Revisions.Content},
		applyRows: 0, terminalRows: 1, budgetRows: 1, usageRows: 1,
	}
	useCases, uow := newActionAIUnitUseCases(tx, now, &actionAIUnitTestIDs{})
	_, err := useCases.Finish(context.Background(), AISnapshot{
		GenerationID: generationID, Operation: domainai.OperationActionRefine, TargetRevision: current.Revisions.Content,
	}, AIExecutionResult{Output: "new action"}, nil, now)
	if !errors.Is(err, ErrActionAIPersistenceInvariant) {
		t.Fatalf("error = %v, want %v", err, ErrActionAIPersistenceInvariant)
	}
	if uow.commits != 0 || uow.rollbacks != 1 || tx.terminalCalls != 0 {
		t.Fatalf("commits/rollbacks/terminal calls = %d/%d/%d", uow.commits, uow.rollbacks, tx.terminalCalls)
	}
}

func TestActionAIRequestHashIsTypedAndRequestSensitive(t *testing.T) {
	base := actionAIInput{Operation: domainai.OperationActionGenerate, GoalID: "goal", CycleID: "cycle", ExpectedContentRevision: 3}
	if actionAIRequestHash(base) != actionAIRequestHash(base) {
		t.Fatal("same request produced a different hash")
	}
	variants := []actionAIInput{base, base, base, base}
	variants[0].Operation = domainai.OperationActionRefine
	variants[1].GoalID = "other-goal"
	variants[2].ExpectedContentRevision++
	variants[3].ConfirmReplace = true
	for index, variant := range variants {
		if actionAIRequestHash(base) == actionAIRequestHash(variant) {
			t.Fatalf("variant %d produced the base hash", index)
		}
	}
}
