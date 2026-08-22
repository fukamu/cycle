package workspace

import (
	"context"
	"errors"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/domain/goal"
)

var (
	ErrNotFound                      = errors.New("resource not found")
	ErrGoalDraftNotFound             = errors.New("goal draft not found")
	ErrGoalNotFound                  = errors.New("goal not found")
	ErrCycleNotFound                 = errors.New("cycle not found")
	ErrDraftAlreadyExists            = errors.New("goal creation draft already exists")
	ErrDraftTypeMismatch             = errors.New("goal draft type mismatch")
	ErrDraftRevisionConflict         = errors.New("goal draft revision conflict")
	ErrReviewRevisionConflict        = errors.New("goal review draft revision conflict")
	ErrGoalRevisionConflict          = errors.New("goal revision conflict")
	ErrGoalVersionConflict           = errors.New("goal version conflict")
	ErrGoalActiveLimit               = errors.New("progressing goal limit exceeded")
	ErrGoalReviewNotActive           = errors.New("goal review is not active")
	ErrGoalReviewInvariant           = errors.New("goal review invariant broken")
	ErrGoalStateConflict             = errors.New("goal state conflict")
	ErrGoalAlreadyTerminal           = errors.New("goal already terminal")
	ErrInvalidGoalOutcome            = errors.New("invalid goal outcome")
	ErrDeleteConfirmation            = errors.New("goal delete confirmation required")
	ErrDeleteConflict                = errors.New("goal delete conflict")
	ErrDiscardConfirmation           = errors.New("review discard confirmation required")
	ErrAIInProgress                  = errors.New("AI operation in progress")
	ErrAIInputIncomplete             = errors.New("AI input incomplete")
	ErrGoalRefineInputEmpty          = errors.New("goal refine input empty")
	ErrActionGenerateInputIncomplete = errors.New("action generate input incomplete")
	ErrActionRefineInputIncomplete   = errors.New("action refine input incomplete")
	ErrAIReplacementRequired         = errors.New("action replacement confirmation required")
	ErrAIContextStale                = errors.New("AI suggestion context stale")
	ErrAISuggestionNotFound          = errors.New("AI suggestion not found")
	ErrAIResultAlreadyAdopted        = errors.New("AI suggestion already adopted")
	ErrAIUserLimit                   = errors.New("AI user rolling limit exceeded")
	ErrAIRateLimit                   = errors.New("AI rate limit exceeded")
	ErrAIBudget                      = errors.New("AI service budget exceeded")
	ErrAIProviderUnavailable         = errors.New("AI provider unavailable")
	ErrAIProviderTimeout             = errors.New("AI provider timeout")
	ErrAIInvalidResponse             = errors.New("AI invalid response")
	ErrAIContextIsolation            = errors.New("AI context isolation violation")
	ErrAIInputBudget                 = errors.New("AI input cannot fit token budget")
	ErrIdempotencyKeyReused          = errors.New("idempotency key reused")
	ErrInvalidCursor                 = errors.New("invalid cursor")
)

type DraftAlreadyExistsError struct {
	DraftID string
}

func (err *DraftAlreadyExistsError) Error() string { return ErrDraftAlreadyExists.Error() }
func (err *DraftAlreadyExistsError) Is(target error) bool {
	return target == ErrDraftAlreadyExists
}

type AIOperationInProgressError struct {
	GenerationID string
}

func (err *AIOperationInProgressError) Error() string { return ErrAIInProgress.Error() }
func (err *AIOperationInProgressError) Is(target error) bool {
	return target == ErrAIInProgress
}

type GoalVersionView struct {
	ID            string    `json:"id"`
	VersionNumber int32     `json:"versionNumber"`
	Body          string    `json:"body"`
	CreatedAt     time.Time `json:"createdAt,omitempty"`
}

type DraftView struct {
	ID                string    `json:"id"`
	DraftType         string    `json:"draftType"`
	GoalID            *string   `json:"goalId,omitempty"`
	BaseGoalVersionID *string   `json:"baseGoalVersionId,omitempty"`
	ReviewCycleID     *string   `json:"reviewCycleId,omitempty"`
	Body              string    `json:"body"`
	Revision          int64     `json:"revision"`
	UpdatedAt         time.Time `json:"updatedAt"`
	Replayed          bool      `json:"-"`
}

type CycleView struct {
	ID                 string                    `json:"id"`
	GoalID             string                    `json:"goalId,omitempty"`
	SequenceNumber     int32                     `json:"sequenceNumber"`
	Status             cycle.Status              `json:"status"`
	GoalVersion        GoalVersionView           `json:"goalVersion"`
	StartedAt          time.Time                 `json:"startedAt"`
	CompletedAt        *time.Time                `json:"completedAt"`
	CanceledAt         *time.Time                `json:"canceledAt"`
	CancellationReason *cycle.CancellationReason `json:"cancellationReason"`
	Plan               string                    `json:"plan"`
	Do                 string                    `json:"do"`
	Check              string                    `json:"check"`
	Action             string                    `json:"action"`
	ContentRevision    int64                     `json:"contentRevision"`
	FrameRevisions     FrameRevisions            `json:"frameRevisions"`
}

type FrameRevisions struct {
	Plan   int64 `json:"plan"`
	Do     int64 `json:"do"`
	Check  int64 `json:"check"`
	Action int64 `json:"action"`
}

type CurrentWorkView struct {
	Kind                       string `json:"kind"`
	CycleID                    string `json:"cycleId,omitempty"`
	CycleSequenceNumber        int32  `json:"cycleSequenceNumber,omitempty"`
	ReviewDraftID              string `json:"reviewDraftId,omitempty"`
	TriggerCycleID             string `json:"triggerCycleId,omitempty"`
	TriggerCycleSequenceNumber int32  `json:"triggerCycleSequenceNumber,omitempty"`
}

type GoalView struct {
	ID                      string           `json:"id"`
	Status                  goal.Status      `json:"status"`
	Revision                int64            `json:"revision"`
	CurrentVersion          GoalVersionView  `json:"currentVersion"`
	CurrentWork             *CurrentWorkView `json:"currentWork"`
	NextCycleSequenceNumber int32            `json:"nextCycleSequenceNumber"`
	CycleCount              int32            `json:"cycleCount,omitempty"`
	CreatedAt               time.Time        `json:"createdAt"`
	TerminalAt              *time.Time       `json:"terminalAt"`
}

type HomeView struct {
	ProgressingGoals        []GoalView `json:"progressingGoals"`
	CreationDraft           *DraftView `json:"creationDraft"`
	CanCreateGoalDraft      bool       `json:"canCreateGoalDraft"`
	ProgressingGoalLimit    int        `json:"progressingGoalLimit"`
	CanStartProgressingGoal bool       `json:"canStartProgressingGoal"`
}

type ReviewView struct {
	Goal         GoalView  `json:"goal"`
	ReviewDraft  DraftView `json:"reviewDraft"`
	TriggerCycle CycleView `json:"triggerCycle"`
}

type GoalPage struct {
	Items      []GoalView `json:"items"`
	NextCursor *string    `json:"nextCursor"`
}

type CycleSummary struct {
	ID             string          `json:"id"`
	SequenceNumber int32           `json:"sequenceNumber"`
	Status         cycle.Status    `json:"status"`
	StartedAt      time.Time       `json:"startedAt"`
	CompletedAt    *time.Time      `json:"completedAt"`
	CanceledAt     *time.Time      `json:"canceledAt"`
	GoalVersion    GoalVersionView `json:"goalVersion"`
	PlanPreview    string          `json:"planPreview"`
}

type CyclePage struct {
	Items      []CycleSummary `json:"items"`
	NextCursor *string        `json:"nextCursor"`
}

type StartGoalInput struct {
	UserID                string
	DraftID               string
	OperationID           string
	ExpectedDraftRevision int64
	RequestHash           string
	GoalID                string
	VersionID             string
	CycleID               string
	Now                   time.Time
}

type StartGoalResult struct {
	Goal     GoalView  `json:"goal"`
	Cycle    CycleView `json:"cycle"`
	Replayed bool      `json:"replayed,omitempty"`
}

type ContinueReviewInput struct {
	UserID                string
	GoalID                string
	OperationID           string
	ExpectedGoalRevision  int64
	ExpectedDraftRevision int64
	RequestHash           string
	VersionID             string
	CycleID               string
	Now                   time.Time
}

type ContinueReviewResult struct {
	Goal           GoalView  `json:"goal"`
	VersionCreated bool      `json:"versionCreated"`
	Cycle          CycleView `json:"cycle"`
	Replayed       bool      `json:"replayed,omitempty"`
}

type CompleteCycleInput struct {
	UserID                  string
	GoalID                  string
	CycleID                 string
	ReviewDraftID           string
	OperationID             string
	ExpectedGoalRevision    int64
	ExpectedContentRevision int64
	RequestHash             string
	Now                     time.Time
}

type CompleteCycleResult struct {
	CompletedCycle CycleView              `json:"completedCycle"`
	Goal           GoalView               `json:"goal"`
	ReviewDraft    DraftView              `json:"reviewDraft"`
	Replayed       bool                   `json:"replayed,omitempty"`
	Replay         *CommandReplayResponse `json:"-"`
}

type TerminateInput struct {
	UserID                       string
	GoalID                       string
	OperationID                  string
	Outcome                      goal.Status
	ExpectedGoalRevision         int64
	ExpectedState                goal.Status
	ActiveCycleID                string
	ExpectedCycleContentRevision *int64
	ConfirmDiscardReviewDraft    bool
	RequestHash                  string
	Now                          time.Time
}

type TerminateResult struct {
	Goal          GoalView   `json:"goal"`
	CanceledCycle *CycleView `json:"canceledCycle"`
	Replayed      bool       `json:"replayed,omitempty"`
}

type CommandReplayResourceIDs struct {
	GoalID  string `json:"goalId"`
	CycleID string `json:"cycleId,omitempty"`
}

type CommandReplayResponse struct {
	Replayed         bool                     `json:"replayed"`
	Operation        string                   `json:"operation"`
	ResourceIDs      CommandReplayResourceIDs `json:"resourceIds"`
	CurrentGoalState goal.Status              `json:"currentGoalState"`
	CurrentWorkspace *CurrentWorkView         `json:"currentWorkspace"`
}

type SaveFrameInput struct {
	UserID                string
	GoalID                string
	CycleID               string
	Frame                 cycle.Frame
	Content               string
	ExpectedFrameRevision int64
	Now                   time.Time
}

type SaveFrameResult struct {
	CycleID         string      `json:"cycleId"`
	Frame           cycle.Frame `json:"frame"`
	Content         string      `json:"content"`
	FrameRevision   int64       `json:"frameRevision"`
	ContentRevision int64       `json:"contentRevision"`
	SavedAt         time.Time   `json:"savedAt"`
}

type GoalRefineInput struct {
	UserID                string
	DraftID               string
	GoalID                string
	ExpectedDraftRevision int64
	ExpectedGoalRevision  *int64
	IdempotencyKey        string
	GenerationID          string
	RemoteAddress         string
	SessionID             string
	Now                   time.Time
}

type ActionAIInput struct {
	UserID                  string
	GoalID                  string
	CycleID                 string
	Operation               string
	ExpectedContentRevision int64
	ConfirmReplace          bool
	IdempotencyKey          string
	GenerationID            string
	RemoteAddress           string
	SessionID               string
	Now                     time.Time
}

type AIContextCycle struct {
	ID             string
	GoalID         string
	SequenceNumber int32
	Status         cycle.Status
	GoalBody       string
	Plan           string
	Do             string
	Check          string
	Action         string
}

type AISnapshot struct {
	GenerationID            string
	Operation               string
	TargetRevision          int64
	SourceGoalRevision      int64
	GoalID                  string
	GoalBody                string
	SourceText              string
	CurrentCycle            *AIContextCycle
	PastCycles              []AIContextCycle
	CurrentTruncated        bool
	ReplayedOutput          *string
	ReplayedContentRevision int64
	ReplayedActionRevision  int64
}

type AIProviderCycle struct {
	SequenceNumber int32        `json:"sequenceNumber"`
	Status         cycle.Status `json:"status"`
	GoalBody       string       `json:"goalBody"`
	Plan           string       `json:"plan"`
	Do             string       `json:"do"`
	Check          string       `json:"check"`
	Action         string       `json:"action"`
}

type AIProviderRequest struct {
	Operation       string            `json:"operation"`
	GoalBody        string            `json:"goalBody"`
	SourceText      string            `json:"sourceText"`
	CurrentCycle    *AIProviderCycle  `json:"currentCycle,omitempty"`
	PastCycles      []AIProviderCycle `json:"pastCycles"`
	MaxOutputTokens int64             `json:"-"`
}

type AIProviderResult struct {
	Output            string
	InputTokens       int64
	OutputTokens      int64
	ProviderRequestID string
	CostUSD           float64
	Attempts          int16
}

type AIObservation struct {
	Operation         string
	Result            string
	Model             string
	PromptVersion     string
	InputTokens       int64
	OutputTokens      int64
	EstimatedCostUSD  float64
	ContextCycleCount int
	CurrentTruncated  bool
	Duration          time.Duration
}

type AIResponse struct {
	GenerationID        string `json:"generationId"`
	SourceDraftRevision *int64 `json:"sourceDraftRevision,omitempty"`
	SourceGoalRevision  int64  `json:"sourceGoalRevision,omitempty"`
	Suggestion          string `json:"suggestion,omitempty"`
	Action              string `json:"action,omitempty"`
	ContentRevision     int64  `json:"contentRevision,omitempty"`
	ActionRevision      int64  `json:"actionRevision,omitempty"`
	ContextChanged      bool   `json:"contextChanged"`
	Replayed            bool   `json:"replayed,omitempty"`
}

type AIProvider interface {
	Execute(context.Context, AIProviderRequest) (AIProviderResult, error)
}

type TokenCounter interface {
	Count(context.Context, string, string) (int, error)
	Truncate(context.Context, string, string, int, string) (string, error)
}

type AIObserver interface {
	ObserveAI(context.Context, AIObservation)
}

type AIContextSelector func(context.Context, AISnapshot) (AISnapshot, error)

type Store interface {
	Home(context.Context, string, int) (HomeView, error)
	CreateDraft(context.Context, string, string, string, time.Time) (DraftView, error)
	GetDraft(context.Context, string, string) (DraftView, error)
	SaveDraft(context.Context, string, string, string, int64, time.Time) (DraftView, error)
	AbandonDraft(context.Context, string, string, time.Time) error
	StartGoal(context.Context, StartGoalInput, int) (StartGoalResult, error)
	ListGoals(context.Context, string, string, string, int) (GoalPage, error)
	GetGoal(context.Context, string, string) (GoalView, error)
	GetReview(context.Context, string, string) (ReviewView, error)
	SaveReview(context.Context, string, string, string, int64, time.Time) (DraftView, error)
	ContinueReview(context.Context, ContinueReviewInput) (ContinueReviewResult, error)
	Terminate(context.Context, TerminateInput) (TerminateResult, error)
	DeleteGoal(context.Context, string, string, bool, int64, string, string, time.Time) error
	ListCycles(context.Context, string, string, string, int) (CyclePage, error)
	GetCycle(context.Context, string, string, string) (CycleView, error)
	SaveFrame(context.Context, SaveFrameInput) (SaveFrameResult, error)
	CompleteCycle(context.Context, CompleteCycleInput) (CompleteCycleResult, error)
	BeginGoalRefine(context.Context, GoalRefineInput, AIContextSelector) (AISnapshot, error)
	FinishGoalRefine(context.Context, AISnapshot, AIProviderResult, error, time.Time) (AIResponse, error)
	AdoptGoalSuggestion(context.Context, string, string, string, string, int64, *int64, time.Time) (DraftView, error)
	BeginActionAI(context.Context, ActionAIInput, AIContextSelector) (AISnapshot, error)
	FinishActionAI(context.Context, AISnapshot, AIProviderResult, error, time.Time) (AIResponse, error)
}
