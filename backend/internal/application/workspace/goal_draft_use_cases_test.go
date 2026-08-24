package workspace

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

var (
	goalDraftTestNow   = time.Date(2026, time.August, 23, 1, 2, 3, 0, time.UTC)
	goalDraftTestMonth = time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
)

const (
	goalDraftTestUserID                     = "10000000-0000-7000-8000-000000000001"
	goalDraftTestDraftID                    = "20000000-0000-7000-8000-000000000001"
	goalDraftTestGenerationID               = "30000000-0000-7000-8000-000000000001"
	goalDraftTestGoalID                     = "40000000-0000-7000-8000-000000000001"
	goalDraftTestVersionID                  = "50000000-0000-7000-8000-000000000001"
	goalDraftTestCycleID                    = "60000000-0000-7000-8000-000000000001"
	goalDraftTestOperationID                = "70000000-0000-7000-8000-000000000001"
	goalDraftTestCanonicalProviderInputHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

type goalDraftFakeClock struct{ now time.Time }

func (clock goalDraftFakeClock) Now() time.Time { return clock.now }

type goalDraftFakeIDs struct {
	values []string
	index  int
}

func (ids *goalDraftFakeIDs) NewID() (string, error) {
	value := ids.values[ids.index]
	ids.index++
	return value, nil
}

type goalDraftFakeUOW struct {
	tx         GoalDraftTx
	committed  int
	rolledBack int
}

func (uow *goalDraftFakeUOW) WithinGoalDraftTransaction(ctx context.Context, operation func(GoalDraftTx) error) error {
	err := operation(uow.tx)
	if err != nil {
		uow.rolledBack++
		return err
	}
	uow.committed++
	return nil
}

type goalDraftFakeEntitlementPolicy struct {
	tx     *goalDraftFakeTx
	limits Entitlements
	err    error
	calls  int
}

func (policy *goalDraftFakeEntitlementPolicy) Limits(context.Context, user.ID) (Entitlements, error) {
	policy.calls++
	if policy.tx != nil {
		policy.tx.trace = append(policy.tx.trace, "entitlements")
	}
	return policy.limits, policy.err
}

type goalDraftFakeTx struct {
	GoalDraftTx

	trace    []string
	fail     map[string]error
	affected map[string]int64

	openDraft                 *goal.Draft
	draft                     goal.Draft
	target                    GoalTargetState
	startReplay               *StartReplayState
	startReplayAfterClaim     *StartReplayState
	startReplayLookups        int
	refineReplay              *GoalRefineReplayState
	generations               []DraftGenerationState
	usages                    []DraftUsageState
	lockedDraftUsageIDs       []string
	redactedDraftUsageIDs     []string
	deletedDraftUsageIDs      []string
	deletedDraftGenerationIDs []string
	draftUsageDeletionCutoff  time.Time
	progressing               int
	goalView                  GoalView
	cycleView                 CycleView

	expired              []ExpiredGeneration
	monthly              []MonthlyReservation
	running              bool
	usageCount           int
	rollingAcceptedAfter time.Time
	rateCounts           map[string]int
	contexts             []AIContextCycle
	budget               AIBudgetState

	generationLocator *AIGenerationLocator
	settlementState   GoalRefineSettlementState
	usageLocator      *AIUsageLocator
	usageState        AIUsageState
	suggestion        GoalSuggestionState

	insertedDraft        goal.Draft
	initialGoal          goal.Goal
	initialVersion       goal.Version
	initialCycle         cycle.PDCACycle
	generationRecord     GoalRefineGenerationRecord
	usageRecord          AIUsageRecord
	generationSettlement AIGenerationSettlement
	usageSettlement      AIUsageSettlement
	adoptRecord          AdoptDraftRecord
	expireUsageMonth     time.Time
	expireUsageReserved  string
}

func (tx *goalDraftFakeTx) record(name string) error {
	tx.trace = append(tx.trace, name)
	return tx.fail[name]
}

func (tx *goalDraftFakeTx) mutation(name string) (int64, error) {
	if err := tx.record(name); err != nil {
		return 0, err
	}
	if rows, ok := tx.affected[name]; ok {
		return rows, nil
	}
	return 1, nil
}

func (tx *goalDraftFakeTx) LockUser(context.Context, string) error { return tx.record("lock_user") }

func (tx *goalDraftFakeTx) FindCreationDraft(context.Context, string) (*goal.Draft, error) {
	if err := tx.record("find_creation_draft"); err != nil {
		return nil, err
	}
	return tx.openDraft, nil
}

func (tx *goalDraftFakeTx) LockDraftByID(context.Context, string, string) (goal.Draft, error) {
	if err := tx.record("lock_draft"); err != nil {
		return goal.Draft{}, err
	}
	return tx.draft, nil
}

func (tx *goalDraftFakeTx) InsertCreationDraft(_ context.Context, draft goal.Draft) (int64, error) {
	tx.insertedDraft = draft
	return tx.mutation("insert_creation_draft")
}

func (tx *goalDraftFakeTx) SaveDraftCAS(context.Context, goal.Draft, int64) (int64, error) {
	return tx.mutation("save_draft")
}

func (tx *goalDraftFakeTx) DeleteCreationDraftCAS(context.Context, string, string, int64) (int64, error) {
	return tx.mutation("delete_creation_draft")
}

func (tx *goalDraftFakeTx) LockDraftGenerations(context.Context, string, string) ([]DraftGenerationState, error) {
	if err := tx.record("lock_draft_generations"); err != nil {
		return nil, err
	}
	return tx.generations, nil
}

func (tx *goalDraftFakeTx) LockDraftUsages(_ context.Context, _ string, operationIDs []string) ([]DraftUsageState, error) {
	tx.lockedDraftUsageIDs = append([]string(nil), operationIDs...)
	if err := tx.record("lock_draft_usages"); err != nil {
		return nil, err
	}
	return tx.usages, nil
}

func (tx *goalDraftFakeTx) RedactDraftUsagesCAS(_ context.Context, _ string, operationIDs []string) (int64, error) {
	tx.redactedDraftUsageIDs = append([]string(nil), operationIDs...)
	return tx.mutation("redact_draft_usages")
}

func (tx *goalDraftFakeTx) DeleteExpiredFinalizedDraftUsagesCAS(_ context.Context, _ string, operationIDs []string, now time.Time) (int64, error) {
	tx.deletedDraftUsageIDs = append([]string(nil), operationIDs...)
	tx.draftUsageDeletionCutoff = now
	return tx.mutation("delete_expired_draft_usages")
}

func (tx *goalDraftFakeTx) DeleteDraftGenerationsCAS(_ context.Context, _, _ string, generationIDs []string) (int64, error) {
	tx.deletedDraftGenerationIDs = append([]string(nil), generationIDs...)
	return tx.mutation("delete_draft_generations")
}

func (tx *goalDraftFakeTx) FindStartReplay(context.Context, string, string) (*StartReplayState, error) {
	if err := tx.record("find_start_replay"); err != nil {
		return nil, err
	}
	tx.startReplayLookups++
	if tx.startReplayLookups > 1 {
		return tx.startReplayAfterClaim, nil
	}
	return tx.startReplay, nil
}

func (tx *goalDraftFakeTx) CountProgressingGoals(context.Context, string) (int, error) {
	if err := tx.record("count_progressing_goals"); err != nil {
		return 0, err
	}
	return tx.progressing, nil
}

func (tx *goalDraftFakeTx) InsertInitialGoal(_ context.Context, current goal.Goal) (int64, error) {
	tx.initialGoal = current
	return tx.mutation("insert_initial_goal")
}

func (tx *goalDraftFakeTx) InsertInitialVersion(_ context.Context, version goal.Version) (int64, error) {
	tx.initialVersion = version
	return tx.mutation("insert_initial_version")
}

func (tx *goalDraftFakeTx) TryInsertInitialCycleClaim(_ context.Context, current cycle.PDCACycle) (int64, error) {
	tx.initialCycle = current
	return tx.mutation("insert_initial_cycle")
}

func (tx *goalDraftFakeTx) AttachDraftGenerations(context.Context, string, string, []string, string, string) (int64, error) {
	return tx.mutation("attach_draft_generations")
}

func (tx *goalDraftFakeTx) AttachUsageToGoal(context.Context, string, []string, string) (int64, error) {
	return tx.mutation("attach_usage")
}

func (tx *goalDraftFakeTx) LoadGoalView(context.Context, string, string) (GoalView, error) {
	if err := tx.record("load_goal_view"); err != nil {
		return GoalView{}, err
	}
	return tx.goalView, nil
}

func (tx *goalDraftFakeTx) LoadCycleView(context.Context, string, string, string) (CycleView, error) {
	if err := tx.record("load_cycle_view"); err != nil {
		return CycleView{}, err
	}
	return tx.cycleView, nil
}

func (tx *goalDraftFakeTx) LockGoalWithCurrentVersion(context.Context, string, string) (GoalTargetState, error) {
	if err := tx.record("lock_goal"); err != nil {
		return GoalTargetState{}, err
	}
	return tx.target, nil
}

func (tx *goalDraftFakeTx) FindGoalRefineReplay(context.Context, string, string) (*GoalRefineReplayState, error) {
	if err := tx.record("find_refine_replay"); err != nil {
		return nil, err
	}
	return tx.refineReplay, nil
}

func (tx *goalDraftFakeTx) ListAIContextCycles(context.Context, string, string, string, int) ([]AIContextCycle, error) {
	if err := tx.record("list_ai_context"); err != nil {
		return nil, err
	}
	return tx.contexts, nil
}

func (tx *goalDraftFakeTx) LockExpiredGenerations(context.Context, string, time.Time) ([]ExpiredGeneration, error) {
	if err := tx.record("lock_expired_generations"); err != nil {
		return nil, err
	}
	return tx.expired, nil
}

func (tx *goalDraftFakeTx) SumLockedReservationsByMonth(context.Context, []string) ([]MonthlyReservation, error) {
	if err := tx.record("sum_expired_reservations"); err != nil {
		return nil, err
	}
	return tx.monthly, nil
}

func (tx *goalDraftFakeTx) ReleaseBudgetReservationCAS(context.Context, time.Time, string, time.Time) (int64, error) {
	return tx.mutation("release_expired_budget")
}

func (tx *goalDraftFakeTx) ExpireGenerationCAS(_ context.Context, generationID, _ string, _ time.Time) (int64, error) {
	rows, err := tx.mutation("expire_generation")
	if err == nil && rows == 1 && tx.refineReplay != nil &&
		tx.refineReplay.GenerationID == generationID &&
		tx.refineReplay.Status == aiStatusRunning {
		tx.refineReplay.Status = aiStatusFailed
		tx.refineReplay.FailureCode = "lease_expired"
	}
	return rows, err
}

func (tx *goalDraftFakeTx) ExpireUsageCAS(_ context.Context, _ string, month time.Time, reservation string) (int64, error) {
	tx.expireUsageMonth = month
	tx.expireUsageReserved = reservation
	return tx.mutation("expire_usage")
}

func (tx *goalDraftFakeTx) HasRunningDraftGeneration(context.Context, string) (bool, error) {
	if err := tx.record("has_running_generation"); err != nil {
		return false, err
	}
	return tx.running, nil
}

func (tx *goalDraftFakeTx) CountRollingUsage(_ context.Context, _ string, acceptedAfter time.Time) (int, error) {
	tx.rollingAcceptedAfter = acceptedAfter
	if err := tx.record("count_rolling_usage"); err != nil {
		return 0, err
	}
	return tx.usageCount, nil
}

func (tx *goalDraftFakeTx) IncrementRateBucket(_ context.Context, bucket AIRateBucket) (int, error) {
	if err := tx.record("rate_" + bucket.Scope); err != nil {
		return 0, err
	}
	if count, ok := tx.rateCounts[bucket.Scope]; ok {
		return count, nil
	}
	return 1, nil
}

func (tx *goalDraftFakeTx) EnsureBudgetMonth(context.Context, time.Time, time.Time) error {
	return tx.record("ensure_budget_month")
}

func (tx *goalDraftFakeTx) LockBudgetMonth(context.Context, time.Time) (AIBudgetState, error) {
	if err := tx.record("lock_budget_month"); err != nil {
		return AIBudgetState{}, err
	}
	budget := tx.budget
	if budget.ReservedCostUSD == "" {
		budget.ReservedCostUSD = "0"
	}
	if budget.ActualCostUSD == "" {
		budget.ActualCostUSD = "0"
	}
	if budget.UnattributedCostUSD == "" {
		budget.UnattributedCostUSD = "0"
	}
	return budget, nil
}

func (tx *goalDraftFakeTx) ReserveBudgetCAS(context.Context, time.Time, string, time.Time) (int64, error) {
	return tx.mutation("reserve_budget")
}

func (tx *goalDraftFakeTx) InsertGoalRefineGeneration(_ context.Context, record GoalRefineGenerationRecord) (int64, error) {
	tx.generationRecord = record
	return tx.mutation("insert_refine_generation")
}

func (tx *goalDraftFakeTx) InsertAcceptedUsage(_ context.Context, record AIUsageRecord) (int64, error) {
	tx.usageRecord = record
	return tx.mutation("insert_usage")
}

func (tx *goalDraftFakeTx) FindGenerationLocator(context.Context, string) (*AIGenerationLocator, error) {
	if err := tx.record("find_generation_locator"); err != nil {
		return nil, err
	}
	return tx.generationLocator, nil
}

func (tx *goalDraftFakeTx) LockGoalRefineGeneration(context.Context, GoalRefineGenerationKey) (GoalRefineSettlementState, error) {
	if err := tx.record("lock_refine_generation"); err != nil {
		return GoalRefineSettlementState{}, err
	}
	return tx.settlementState, nil
}

func (tx *goalDraftFakeTx) TerminalizeGenerationCAS(_ context.Context, settlement AIGenerationSettlement) (int64, error) {
	tx.generationSettlement = settlement
	return tx.mutation("terminalize_generation")
}

func (tx *goalDraftFakeTx) SettleBudgetCAS(context.Context, time.Time, string, string, time.Time) (int64, error) {
	return tx.mutation("settle_budget")
}

func (tx *goalDraftFakeTx) FinalizeUsageCAS(_ context.Context, settlement AIUsageSettlement) (int64, error) {
	tx.usageSettlement = settlement
	return tx.mutation("finalize_usage")
}

func (tx *goalDraftFakeTx) FindUsageLocator(context.Context, string) (*AIUsageLocator, error) {
	if err := tx.record("find_usage_locator"); err != nil {
		return nil, err
	}
	return tx.usageLocator, nil
}

func (tx *goalDraftFakeTx) LockUsage(context.Context, string, string) (AIUsageState, error) {
	if err := tx.record("lock_usage"); err != nil {
		return AIUsageState{}, err
	}
	return tx.usageState, nil
}

func (tx *goalDraftFakeTx) AddLateActualCostCAS(context.Context, time.Time, string, time.Time) (int64, error) {
	return tx.mutation("add_late_actual_cost")
}

func (tx *goalDraftFakeTx) FinalizeLateUsageCAS(_ context.Context, settlement AIUsageSettlement) (int64, error) {
	tx.usageSettlement = settlement
	return tx.mutation("finalize_late_usage")
}

func (tx *goalDraftFakeTx) LockSucceededGoalRefineGeneration(context.Context, string, string, string) (GoalSuggestionState, error) {
	if err := tx.record("lock_suggestion"); err != nil {
		return GoalSuggestionState{}, err
	}
	return tx.suggestion, nil
}

func (tx *goalDraftFakeTx) AdoptDraftCAS(_ context.Context, record AdoptDraftRecord) (int64, error) {
	tx.adoptRecord = record
	return tx.mutation("adopt_draft")
}

func (tx *goalDraftFakeTx) MarkSuggestionAdoptedCAS(context.Context, string, int64, time.Time) (int64, error) {
	return tx.mutation("mark_suggestion_adopted")
}

func newGoalDraftTestUseCases(tx *goalDraftFakeTx, ids ...string) (*GoalDraftUseCases, *goalDraftFakeUOW) {
	return newGoalDraftTestUseCasesWithPolicy(tx, NewFreeEntitlementPolicy(10, 0, 0, 0), ids...)
}

func newGoalDraftTestUseCasesWithPolicy(tx *goalDraftFakeTx, entitlements EntitlementPolicy, ids ...string) (*GoalDraftUseCases, *goalDraftFakeUOW) {
	uow := &goalDraftFakeUOW{tx: tx}
	useCases := NewGoalDraftUseCases(uow, entitlements, goalDraftFakeClock{now: goalDraftTestNow}, &goalDraftFakeIDs{values: ids}, GoalDraftUseCaseSettings{
		Provider: "openai", Model: "test-model", GoalPromptVersion: "goal-v2",
		MonthlyBudgetUSD: 1, ReservationUSD: 0.1, LeaseDuration: 2 * time.Minute,
		RateHashKey: []byte("test-rate-key"), AIPerUserMinute: 2, AIPerSessionMinute: 2, AIPerIPMinute: 2,
	})
	return useCases, uow
}

func creationDraft(body string, revision int64) goal.Draft {
	return goal.Draft{
		ID: goalDraftTestDraftID, UserID: goalDraftTestUserID, Type: goal.DraftCreation,
		Body: body, Revision: revision, CreatedAt: goalDraftTestNow.Add(-time.Hour), UpdatedAt: goalDraftTestNow.Add(-time.Minute),
	}
}

func reviewDraft(body string, revision int64) goal.Draft {
	draft := creationDraft(body, revision)
	draft.Type = goal.DraftReview
	goalID, versionID := goalDraftTestGoalID, goalDraftTestVersionID
	draft.GoalID = &goalID
	draft.BaseGoalVersionID = &versionID
	return draft
}

func goalDraftTestAIContext(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
	snapshot.CanonicalProviderInputHash = goalDraftTestCanonicalProviderInputHash
	return snapshot, nil
}

func TestGoalDraftUseCasesCreateNormalizesAndLocksUserFirst(t *testing.T) {
	tx := &goalDraftFakeTx{}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestDraftID)
	view, err := useCases.CreateDraft(context.Background(), goalDraftTestUserID, "一行目\r\n二行目")
	if err != nil {
		t.Fatal(err)
	}
	if view.Body != "一行目\n二行目" || tx.insertedDraft.Body != view.Body {
		t.Fatalf("created Draft = %#v, inserted = %#v", view, tx.insertedDraft)
	}
	if !reflect.DeepEqual(tx.trace, []string{"lock_user", "find_creation_draft", "insert_creation_draft"}) ||
		uow.committed != 1 {
		t.Fatalf("trace/transaction = %v / %#v", tx.trace, uow)
	}
}

func TestGoalDraftUseCasesAbandonPartitionsUsageAtRetentionDeadline(t *testing.T) {
	const (
		generationA = "30000000-0000-7000-8000-000000000001"
		generationB = "30000000-0000-7000-8000-000000000002"
		generationC = "30000000-0000-7000-8000-000000000003"
	)
	finalizedAt := goalDraftTestNow.Add(-time.Minute)
	tx := &goalDraftFakeTx{
		draft: creationDraft("破棄する目標", 4),
		generations: []DraftGenerationState{
			{ID: generationA, Status: aiStatusSucceeded},
			{ID: generationB, Status: aiStatusFailed},
			{ID: generationC, Status: aiStatusFailed},
		},
		usages: []DraftUsageState{
			{OperationID: generationA, QuotaRetainUntil: goalDraftTestNow.Add(time.Nanosecond), ProviderUsageFinalizedAt: &finalizedAt},
			{OperationID: generationB, QuotaRetainUntil: goalDraftTestNow, ProviderUsageFinalizedAt: &finalizedAt},
			{OperationID: generationC, QuotaRetainUntil: goalDraftTestNow.Add(-time.Hour)},
		},
		affected: map[string]int64{
			"redact_draft_usages": 2, "delete_expired_draft_usages": 1, "delete_draft_generations": 3,
		},
	}
	useCases, uow := newGoalDraftTestUseCases(tx)
	if err := useCases.AbandonDraft(context.Background(), goalDraftTestUserID, goalDraftTestDraftID); err != nil {
		t.Fatal(err)
	}
	wantTrace := []string{
		"lock_user", "lock_draft", "lock_draft_generations", "lock_draft_usages",
		"redact_draft_usages", "delete_expired_draft_usages", "delete_draft_generations", "delete_creation_draft",
	}
	if !reflect.DeepEqual(tx.trace, wantTrace) || uow.committed != 1 || uow.rolledBack != 0 {
		t.Fatalf("trace/transaction = %v / %#v", tx.trace, uow)
	}
	if !reflect.DeepEqual(tx.redactedDraftUsageIDs, []string{generationA, generationC}) ||
		!reflect.DeepEqual(tx.deletedDraftUsageIDs, []string{generationB}) ||
		!reflect.DeepEqual(tx.deletedDraftGenerationIDs, []string{generationA, generationB, generationC}) ||
		!tx.draftUsageDeletionCutoff.Equal(goalDraftTestNow) {
		t.Fatalf("usage/generation partition = redact %v, delete %v, generations %v, cutoff %s",
			tx.redactedDraftUsageIDs, tx.deletedDraftUsageIDs, tx.deletedDraftGenerationIDs, tx.draftUsageDeletionCutoff)
	}
}

func TestGoalDraftUseCasesAbandonAllowsAlreadyCleanedFinalizedUsage(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft:       creationDraft("期限後に破棄する目標", 1),
		generations: []DraftGenerationState{{ID: goalDraftTestGenerationID, Status: aiStatusSucceeded}},
	}
	useCases, uow := newGoalDraftTestUseCases(tx)
	if err := useCases.AbandonDraft(context.Background(), goalDraftTestUserID, goalDraftTestDraftID); err != nil {
		t.Fatal(err)
	}
	wantTrace := []string{"lock_user", "lock_draft", "lock_draft_generations", "lock_draft_usages", "delete_draft_generations", "delete_creation_draft"}
	if !reflect.DeepEqual(tx.trace, wantTrace) || uow.committed != 1 {
		t.Fatalf("trace/transaction = %v / %#v", tx.trace, uow)
	}
}

func TestGoalDraftUseCasesAbandonRejectsWrongTypeAndRunningAIWithoutMutation(t *testing.T) {
	t.Run("review Draft is hidden", func(t *testing.T) {
		tx := &goalDraftFakeTx{draft: reviewDraft("Review", 0)}
		useCases, uow := newGoalDraftTestUseCases(tx)
		err := useCases.AbandonDraft(context.Background(), goalDraftTestUserID, goalDraftTestDraftID)
		if !errors.Is(err, ErrNotFound) || uow.rolledBack != 1 {
			t.Fatalf("error/transaction = %v / %#v", err, uow)
		}
		if !reflect.DeepEqual(tx.trace, []string{"lock_user", "lock_draft"}) {
			t.Fatalf("trace = %v", tx.trace)
		}
	})
	t.Run("running Refine wins", func(t *testing.T) {
		tx := &goalDraftFakeTx{
			draft:       creationDraft("実行中", 0),
			generations: []DraftGenerationState{{ID: goalDraftTestGenerationID, Status: aiStatusRunning}},
		}
		useCases, uow := newGoalDraftTestUseCases(tx)
		err := useCases.AbandonDraft(context.Background(), goalDraftTestUserID, goalDraftTestDraftID)
		if !errors.Is(err, ErrAIInProgress) || uow.rolledBack != 1 {
			t.Fatalf("error/transaction = %v / %#v", err, uow)
		}
		if !reflect.DeepEqual(tx.trace, []string{"lock_user", "lock_draft", "lock_draft_generations"}) {
			t.Fatalf("trace = %v", tx.trace)
		}
	})
}

func TestGoalDraftUseCasesAbandonRequiresEveryMutationCAS(t *testing.T) {
	const (
		generationA = "30000000-0000-7000-8000-000000000001"
		generationB = "30000000-0000-7000-8000-000000000002"
	)
	finalizedAt := goalDraftTestNow.Add(-time.Minute)
	for _, mutation := range []string{
		"redact_draft_usages", "delete_expired_draft_usages", "delete_draft_generations", "delete_creation_draft",
	} {
		t.Run(mutation, func(t *testing.T) {
			affected := map[string]int64{
				"redact_draft_usages": 1, "delete_expired_draft_usages": 1,
				"delete_draft_generations": 2, "delete_creation_draft": 1,
			}
			affected[mutation] = 0
			tx := &goalDraftFakeTx{
				draft: creationDraft("CASを検証", 2),
				generations: []DraftGenerationState{
					{ID: generationA, Status: aiStatusSucceeded},
					{ID: generationB, Status: aiStatusFailed},
				},
				usages: []DraftUsageState{
					{OperationID: generationA, QuotaRetainUntil: goalDraftTestNow.Add(time.Minute), ProviderUsageFinalizedAt: &finalizedAt},
					{OperationID: generationB, QuotaRetainUntil: goalDraftTestNow, ProviderUsageFinalizedAt: &finalizedAt},
				},
				affected: affected,
			}
			useCases, uow := newGoalDraftTestUseCases(tx)
			err := useCases.AbandonDraft(context.Background(), goalDraftTestUserID, goalDraftTestDraftID)
			if !errors.Is(err, ErrGoalDraftPersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
				t.Fatalf("error/transaction = %v / %#v", err, uow)
			}
		})
	}
}

func TestGoalDraftUseCasesAbandonRejectsUnorderedOrForeignUsageLocks(t *testing.T) {
	const (
		generationA = "30000000-0000-7000-8000-000000000001"
		generationB = "30000000-0000-7000-8000-000000000002"
	)
	for name, usages := range map[string][]DraftUsageState{
		"unordered": {
			{OperationID: generationB, QuotaRetainUntil: goalDraftTestNow},
			{OperationID: generationA, QuotaRetainUntil: goalDraftTestNow},
		},
		"foreign": {{OperationID: goalDraftTestOperationID, QuotaRetainUntil: goalDraftTestNow}},
	} {
		t.Run(name, func(t *testing.T) {
			tx := &goalDraftFakeTx{
				draft: creationDraft("lock検証", 0),
				generations: []DraftGenerationState{
					{ID: generationA, Status: aiStatusSucceeded},
					{ID: generationB, Status: aiStatusSucceeded},
				},
				usages: usages,
			}
			useCases, uow := newGoalDraftTestUseCases(tx)
			err := useCases.AbandonDraft(context.Background(), goalDraftTestUserID, goalDraftTestDraftID)
			if !errors.Is(err, ErrGoalDraftPersistenceInvariant) || uow.rolledBack != 1 {
				t.Fatalf("error/transaction = %v / %#v", err, uow)
			}
		})
	}
}

func TestGoalDraftUseCasesSaveReviewPreservesLeaseAndMissingDraftPrecedence(t *testing.T) {
	tx := &goalDraftFakeTx{
		target: GoalTargetState{Status: goal.StatusGoalReview, Revision: 4},
		draft:  reviewDraft("保存済みReview", 8),
	}
	useCases, uow := newGoalDraftTestUseCases(tx)
	view, err := useCases.SaveReview(
		context.Background(), goalDraftTestUserID, goalDraftTestGoalID, goalDraftTestDraftID, "保存済みReview", 1,
	)
	if err != nil {
		t.Fatal(err)
	}
	if view.Revision != 8 || !reflect.DeepEqual(tx.trace, []string{"lock_goal", "lock_draft"}) || uow.committed != 1 {
		t.Fatalf("view/trace/transaction = %#v / %v / %#v", view, tx.trace, uow)
	}

	tx = &goalDraftFakeTx{
		target: GoalTargetState{Status: goal.StatusGoalReview},
		fail:   map[string]error{"lock_draft": ErrNotFound},
	}
	useCases, uow = newGoalDraftTestUseCases(tx)
	_, err = useCases.SaveReview(
		context.Background(), goalDraftTestUserID, goalDraftTestGoalID, goalDraftTestDraftID, "変更", 1,
	)
	if !errors.Is(err, ErrReviewRevisionConflict) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
}

func TestGoalDraftUseCasesSaveReviewValidatesBodyAfterOwnerStateAndLease(t *testing.T) {
	invalidBody := strings.Repeat("あ", 81)
	tests := []struct {
		name  string
		tx    *goalDraftFakeTx
		want  error
		trace []string
	}{
		{
			name: "Goal missing",
			tx: &goalDraftFakeTx{
				fail: map[string]error{"lock_goal": ErrNotFound},
			},
			want: ErrNotFound, trace: []string{"lock_goal"},
		},
		{
			name: "Goal inactive",
			tx:   &goalDraftFakeTx{target: GoalTargetState{Status: goal.StatusActiveCycle}},
			want: ErrGoalReviewNotActive, trace: []string{"lock_goal"},
		},
		{
			name: "old Review generation",
			tx: &goalDraftFakeTx{
				target: GoalTargetState{Status: goal.StatusGoalReview},
				fail:   map[string]error{"lock_draft": ErrNotFound},
			},
			want: ErrReviewRevisionConflict, trace: []string{"lock_goal", "lock_draft"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			useCases, uow := newGoalDraftTestUseCases(test.tx)
			_, err := useCases.SaveReview(
				context.Background(), goalDraftTestUserID, goalDraftTestGoalID, goalDraftTestDraftID, invalidBody, 1,
			)
			if !errors.Is(err, test.want) || uow.rolledBack != 1 || !reflect.DeepEqual(test.tx.trace, test.trace) {
				t.Fatalf("error/transaction/trace = %v / %#v / %v", err, uow, test.tx.trace)
			}
		})
	}
}

func TestGoalDraftUseCasesStartBuildsAndPersistsInitialAggregateInOrder(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft:       creationDraft("開始する目標", 4),
		generations: []DraftGenerationState{{ID: goalDraftTestGenerationID, Status: aiStatusSucceeded}},
		progressing: 1,
		affected:    map[string]int64{"attach_draft_generations": 1, "attach_usage": 1},
		goalView:    GoalView{ID: goalDraftTestGoalID}, cycleView: CycleView{ID: goalDraftTestCycleID},
	}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID)
	result, err := useCases.StartGoal(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, goalDraftTestOperationID, 4,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Goal.ID != goalDraftTestGoalID || result.Cycle.ID != goalDraftTestCycleID ||
		tx.initialGoal.Status != goal.StatusActiveCycle || tx.initialVersion.VersionNumber != 1 ||
		tx.initialCycle.Status != cycle.StatusActive {
		t.Fatalf("result/aggregate = %#v / %#v / %#v / %#v", result, tx.initialGoal, tx.initialVersion, tx.initialCycle)
	}
	want := []string{
		"lock_user", "find_start_replay", "lock_draft", "lock_draft_generations", "count_progressing_goals",
		"insert_initial_goal", "insert_initial_version", "insert_initial_cycle",
		"attach_draft_generations", "attach_usage", "delete_creation_draft", "load_goal_view", "load_cycle_view",
	}
	if !reflect.DeepEqual(tx.trace, want) || uow.committed != 1 {
		t.Fatalf("trace/transaction = %v / %#v", tx.trace, uow)
	}
}

func TestGoalDraftUseCasesStartValidatesBodyBeforeRunningAndLimit(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft:       creationDraft(" ", 0),
		generations: []DraftGenerationState{{ID: goalDraftTestGenerationID, Status: aiStatusRunning}},
		progressing: 2,
	}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID)
	_, err := useCases.StartGoal(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, goalDraftTestOperationID, 0,
	)
	if !errors.Is(err, goal.ErrTextRequired) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
	if !reflect.DeepEqual(tx.trace, []string{"lock_user", "find_start_replay", "lock_draft"}) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesBeginRefineOwnsQuotaRateBudgetAndPersistence(t *testing.T) {
	tx := &goalDraftFakeTx{draft: creationDraft("改善したい目標", 3)}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGenerationID)
	input := GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID, ExpectedDraftRevision: 3,
		IdempotencyKey: goalDraftTestOperationID, SessionID: "session", RemoteAddress: "192.0.2.1",
	}
	snapshot, err := useCases.BeginGoalRefine(context.Background(), input, goalDraftTestAIContext)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.GenerationID != goalDraftTestGenerationID ||
		tx.generationRecord.IdempotencyRequestHash != goalRefineRequestHash(input) ||
		tx.generationRecord.CanonicalProviderInputHash != goalDraftTestCanonicalProviderInputHash ||
		tx.generationRecord.ReservedCostUSD != "0.10000000" ||
		tx.usageRecord.Operation != goalRefineOperation ||
		!tx.usageRecord.SettlementBudgetMonthUtc.Equal(goalDraftTestMonth) ||
		tx.usageRecord.SettlementReservationCostUSD != "0.10000000" ||
		!tx.rollingAcceptedAfter.Equal(goalDraftTestNow.Add(-24*time.Hour)) ||
		!tx.usageRecord.QuotaRetainUntil.Equal(goalDraftTestNow.Add(24*time.Hour+15*time.Minute)) {
		t.Fatalf("snapshot/generation/usage = %#v / %#v / %#v", snapshot, tx.generationRecord, tx.usageRecord)
	}
	want := []string{
		"lock_user", "lock_draft", "lock_expired_generations", "sum_expired_reservations", "find_refine_replay",
		"has_running_generation", "count_rolling_usage",
		"ensure_budget_month", "lock_budget_month",
		"rate_ai_user_minute", "rate_ai_session_minute", "rate_ai_ip_minute",
		"reserve_budget", "insert_refine_generation", "insert_usage",
	}
	if !reflect.DeepEqual(tx.trace, want) || uow.committed != 1 {
		t.Fatalf("trace/transaction = %v / %#v", tx.trace, uow)
	}
}

func TestGoalDraftUseCasesRejectsMissingCanonicalHashBeforePaidSideEffects(t *testing.T) {
	tx := &goalDraftFakeTx{draft: creationDraft("canonical hash required", 0)}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGenerationID)
	_, err := useCases.BeginGoalRefine(context.Background(), GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID,
		IdempotencyKey: goalDraftTestOperationID,
	}, func(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
		return snapshot, nil
	})
	if !errors.Is(err, ErrGoalDraftPersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
	want := []string{
		"lock_user", "lock_draft", "lock_expired_generations", "sum_expired_reservations",
		"find_refine_replay",
	}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v, want no paid side effects after %v", tx.trace, want)
	}
}

func TestGoalDraftUseCasesExpiredRecoveryRequiresExactCAS(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft: creationDraft("期限切れ回復", 0),
		expired: []ExpiredGeneration{{
			ID: goalDraftTestGenerationID, BudgetMonthUtc: goalDraftTestMonth, ReservedCostUSD: "0.10000000",
		}},
		monthly:  []MonthlyReservation{{MonthUtc: goalDraftTestNow, AmountUSD: "0.10000000"}},
		affected: map[string]int64{"release_expired_budget": 0},
	}
	useCases, uow := newGoalDraftTestUseCases(tx, "30000000-0000-7000-8000-000000000002")
	_, err := useCases.BeginGoalRefine(context.Background(), GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID,
		IdempotencyKey: goalDraftTestOperationID,
	}, func(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
		return snapshot, nil
	})
	if !errors.Is(err, ErrGoalDraftPersistenceInvariant) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
}

func TestGoalDraftUseCasesExpiredSameKeyReplayCommitsTerminalRecovery(t *testing.T) {
	input := GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID,
		IdempotencyKey: goalDraftTestOperationID,
	}
	tx := &goalDraftFakeTx{
		draft: creationDraft("期限切れsame-key", 0),
		refineReplay: &GoalRefineReplayState{
			GenerationID: goalDraftTestGenerationID, IdempotencyRequestHash: goalRefineRequestHash(input), Status: aiStatusRunning,
		},
		expired: []ExpiredGeneration{{
			ID: goalDraftTestGenerationID, BudgetMonthUtc: goalDraftTestMonth, ReservedCostUSD: "0.10000000",
		}},
		monthly: []MonthlyReservation{{
			MonthUtc: goalDraftTestNow, AmountUSD: "0.10000000",
		}},
	}
	useCases, uow := newGoalDraftTestUseCases(tx, "30000000-0000-7000-8000-000000000002")
	_, err := useCases.BeginGoalRefine(context.Background(), input, nil)
	if !errors.Is(err, ErrAIProviderUnavailable) || uow.committed != 1 || uow.rolledBack != 0 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
	want := []string{
		"lock_user", "lock_draft", "lock_expired_generations", "sum_expired_reservations",
		"release_expired_budget", "expire_generation", "expire_usage", "find_refine_replay",
	}
	if !reflect.DeepEqual(tx.trace, want) || tx.refineReplay.Status != aiStatusFailed ||
		!tx.expireUsageMonth.Equal(goalDraftTestMonth) || tx.expireUsageReserved != "0.10000000" {
		t.Fatalf("trace/replay = %v / %#v", tx.trace, tx.refineReplay)
	}
}

func TestGoalDraftUseCasesReplayPersistenceInvariantRollsBack(t *testing.T) {
	input := GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID,
		IdempotencyKey: goalDraftTestOperationID,
	}
	tx := &goalDraftFakeTx{
		draft: creationDraft("不正なreplay state", 0),
		refineReplay: &GoalRefineReplayState{
			GenerationID: goalDraftTestGenerationID, IdempotencyRequestHash: goalRefineRequestHash(input), Status: "unknown",
		},
	}
	useCases, uow := newGoalDraftTestUseCases(tx, "30000000-0000-7000-8000-000000000002")
	_, err := useCases.BeginGoalRefine(context.Background(), input, nil)
	if !errors.Is(err, ErrGoalDraftPersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
}

func TestGoalDraftUseCasesExactBudgetMatchesDatabaseScale(t *testing.T) {
	if got := decimalFromFloat(0.1 * 3); got != "0.30000000" {
		t.Fatalf("decimal = %q", got)
	}
	over, err := exceedsBudget(AIBudgetState{
		ReservedCostUSD: "0.10000000", ActualCostUSD: "0.10000000", UnattributedCostUSD: "0.10000000",
	}, decimalFromFloat(0.1), decimalFromFloat(0.4))
	if err != nil || over {
		t.Fatalf("exact budget boundary = %v, %v", over, err)
	}
}

func TestGoalDraftUseCasesFinishRefineUsesOrderedExactSettlement(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft: creationDraft("Provider中に編集", 2),
		generationLocator: &AIGenerationLocator{
			UserID: goalDraftTestUserID, Operation: goalRefineOperation, Status: aiStatusRunning,
			DraftID: goalDraftTestDraftID,
		},
		settlementState: GoalRefineSettlementState{
			BudgetMonthUtc: goalDraftTestNow, ReservedCostUSD: "0.10000000", TargetRevision: 1,
		},
	}
	useCases, uow := newGoalDraftTestUseCases(tx)
	response, err := useCases.FinishGoalRefine(context.Background(), AISnapshot{
		GenerationID: goalDraftTestGenerationID, TargetRevision: 1,
	}, AIExecutionResult{
		Output: "提案", Usage: AIUsage{InputTokens: 10, OutputTokens: 3, CostUSD: 0.1 * 3}, Attempts: 2,
	}, nil, goalDraftTestNow)
	if err != nil {
		t.Fatal(err)
	}
	if response.Suggestion != "提案" || !response.ContextChanged ||
		tx.generationSettlement.EstimatedCostUSD != "0.30000000" ||
		tx.usageSettlement.EstimatedCostUSD != "0.30000000" ||
		!tx.usageSettlement.ExpectedBudgetMonthUtc.Equal(goalDraftTestNow) ||
		tx.usageSettlement.ExpectedReservationCostUSD != "0.10000000" {
		t.Fatalf("response/settlement = %#v / %#v / %#v", response, tx.generationSettlement, tx.usageSettlement)
	}
	want := []string{
		"find_generation_locator", "lock_user", "lock_draft", "lock_refine_generation",
		"terminalize_generation", "settle_budget", "finalize_usage",
	}
	if !reflect.DeepEqual(tx.trace, want) || uow.committed != 1 {
		t.Fatalf("trace/transaction = %v / %#v", tx.trace, uow)
	}

	tx.affected = map[string]int64{"finalize_usage": 0}
	tx.trace = nil
	uow.committed = 0
	_, err = useCases.FinishGoalRefine(context.Background(), AISnapshot{
		GenerationID: goalDraftTestGenerationID, TargetRevision: 1,
	}, AIExecutionResult{Output: "提案"}, nil, goalDraftTestNow)
	if !errors.Is(err, ErrGoalDraftPersistenceInvariant) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
}

func TestGoalDraftUseCasesFinishShapeMismatchRollsBackWithoutLateUsageSettlement(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft: reviewDraft("不整合なReview Draft", 2),
		generationLocator: &AIGenerationLocator{
			UserID: goalDraftTestUserID, Operation: goalRefineOperation, Status: aiStatusRunning,
			DraftID: goalDraftTestDraftID,
		},
		usageLocator: &AIUsageLocator{UserID: goalDraftTestUserID, AcceptedAt: goalDraftTestNow},
	}
	useCases, uow := newGoalDraftTestUseCases(tx)
	_, err := useCases.FinishGoalRefine(context.Background(), AISnapshot{
		GenerationID: goalDraftTestGenerationID, TargetRevision: 1,
	}, AIExecutionResult{Usage: AIUsage{CostUSD: 0.1}}, nil, goalDraftTestNow)
	if !errors.Is(err, ErrGoalDraftPersistenceInvariant) || uow.rolledBack != 1 || uow.committed != 0 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
	want := []string{"find_generation_locator", "lock_user", "lock_draft"}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesFinishLateUsageCommitsBeforeNotFound(t *testing.T) {
	tx := &goalDraftFakeTx{
		usageLocator: &AIUsageLocator{UserID: goalDraftTestUserID, AcceptedAt: goalDraftTestNow},
		usageState: AIUsageState{
			AcceptedAt: goalDraftTestNow, SettlementBudgetMonthUtc: goalDraftTestMonth,
			SettlementReservationCostUSD: "0.10000000",
		},
	}
	useCases, uow := newGoalDraftTestUseCases(tx)
	_, err := useCases.FinishGoalRefine(context.Background(), AISnapshot{
		GenerationID: goalDraftTestGenerationID,
	}, AIExecutionResult{Usage: AIUsage{CostUSD: 0.1}}, nil, goalDraftTestNow.Add(time.Minute))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v", err)
	}
	want := []string{
		"find_generation_locator", "find_usage_locator", "lock_user", "lock_usage",
		"ensure_budget_month", "add_late_actual_cost", "finalize_late_usage",
	}
	if !reflect.DeepEqual(tx.trace, want) || uow.committed != 1 ||
		tx.usageSettlement.EstimatedCostUSD != "0.10000000" ||
		!tx.usageSettlement.ExpectedBudgetMonthUtc.Equal(goalDraftTestMonth) ||
		tx.usageSettlement.ExpectedReservationCostUSD != "0.10000000" {
		t.Fatalf("trace/transaction/settlement = %v / %#v / %#v", tx.trace, uow, tx.usageSettlement)
	}
}

func TestGoalDraftUseCasesAdoptSuggestionUsesBothCAS(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft:      creationDraft("元の本文", 4),
		suggestion: GoalSuggestionState{TargetRevision: 4, SourceText: "元の本文", Output: "改善した本文"},
	}
	useCases, uow := newGoalDraftTestUseCases(tx)
	view, err := useCases.AdoptGoalSuggestion(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, "", goalDraftTestGenerationID, 4, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if view.Body != "改善した本文" || view.Revision != 5 || tx.adoptRecord.ExpectedRevision != 4 {
		t.Fatalf("view/adopt = %#v / %#v", view, tx.adoptRecord)
	}
	want := []string{"lock_user", "lock_draft", "lock_suggestion", "adopt_draft", "mark_suggestion_adopted"}
	if !reflect.DeepEqual(tx.trace, want) || uow.committed != 1 {
		t.Fatalf("trace/transaction = %v / %#v", tx.trace, uow)
	}

	tx = &goalDraftFakeTx{
		draft:      creationDraft("編集後", 5),
		suggestion: GoalSuggestionState{TargetRevision: 4, SourceText: "元の本文", Output: "改善した本文"},
	}
	useCases, uow = newGoalDraftTestUseCases(tx)
	_, err = useCases.AdoptGoalSuggestion(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, "", goalDraftTestGenerationID, 5, nil,
	)
	if !errors.Is(err, ErrAIContextStale) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
}

func TestGoalDraftUseCasesRejectsSelectorContextIsolationBeforeReservation(t *testing.T) {
	tx := &goalDraftFakeTx{draft: creationDraft("隔離する目標", 0)}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGenerationID)
	_, err := useCases.BeginGoalRefine(context.Background(), GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID,
		IdempotencyKey: goalDraftTestOperationID,
	}, func(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
		snapshot.PastCycles = []AIContextCycle{{ID: goalDraftTestCycleID, GoalID: goalDraftTestGoalID}}
		return snapshot, nil
	})
	if !errors.Is(err, ErrAIContextIsolation) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
	want := []string{
		"lock_user", "lock_draft", "lock_expired_generations", "sum_expired_reservations",
		"find_refine_replay",
	}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftCreationCommandsHideReviewDraftAsNotFound(t *testing.T) {
	tx := &goalDraftFakeTx{draft: reviewDraft("Review", 2)}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID)
	_, err := useCases.StartGoal(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, goalDraftTestOperationID, 2,
	)
	if !errors.Is(err, ErrNotFound) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
	if !reflect.DeepEqual(tx.trace, []string{"lock_user", "find_start_replay", "lock_draft"}) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestFreeEntitlementPolicyReturnsTwoProgressingGoalsAndConfiguredAILimits(t *testing.T) {
	policy := NewFreeEntitlementPolicy(12, 2048, 80, 200)
	limits, err := policy.Limits(context.Background(), user.ID(goalDraftTestUserID))
	if err != nil {
		t.Fatal(err)
	}
	want := Entitlements{
		MaxProgressingGoals: 2, MaxAIOperationsPer24Hours: 12,
		MaxAIInputTokens: 2048, GoalRefineOutputTokens: 80, ActionOutputTokens: 200,
	}
	if limits != want {
		t.Fatalf("limits = %#v, want %#v", limits, want)
	}
}

func TestGoalDraftUseCasesEvaluateEntitlementUnderUserLock(t *testing.T) {
	policyErr := errors.New("entitlement unavailable")
	tx := &goalDraftFakeTx{draft: creationDraft("開始する目標", 0)}
	policy := &goalDraftFakeEntitlementPolicy{tx: tx, err: policyErr}
	useCases, uow := newGoalDraftTestUseCasesWithPolicy(
		tx, policy, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID,
	)
	_, err := useCases.StartGoal(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, goalDraftTestOperationID, 0,
	)
	if !errors.Is(err, policyErr) || uow.rolledBack != 1 || policy.calls != 1 {
		t.Fatalf("error/transaction/policy calls = %v / %#v / %d", err, uow, policy.calls)
	}
	want := []string{"lock_user", "find_start_replay", "lock_draft", "lock_draft_generations", "entitlements"}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesStartReplayBypassesEntitlementPolicy(t *testing.T) {
	requestHash := hashRequest(struct {
		DraftID  string `json:"draftId"`
		Revision int64  `json:"revision"`
	}{goalDraftTestDraftID, 4})
	tx := &goalDraftFakeTx{
		startReplay: &StartReplayState{
			GoalID: goalDraftTestGoalID, CycleID: goalDraftTestCycleID, RequestHash: requestHash,
		},
		goalView: GoalView{ID: goalDraftTestGoalID}, cycleView: CycleView{ID: goalDraftTestCycleID},
	}
	policy := &goalDraftFakeEntitlementPolicy{tx: tx, err: errors.New("must not be called")}
	useCases, uow := newGoalDraftTestUseCasesWithPolicy(
		tx, policy, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID,
	)
	result, err := useCases.StartGoal(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, goalDraftTestOperationID, 4,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Replayed || policy.calls != 0 || uow.committed != 1 {
		t.Fatalf("result/policy calls/transaction = %#v / %d / %#v", result, policy.calls, uow)
	}
	want := []string{"lock_user", "find_start_replay", "load_goal_view", "load_cycle_view"}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesBeginUsesEntitlementRollingLimit(t *testing.T) {
	tx := &goalDraftFakeTx{draft: creationDraft("AI上限", 0), usageCount: 1}
	policy := &goalDraftFakeEntitlementPolicy{
		tx: tx, limits: Entitlements{MaxProgressingGoals: 2, MaxAIOperationsPer24Hours: 1},
	}
	useCases, uow := newGoalDraftTestUseCasesWithPolicy(tx, policy, goalDraftTestGenerationID)
	_, err := useCases.BeginGoalRefine(context.Background(), GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID,
		IdempotencyKey: goalDraftTestOperationID,
	}, goalDraftTestAIContext)
	if !errors.Is(err, ErrAIUserLimit) || uow.rolledBack != 1 || policy.calls != 1 {
		t.Fatalf("error/transaction/policy calls = %v / %#v / %d", err, uow, policy.calls)
	}
	if tx.trace[len(tx.trace)-2] != "entitlements" || tx.trace[len(tx.trace)-1] != "count_rolling_usage" {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesBeginReplayBypassesEntitlementPolicy(t *testing.T) {
	input := GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID,
		GenerationID:   "30000000-0000-7000-8000-000000000099",
		IdempotencyKey: goalDraftTestOperationID,
	}
	output := "保存済み提案"
	tx := &goalDraftFakeTx{
		draft: creationDraft("replay対象", 0),
		refineReplay: &GoalRefineReplayState{
			GenerationID: goalDraftTestGenerationID, IdempotencyRequestHash: goalRefineRequestHash(input),
			Status: aiStatusSucceeded, Output: &output,
		},
	}
	policy := &goalDraftFakeEntitlementPolicy{tx: tx, err: errors.New("must not be called")}
	useCases, uow := newGoalDraftTestUseCasesWithPolicy(tx, policy)
	snapshot, err := useCases.BeginGoalRefine(context.Background(), input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ReplayedOutput == nil || *snapshot.ReplayedOutput != output ||
		policy.calls != 0 || uow.committed != 1 {
		t.Fatalf("snapshot/policy calls/transaction = %#v / %d / %#v", snapshot, policy.calls, uow)
	}
	want := []string{
		"lock_user", "lock_draft", "lock_expired_generations", "sum_expired_reservations",
		"find_refine_replay",
	}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesRejectsCrossGoalQueryContextBeforeSelector(t *testing.T) {
	tx := &goalDraftFakeTx{
		target: GoalTargetState{
			Status: goal.StatusGoalReview, Revision: 5,
			CurrentVersionID: goalDraftTestVersionID, Body: "現在の目標",
		},
		draft:    reviewDraft("Review本文", 4),
		contexts: []AIContextCycle{{ID: goalDraftTestCycleID, GoalID: "another-goal"}},
	}
	expectedGoalRevision := int64(5)
	selectorCalls := 0
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGenerationID)
	_, err := useCases.BeginGoalRefine(context.Background(), GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID, GoalID: goalDraftTestGoalID,
		ExpectedDraftRevision: 4, ExpectedGoalRevision: &expectedGoalRevision,
		IdempotencyKey: goalDraftTestOperationID,
	}, func(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
		selectorCalls++
		return snapshot, nil
	})
	if !errors.Is(err, ErrAIContextIsolation) || selectorCalls != 0 || uow.rolledBack != 1 {
		t.Fatalf("error/selector/transaction = %v / %d / %#v", err, selectorCalls, uow)
	}
	want := []string{
		"lock_user", "lock_goal", "lock_draft", "lock_expired_generations", "sum_expired_reservations",
		"find_refine_replay", "list_ai_context",
	}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesRejectsSelectorIdentityMutationBeforeReservation(t *testing.T) {
	tx := &goalDraftFakeTx{draft: creationDraft("同一snapshotを守る", 2)}
	useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGenerationID)
	_, err := useCases.BeginGoalRefine(context.Background(), GoalRefineInput{
		UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID, ExpectedDraftRevision: 2,
		IdempotencyKey: goalDraftTestOperationID,
	}, func(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
		snapshot.GenerationID = "30000000-0000-7000-8000-000000000099"
		return snapshot, nil
	})
	if !errors.Is(err, ErrAIContextIsolation) || uow.rolledBack != 1 {
		t.Fatalf("error/transaction = %v / %#v", err, uow)
	}
	want := []string{
		"lock_user", "lock_draft", "lock_expired_generations", "sum_expired_reservations",
		"find_refine_replay",
	}
	if !reflect.DeepEqual(tx.trace, want) {
		t.Fatalf("trace = %v", tx.trace)
	}
}

func TestGoalDraftUseCasesRejectsSelectorTextReplacementBeforeReservation(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(*AISnapshot)
	}{
		{
			name: "SourceText",
			mutate: func(snapshot *AISnapshot) {
				snapshot.SourceText = "別の本文"
				snapshot.CurrentTruncated = true
			},
		},
		{
			name: "GoalBody",
			mutate: func(snapshot *AISnapshot) {
				snapshot.GoalBody = "混入したGoal"
				snapshot.CurrentTruncated = true
			},
		},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			tx := &goalDraftFakeTx{draft: creationDraft("元の本文", 2)}
			useCases, uow := newGoalDraftTestUseCases(tx, goalDraftTestGenerationID)
			_, err := useCases.BeginGoalRefine(context.Background(), GoalRefineInput{
				UserID: goalDraftTestUserID, DraftID: goalDraftTestDraftID, ExpectedDraftRevision: 2,
				IdempotencyKey: goalDraftTestOperationID,
			}, func(_ context.Context, snapshot AISnapshot) (AISnapshot, error) {
				mutation.mutate(&snapshot)
				return snapshot, nil
			})
			if !errors.Is(err, ErrAIContextIsolation) || uow.rolledBack != 1 {
				t.Fatalf("error/transaction = %v / %#v", err, uow)
			}
			want := []string{
				"lock_user", "lock_draft", "lock_expired_generations", "sum_expired_reservations",
				"find_refine_replay",
			}
			if !reflect.DeepEqual(tx.trace, want) {
				t.Fatalf("trace = %v", tx.trace)
			}
		})
	}
}

func TestGoalDraftContextSelectionAllowsCanonicalTruncationShape(t *testing.T) {
	candidate := AISnapshot{SourceText: "元のDraft本文", GoalBody: "現在のGoal本文"}
	selected := candidate
	selected.SourceText = "元の" + truncationMarker
	selected.GoalBody = ""
	selected.CurrentTruncated = true
	if err := validateGoalRefineContextSelection(candidate, selected); err != nil {
		t.Fatal(err)
	}
}

func TestGoalDraftUseCasesStaticPaidEntitlementAllowsThirdProgressingGoal(t *testing.T) {
	tx := &goalDraftFakeTx{
		draft: creationDraft("3件目の目標", 0), progressing: 2,
		goalView: GoalView{ID: goalDraftTestGoalID}, cycleView: CycleView{ID: goalDraftTestCycleID},
	}
	policy := NewStaticEntitlementPolicy(Entitlements{
		MaxProgressingGoals: 3, MaxAIOperationsPer24Hours: 10,
		MaxAIInputTokens: 2048, GoalRefineOutputTokens: 80, ActionOutputTokens: 200,
	})
	useCases, uow := newGoalDraftTestUseCasesWithPolicy(
		tx, policy, goalDraftTestGoalID, goalDraftTestVersionID, goalDraftTestCycleID,
	)
	result, err := useCases.StartGoal(
		context.Background(), goalDraftTestUserID, goalDraftTestDraftID, goalDraftTestOperationID, 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Goal.ID != goalDraftTestGoalID || result.Cycle.ID != goalDraftTestCycleID ||
		uow.committed != 1 || tx.initialGoal.Status != goal.StatusActiveCycle {
		t.Fatalf("result/transaction/Goal = %#v / %#v / %#v", result, uow, tx.initialGoal)
	}
}
