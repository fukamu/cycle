package workspace

import (
	"context"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

// GoalDraftUnitOfWork owns the transaction boundary for Goal creation and
// Goal Refine persistence. The callback must be committed only when it returns
// nil; every other return value must roll the transaction back.
type GoalDraftUnitOfWork interface {
	WithinGoalDraftTransaction(context.Context, func(GoalDraftTx) error) error
}

type EntitlementPolicy interface {
	Limits(context.Context, user.ID) (Entitlements, error)
}

type Entitlements struct {
	MaxProgressingGoals       int
	MaxAIOperationsPer24Hours int
	MaxAIInputTokens          int
	GoalRefineOutputTokens    int
	ActionOutputTokens        int
}

type FreeEntitlementPolicy struct {
	limits Entitlements
}

func NewFreeEntitlementPolicy(maxAIOperationsPer24Hours, maxAIInputTokens, goalRefineOutputTokens, actionOutputTokens int) *FreeEntitlementPolicy {
	return &FreeEntitlementPolicy{limits: Entitlements{
		MaxProgressingGoals:       2,
		MaxAIOperationsPer24Hours: maxAIOperationsPer24Hours,
		MaxAIInputTokens:          maxAIInputTokens,
		GoalRefineOutputTokens:    goalRefineOutputTokens,
		ActionOutputTokens:        actionOutputTokens,
	}}
}

func (policy *FreeEntitlementPolicy) Limits(context.Context, user.ID) (Entitlements, error) {
	return policy.limits, nil
}

type StaticEntitlementPolicy struct {
	limits Entitlements
}

func NewStaticEntitlementPolicy(limits Entitlements) *StaticEntitlementPolicy {
	return &StaticEntitlementPolicy{limits: limits}
}

func (policy *StaticEntitlementPolicy) Limits(context.Context, user.ID) (Entitlements, error) {
	return policy.limits, nil
}

// GoalDraftTx is intentionally made of SQL-shaped, typed primitives. Lock
// order, policy, idempotency and exact affected-row checks belong to the
// Application use case, not to the database adapter.
type GoalDraftTx interface {
	LockUser(context.Context, string) error

	FindCreationDraft(context.Context, string) (*goal.Draft, error)
	LockDraftByID(context.Context, string, string) (goal.Draft, error)
	LockReviewDraftByGoal(context.Context, string, string) (goal.Draft, error)
	InsertCreationDraft(context.Context, goal.Draft) (int64, error)
	SaveDraftCAS(context.Context, goal.Draft, int64) (int64, error)
	DeleteCreationDraftCAS(context.Context, string, string, int64) (int64, error)

	LockDraftGenerations(context.Context, string, string) ([]DraftGenerationState, error)
	LockDraftUsages(context.Context, string, []string) ([]DraftUsageState, error)
	RedactDraftUsagesCAS(context.Context, string, []string) (int64, error)
	DeleteExpiredFinalizedDraftUsagesCAS(context.Context, string, []string, time.Time) (int64, error)
	DeleteDraftGenerationsCAS(context.Context, string, string, []string) (int64, error)

	FindStartReplay(context.Context, string, string) (*StartReplayState, error)
	CountProgressingGoals(context.Context, string) (int, error)
	InsertInitialGoal(context.Context, goal.Goal) (int64, error)
	InsertInitialVersion(context.Context, goal.Version) (int64, error)
	InsertInitialCycle(context.Context, cycle.PDCACycle) (int64, error)
	AttachDraftGenerations(context.Context, string, string, []string, string, string) (int64, error)
	AttachUsageToGoal(context.Context, string, []string, string) (int64, error)
	LoadGoalView(context.Context, string, string) (GoalView, error)
	LoadCycleView(context.Context, string, string, string) (CycleView, error)

	LockGoalWithCurrentVersion(context.Context, string, string) (GoalTargetState, error)
	FindGoalRefineReplay(context.Context, string, string) (*GoalRefineReplayState, error)
	ListAIContextCycles(context.Context, string, string, string, int) ([]AIContextCycle, error)

	LockExpiredGenerations(context.Context, string, time.Time) ([]ExpiredGeneration, error)
	SumLockedReservationsByMonth(context.Context, []string) ([]MonthlyReservation, error)
	ReleaseBudgetReservationCAS(context.Context, time.Time, string, time.Time) (int64, error)
	ExpireGenerationCAS(context.Context, string, string, time.Time) (int64, error)
	ExpireUsageCAS(context.Context, string) (int64, error)
	HasRunningDraftGeneration(context.Context, string) (bool, error)
	CountRollingUsage(context.Context, string, time.Time) (int, error)
	IncrementRateBucket(context.Context, AIRateBucket) (int, error)
	EnsureBudgetMonth(context.Context, time.Time, time.Time) error
	LockBudgetMonth(context.Context, time.Time) (AIBudgetState, error)
	ReserveBudgetCAS(context.Context, time.Time, string, time.Time) (int64, error)
	InsertGoalRefineGeneration(context.Context, GoalRefineGenerationRecord) (int64, error)
	InsertAcceptedUsage(context.Context, AIUsageRecord) (int64, error)

	FindGenerationLocator(context.Context, string) (*AIGenerationLocator, error)
	LockGoalRefineGeneration(context.Context, GoalRefineGenerationKey) (GoalRefineSettlementState, error)
	TerminalizeGenerationCAS(context.Context, AIGenerationSettlement) (int64, error)
	SettleBudgetCAS(context.Context, time.Time, string, string, time.Time) (int64, error)
	FinalizeUsageCAS(context.Context, AIUsageSettlement) (int64, error)

	FindUsageLocator(context.Context, string) (*AIUsageLocator, error)
	LockUsage(context.Context, string, string) (AIUsageState, error)
	AddLateActualCostCAS(context.Context, time.Time, string, time.Time) (int64, error)
	FinalizeLateUsageCAS(context.Context, AIUsageSettlement) (int64, error)

	LockSucceededGoalRefineGeneration(context.Context, string, string, string) (GoalSuggestionState, error)
	AdoptDraftCAS(context.Context, AdoptDraftRecord) (int64, error)
	MarkSuggestionAdoptedCAS(context.Context, string, int64, time.Time) (int64, error)
}

type GoalDraftUseCaseSettings struct {
	Provider          string
	Model             string
	GoalPromptVersion string
	MonthlyBudgetUSD  float64
	ReservationUSD    float64
	LeaseDuration     time.Duration

	RateHashKey        []byte
	AIPerUserMinute    int
	AIPerSessionMinute int
	AIPerIPMinute      int
}

type DraftGenerationState struct {
	ID     string
	Status string
}

type DraftUsageState struct {
	OperationID              string
	QuotaRetainUntil         time.Time
	ProviderUsageFinalizedAt *time.Time
}

type StartReplayState struct {
	GoalID      string
	CycleID     string
	RequestHash string
}

type GoalTargetState struct {
	Status           goal.Status
	Revision         int64
	CurrentVersionID string
	Body             string
}

type GoalRefineReplayState struct {
	GenerationID   string
	InputHash      string
	Status         string
	TargetRevision int64
	Output         *string
	FailureCode    string
	ContextChanged bool
}

type ExpiredGeneration struct {
	ID              string
	ReservedCostUSD string
}

type MonthlyReservation struct {
	MonthUtc  time.Time
	AmountUSD string
}

type AIRateBucket struct {
	Scope       string
	KeyHash     []byte
	WindowStart time.Time
	ExpiresAt   time.Time
}

type AIBudgetState struct {
	ReservedCostUSD     string
	ActualCostUSD       string
	UnattributedCostUSD string
}

type GoalRefineGenerationRecord struct {
	ID              string
	UserID          string
	DraftID         string
	GoalID          string
	GoalVersionID   string
	TargetRevision  int64
	IdempotencyKey  string
	InputHash       string
	SourceText      string
	Provider        string
	Model           string
	PromptVersion   string
	BudgetMonthUtc  time.Time
	ReservedCostUSD string
	LeaseExpiresAt  time.Time
	StartedAt       time.Time
	ContextCycleIDs []string
}

type AIUsageRecord struct {
	OperationID      string
	UserID           string
	GoalID           string
	Operation        string
	Provider         string
	Model            string
	PromptVersion    string
	AcceptedAt       time.Time
	QuotaRetainUntil time.Time
}

type AIGenerationLocator struct {
	UserID    string
	Operation string
	Status    string
	DraftID   string
	GoalID    string
	CycleID   string
}

type GoalRefineGenerationKey struct {
	GenerationID string
	UserID       string
	DraftID      string
}

type GoalRefineSettlementState struct {
	BudgetMonthUtc  time.Time
	ReservedCostUSD string
	TargetRevision  int64
}

type AIGenerationSettlement struct {
	GenerationID           string
	ExpectedReservationUSD string
	Status                 string
	Output                 *string
	InputTokens            int64
	OutputTokens           int64
	EstimatedCostUSD       string
	AttemptCount           int16
	FailureCode            string
	ProviderRequestID      string
	ContextChanged         bool
	FinishedAt             time.Time
}

type AIUsageSettlement struct {
	OperationID      string
	Status           string
	InputTokens      int64
	OutputTokens     int64
	EstimatedCostUSD string
	FinalizedAt      time.Time
}

type AIUsageLocator struct {
	UserID      string
	AcceptedAt  time.Time
	FinalizedAt *time.Time
}

type AIUsageState struct {
	AcceptedAt  time.Time
	FinalizedAt *time.Time
}

type GoalSuggestionState struct {
	TargetRevision       int64
	SourceText           string
	Output               string
	AdoptedAt            *time.Time
	AdoptedDraftRevision *int64
}

type AdoptDraftRecord struct {
	DraftID          string
	UserID           string
	ExpectedRevision int64
	Body             string
	NewRevision      int64
	UpdatedAt        time.Time
}
