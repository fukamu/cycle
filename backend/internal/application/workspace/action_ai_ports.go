package workspace

import (
	"context"
	"time"

	domainai "github.com/fukamu/cycle/backend/internal/domain/ai"
	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

// ActionAIUnitOfWork owns the transaction boundary for accepting and
// finalizing Action Generate / Refine operations. The callback is committed
// only when it returns nil; every other return value rolls the transaction
// back.
type ActionAIUnitOfWork interface {
	WithinActionAITransaction(context.Context, func(ActionAITx) error) error
}

// ActionAITx deliberately exposes SQL-shaped, owner-scoped primitives. Lock
// order, replay, policy, Domain transitions, and exact affected-row checks are
// Application responsibilities.
type ActionAITx interface {
	LockUser(context.Context, string) error
	LockGoalWithCurrentVersion(context.Context, string, string) (GoalTargetState, error)
	LockActionCycle(context.Context, string, string, string) (cycle.PDCACycle, error)
	ListAIContextCycles(context.Context, string, string, string, int) ([]AIContextCycle, error)

	FindActionAIReplay(context.Context, string, domainai.OperationType, string) (*ActionAIReplayState, error)
	LockExpiredGenerations(context.Context, string, time.Time) ([]ExpiredGeneration, error)
	SumLockedReservationsByMonth(context.Context, []string) ([]MonthlyReservation, error)
	ReleaseBudgetReservationCAS(context.Context, time.Time, string, time.Time) (int64, error)
	ExpireGenerationCAS(context.Context, string, string, time.Time) (int64, error)
	ExpireUsageCAS(context.Context, string, time.Time, string) (int64, error)

	HasRunningCycleGeneration(context.Context, string, string, string) (bool, error)
	CountRollingUsage(context.Context, string, time.Time) (int, error)
	EnsureBudgetMonth(context.Context, time.Time, time.Time) error
	LockBudgetMonth(context.Context, time.Time) (AIBudgetState, error)
	IncrementRateBucket(context.Context, AIRateBucket) (int, error)
	ReserveBudgetCAS(context.Context, time.Time, string, time.Time) (int64, error)
	InsertActionAIGeneration(context.Context, ActionAIGenerationRecord) (int64, error)
	InsertAcceptedUsage(context.Context, AIUsageRecord) (int64, error)

	FindGenerationLocator(context.Context, string) (*AIGenerationLocator, error)
	LockActionAIGeneration(context.Context, ActionAIGenerationKey) (ActionAISettlementState, error)
	ApplyActionAICAS(context.Context, ActionAIApplyRecord) (int64, error)
	TerminalizeActionAIGenerationCAS(context.Context, ActionAIGenerationSettlement) (int64, error)
	SettleBudgetCAS(context.Context, time.Time, string, string, time.Time) (int64, error)
	FinalizeUsageCAS(context.Context, AIUsageSettlement) (int64, error)

	FindUsageLocator(context.Context, string) (*AIUsageLocator, error)
	LockUsage(context.Context, string, string) (AIUsageState, error)
	AddLateActualCostCAS(context.Context, time.Time, string, time.Time) (int64, error)
	FinalizeLateUsageCAS(context.Context, AIUsageSettlement) (int64, error)
}

type ActionAIUseCaseSettings struct {
	Provider              string
	Model                 string
	GeneratePromptVersion string
	RefinePromptVersion   string
	MonthlyBudgetUSD      float64
	ReservationUSD        float64
	LeaseDuration         time.Duration
	RateHashKey           []byte
	AIPerUserMinute       int
	AIPerSessionMinute    int
	AIPerIPMinute         int
}

type ActionGenerateInput struct {
	UserID                  string
	GoalID                  string
	CycleID                 string
	ExpectedContentRevision int64
	ConfirmReplace          bool
	IdempotencyKey          string
	GenerationID            string
	RemoteAddress           string
	SessionID               string
	Now                     time.Time
}

type ActionRefineInput struct {
	UserID                  string
	GoalID                  string
	CycleID                 string
	ExpectedContentRevision int64
	IdempotencyKey          string
	GenerationID            string
	RemoteAddress           string
	SessionID               string
	Now                     time.Time
}

type actionAIInput struct {
	UserID                  string
	GoalID                  string
	CycleID                 string
	Operation               domainai.OperationType
	ExpectedContentRevision int64
	ConfirmReplace          bool
	IdempotencyKey          string
	GenerationID            string
	RemoteAddress           string
	SessionID               string
	Now                     time.Time
}

type ActionAIReplayState struct {
	GenerationID           string
	GoalID                 string
	CycleID                string
	IdempotencyRequestHash string
	Status                 string
	TargetRevision         int64
	Output                 *string
	FailureCode            string
	ContextChanged         bool
	LeaseExpiresAt         *time.Time
}

type ActionAIGenerationRecord struct {
	ID                     string
	UserID                 string
	Operation              domainai.OperationType
	GoalID                 string
	GoalVersionID          string
	CycleID                string
	TargetRevision         int64
	IdempotencyKey         string
	IdempotencyRequestHash string
	SourceText             *string
	Provider               string
	Model                  string
	PromptVersion          string
	BudgetMonthUtc         time.Time
	ReservedCostUSD        string
	LeaseExpiresAt         time.Time
	StartedAt              time.Time
	ContextCycleIDs        []string
}

type ActionAIGenerationKey struct {
	GenerationID string
	UserID       string
	GoalID       string
	CycleID      string
	Operation    domainai.OperationType
}

type ActionAISettlementState struct {
	GoalVersionID   string
	BudgetMonthUtc  time.Time
	ReservedCostUSD string
	TargetRevision  int64
}

type ActionAIApplyRecord struct {
	UserID                  string
	GoalID                  string
	CycleID                 string
	GoalVersionID           string
	Action                  string
	ExpectedContentRevision int64
	ExpectedActionRevision  int64
	NewContentRevision      int64
	NewActionRevision       int64
	UpdatedAt               time.Time
}

type ActionAIGenerationSettlement struct {
	GenerationID           string
	Operation              domainai.OperationType
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
	AppliedAt              *time.Time
	FinishedAt             time.Time
}
