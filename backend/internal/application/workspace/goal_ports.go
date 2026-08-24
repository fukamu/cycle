package workspace

import (
	"context"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type GoalListScope string

const (
	GoalListAll         GoalListScope = "all"
	GoalListProgressing GoalListScope = "progressing"
	GoalListHistory     GoalListScope = "history"
)

type GoalListQuery struct {
	UserID     string
	Scope      GoalListScope
	After      *GoalListKeyset
	FetchLimit int
}

type GoalListKeyset struct {
	Category int16
	SortTime time.Time
	GoalID   string
}

type GoalQueryRow struct {
	View     GoalView
	Category int16
	SortTime time.Time
}

type GoalQueryRepository interface {
	QueryGoalRows(context.Context, GoalListQuery) ([]GoalQueryRow, error)
	QueryGoal(context.Context, string, string) (GoalView, error)
}

type GoalUseCaseSettings struct {
	CursorSigningKey []byte
}

type GoalUnitOfWork interface {
	WithinGoalTransaction(context.Context, func(GoalTx) error) error
}

// GoalTx exposes only owner-scoped SQL and lock primitives. The Application
// use case owns ordering, idempotency, retention partitioning and exact
// affected-row invariants.
type GoalTx interface {
	LockUser(context.Context, string) error
	FindGoalDeleteReceipt(context.Context, string, string) (*GoalDeleteReceipt, error)
	LockGoalForDelete(context.Context, string, string) (GoalDeleteTarget, error)
	LockGoalDraftIDs(context.Context, string, string) ([]string, error)
	LockGoalCycleIDs(context.Context, string, string) ([]string, error)
	LockRunningGoalGenerations(context.Context, string, string) ([]GoalDeleteGeneration, error)
	LockGoalUsages(context.Context, string, string) ([]GoalDeleteUsage, error)
	SumLockedGoalReservationsByMonth(context.Context, string, string, []string) ([]MonthlyReservation, error)
	ReleaseGoalBudgetReservationCAS(context.Context, time.Time, string, time.Time) (int64, error)
	TerminalizeGoalGenerationCAS(context.Context, string, string, GoalDeleteGeneration, time.Time) (int64, error)
	FailRunningGoalUsageCAS(context.Context, string, string, string) (int64, error)
	RedactGoalUsagesCAS(context.Context, string, string, []string) (int64, error)
	DeleteExpiredFinalizedGoalUsagesCAS(context.Context, string, string, []string, time.Time) (int64, error)
	DeleteGoalCAS(context.Context, string, string, int64) (int64, error)
	InsertGoalDeleteReceipt(context.Context, GoalDeleteReceiptRecord) (int64, error)
}

type GoalDeleteReceipt struct {
	GoalID      string
	RequestHash string
	ExpiresAt   time.Time
}

type GoalDeleteTarget struct {
	Revision int64
	Status   goal.Status
}

type GoalDeleteGeneration struct {
	ID              string
	ReservedCostUSD string
}

type GoalDeleteUsage struct {
	OperationID              string
	Status                   string
	QuotaRetainUntil         time.Time
	ProviderUsageFinalizedAt *time.Time
}

type GoalDeleteReceiptRecord struct {
	UserID         string
	IdempotencyKey string
	GoalID         string
	RequestHash    string
	DeletedAt      time.Time
	ExpiresAt      time.Time
}
