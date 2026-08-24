package workspace

import (
	"context"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

// GoalRefiner and ActionGenerator are operation-specific provider ports. Raw
// structured fields cross this boundary; Application validates and renders
// them with the shared Domain rules before anything is persisted.
type GoalRefiner interface {
	RefineGoal(context.Context, RefineGoalAIInput) (GoalRefineAIResult, AIUsage, error)
}

type ActionGenerator interface {
	GenerateAction(context.Context, GenerateActionAIInput) (GenerateActionAIResult, AIUsage, error)
	RefineAction(context.Context, RefineActionAIInput) (RefineActionAIResult, AIUsage, error)
}

type AIInputCycle struct {
	SequenceNumber int32        `json:"sequenceNumber"`
	Status         cycle.Status `json:"status"`
	GoalBody       string       `json:"goalBody"`
	Plan           string       `json:"plan"`
	Do             string       `json:"do"`
	Check          string       `json:"check"`
	Action         string       `json:"action"`
}

type RefineGoalAIInput struct {
	Instructions    string         `json:"-"`
	GoalBody        string         `json:"goalBody"`
	SourceText      string         `json:"sourceText"`
	PastCycles      []AIInputCycle `json:"pastCycles"`
	MaxOutputTokens int64          `json:"-"`
}

type GenerateActionAIInput struct {
	Instructions    string         `json:"-"`
	GoalBody        string         `json:"goalBody"`
	CurrentCycle    *AIInputCycle  `json:"currentCycle"`
	PastCycles      []AIInputCycle `json:"pastCycles"`
	MaxOutputTokens int64          `json:"-"`
}

type RefineActionAIInput struct {
	Instructions    string         `json:"-"`
	GoalBody        string         `json:"goalBody"`
	CurrentCycle    *AIInputCycle  `json:"currentCycle"`
	PastCycles      []AIInputCycle `json:"pastCycles"`
	MaxOutputTokens int64          `json:"-"`
}

type GoalRefineAIResult struct {
	Suggestion string
}

type GenerateActionAIResult struct {
	Actions []string
}

type RefineActionAIResult struct {
	RefinedAction string
}

// AIUsage describes one provider attempt. Application accumulates it across
// retries before passing the single logical operation to settlement.
type AIUsage struct {
	InputTokens       int64
	OutputTokens      int64
	ProviderRequestID string
	CostUSD           float64
}

// AIExecutionResult is the validated, operation-independent settlement value.
type AIExecutionResult struct {
	Output   string
	Usage    AIUsage
	Attempts int16
}
