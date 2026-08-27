package workspace

import (
	"context"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

type CycleListQuery struct {
	UserID     string
	GoalID     string
	After      *CycleListKeyset
	FetchLimit int
}

type CycleListKeyset struct {
	SequenceNumber int32
	CycleID        string
}

// CycleQueryRepository exposes only owner-scoped, decoded Cycle reads. Cursor
// verification and page construction remain Application responsibilities. A
// missing owner Goal returns ErrGoalNotFound; a missing or mismatched Cycle
// returns ErrCycleNotFound.
type CycleQueryRepository interface {
	QueryCycleRows(context.Context, CycleListQuery) ([]CycleSummary, error)
	QueryCycle(context.Context, string, string, string) (CycleView, error)
}

type CycleUseCaseSettings struct {
	CursorSigningKey []byte
}

type CycleUnitOfWork interface {
	WithinCycleTransaction(context.Context, func(CycleTx) error) error
}

// CycleTx exposes owner-scoped lock, query, and exact-CAS primitives. The
// Application use case owns lock ordering, replay, Domain transitions, and
// affected-row invariants.
type CycleTx interface {
	FindCompleteCycleReceipt(context.Context, string, string) (*CompleteCycleReceipt, error)
	LockUser(context.Context, string) error
	LockGoal(context.Context, string, string) (goal.Goal, error)
	LockCycle(context.Context, string, string, string) (cycle.PDCACycle, error)
	LoadCurrentGoalVersion(context.Context, string, string, int32) (goal.Version, error)
	HasRunningCycleGeneration(context.Context, string, string, string) (bool, error)
	SaveCycleFrameCAS(context.Context, cycle.PDCACycle, cycle.Frame, int64) (int64, error)
	CompleteCycleCAS(context.Context, cycle.PDCACycle, int64) (int64, error)
	InsertReviewDraft(context.Context, goal.Draft) (int64, error)
	EnterGoalReviewCAS(context.Context, goal.Goal, int64) (int64, error)
	LoadGoalView(context.Context, string, string) (GoalView, error)
	LoadCycleView(context.Context, string, string, string) (CycleView, error)
	FindReviewDraftByCycle(context.Context, string, string, string) (*DraftView, error)
}

type CompleteCycleReceipt struct {
	GoalID      string
	CycleID     string
	RequestHash string
}
