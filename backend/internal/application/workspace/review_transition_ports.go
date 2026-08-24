package workspace

import (
	"context"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

// ReviewTransitionUnitOfWork owns the READ COMMITTED transaction used by
// Continue Review and Goal termination. The callback must be committed only
// when it returns nil.
type ReviewTransitionUnitOfWork interface {
	WithinReviewTransitionTransaction(context.Context, func(ReviewTransitionTx) error) error
}

// ReviewTransitionTx exposes owner-scoped locks and exact persistence
// primitives. Application owns lock ordering, replay, Domain transitions,
// retention classification, and affected-row invariants.
type ReviewTransitionTx interface {
	FindContinueReviewReceipt(context.Context, string, string) (*ContinueReviewReceipt, error)
	FindGoalTerminationReceipt(context.Context, string, string) (*GoalTerminationReceipt, error)
	LockUser(context.Context, string) error
	LockGoal(context.Context, string, string) (goal.Goal, error)
	LockCycle(context.Context, string, string, string) (cycle.PDCACycle, error)
	LockReviewDraft(context.Context, string, string) (goal.Draft, error)
	LoadCurrentGoalVersion(context.Context, string, string, int32) (goal.Version, error)
	HasRunningGoalGeneration(context.Context, string, string) (bool, error)
	LockDraftGenerations(context.Context, string, string) ([]DraftGenerationState, error)
	LockDraftUsages(context.Context, string, []string) ([]DraftUsageState, error)

	InsertGoalVersion(context.Context, goal.Version) (int64, error)
	TryInsertReviewCycleClaim(context.Context, cycle.PDCACycle) (int64, error)
	ContinueGoalCAS(context.Context, goal.Goal, int64) (int64, error)
	AttachDraftGenerations(context.Context, string, string, []string, string, string) (int64, error)
	AttachUsageToGoal(context.Context, string, []string, string) (int64, error)
	CancelCycleCAS(context.Context, cycle.PDCACycle, int64) (int64, error)
	RedactDraftUsagesCAS(context.Context, string, []string) (int64, error)
	DeleteExpiredFinalizedDraftUsagesCAS(context.Context, string, []string, time.Time) (int64, error)
	DeleteDraftGenerationsCAS(context.Context, string, string, []string) (int64, error)
	DeleteReviewDraftCAS(context.Context, string, string, int64) (int64, error)
	TerminateGoalCAS(context.Context, goal.Goal, int64) (int64, error)

	LoadGoalView(context.Context, string, string) (GoalView, error)
	LoadCycleView(context.Context, string, string, string) (CycleView, error)
}

type ContinueReviewReceipt struct {
	GoalID         string
	CycleID        string
	RequestHash    string
	VersionCreated bool
}

type GoalTerminationReceipt struct {
	GoalID      string
	RequestHash string
}
