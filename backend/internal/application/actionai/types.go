package actionai

import (
	"context"
	"errors"
	"time"

	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

type GenerationType string

const (
	GenerationGenerate GenerationType = "generate"
	GenerationRefine   GenerationType = "refine"
)

var (
	ErrGenerateInputIncomplete = errors.New("AI generate input is incomplete")
	ErrRefineInputIncomplete   = errors.New("AI refine input is incomplete")
	ErrRevisionConflict        = errors.New("AI cycle revision conflict")
	ErrOperationInProgress     = errors.New("AI operation is in progress")
	ErrReplacementRequired     = errors.New("action replacement confirmation is required")
	ErrUserRollingLimit        = errors.New("AI user rolling limit exceeded")
	ErrRateLimit               = errors.New("AI rate limit exceeded")
	ErrServiceBudget           = errors.New("AI service budget exceeded")
	ErrProviderUnavailable     = errors.New("AI provider unavailable")
	ErrProviderTimeout         = errors.New("AI provider timeout")
	ErrInvalidResponse         = errors.New("AI provider returned an invalid response")
	ErrTargetGone              = errors.New("AI target no longer exists")
)

type IncompleteError struct {
	MissingFrames []domaincycle.Frame
	Refine        bool
}

func (err *IncompleteError) Error() string {
	if err.Refine {
		return ErrRefineInputIncomplete.Error()
	}
	return ErrGenerateInputIncomplete.Error()
}

func (err *IncompleteError) Unwrap() error {
	if err.Refine {
		return ErrRefineInputIncomplete
	}
	return ErrGenerateInputIncomplete
}

type Snapshot struct {
	Current domaincycle.PDCACycle
	Past    []domaincycle.PDCACycle
}

type BuiltContext struct {
	Instructions     string
	Input            string
	ContextCycleIDs  []domaincycle.ID
	InputHash        string
	CurrentTruncated bool
}

type Usage struct {
	InputTokens       int64
	OutputTokens      int64
	ProviderRequestID string
}

func (usage *Usage) Add(other Usage) {
	usage.InputTokens += other.InputTokens
	usage.OutputTokens += other.OutputTokens
	if other.ProviderRequestID != "" {
		usage.ProviderRequestID = other.ProviderRequestID
	}
}

type GenerateActionAIInput struct {
	Instructions     string
	Content          string
	MaxOutputTokens  int
	SafetyIdentifier string
	Retry            bool
}

type GeneratedAction struct {
	Actions []string
	Usage   Usage
}

type RefineActionAIInput struct {
	Instructions     string
	Content          string
	MaxOutputTokens  int
	SafetyIdentifier string
	Retry            bool
}

type RefinedAction struct {
	Action string
	Usage  Usage
}

type ActionAI interface {
	Generate(context.Context, GenerateActionAIInput) (GeneratedAction, error)
	Refine(context.Context, RefineActionAIInput) (RefinedAction, error)
}

type TokenCounter interface {
	Count(string) (int, error)
	Truncate(string, int, string) (string, error)
}

type Clock interface {
	Now() time.Time
}

type IDGenerator interface {
	NewID() (string, error)
}

type Settings struct {
	Provider                 string
	Model                    string
	MaxInputTokens           int
	MaxOutputTokens          int
	ProviderTimeout          time.Duration
	MaxProviderAttempts      int
	MaxGenerationsPerUser24h int
	GeneratePromptVersion    string
	RefinePromptVersion      string
	MonthlyBudgetUSD         float64
	InputUSDPerMillion       float64
	OutputUSDPerMillion      float64
	RatePerUserMinute        int
	RatePerSessionMinute     int
	RatePerIPMinute          int
	RateLimitHMACKey         []byte
	LeaseDuration            time.Duration
}

type RequestScope struct {
	SessionID string
	IP        string
}

type StartInput struct {
	UserID                  user.ID
	CycleID                 domaincycle.ID
	GenerationID            string
	UsageEventID            string
	GenerationType          GenerationType
	IdempotencyKey          string
	ExpectedContentRevision int64
	ConfirmReplace          bool
	PromptVersion           string
	InputHash               string
	RefineSourceAction      *string
	ContextCycleIDs         []domaincycle.ID
	Model                   string
	Provider                string
	Now                     time.Time
	LeaseExpiresAt          time.Time
	BudgetMonthUTC          time.Time
	BudgetReservationUSD    float64
	MonthlyBudgetUSD        float64
	RollingLimit            int
	RatePerUserMinute       int
	RatePerSessionMinute    int
	RatePerIPMinute         int
	UserRateKey             []byte
	SessionRateKey          []byte
	IPRateKey               []byte
}

type ExistingGeneration struct {
	Status       string
	GenerationID string
	Output       string
	FailureCode  string
	Cycle        domaincycle.PDCACycle
}

type StartResult struct {
	Existing *ExistingGeneration
}

type SuccessInput struct {
	UserID             user.ID
	CycleID            domaincycle.ID
	GenerationID       string
	GenerationRevision int64
	Action             string
	AttemptCount       int
	Usage              Usage
	EstimatedCostUSD   float64
	Now                time.Time
}

type Result struct {
	GenerationID    string
	Action          string
	ContentRevision int64
	ActionRevision  int64
	ContextChanged  bool
}

type FailureInput struct {
	GenerationID     string
	FailureCode      string
	AttemptCount     int
	Usage            Usage
	EstimatedCostUSD float64
	Now              time.Time
}

type Repository interface {
	LoadSnapshot(context.Context, user.ID, domaincycle.ID) (Snapshot, error)
	Start(context.Context, StartInput) (StartResult, error)
	Succeed(context.Context, SuccessInput) (Result, error)
	Fail(context.Context, FailureInput) error
}
