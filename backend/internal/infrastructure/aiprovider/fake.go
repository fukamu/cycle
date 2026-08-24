package aiprovider

import (
	"context"
	"encoding/json"
	"unicode/utf8"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

// Fake is deterministic and must never be enabled in production.
type Fake struct{}

var (
	_ workspace.GoalRefiner     = Fake{}
	_ workspace.ActionGenerator = Fake{}
)

func (Fake) RefineGoal(_ context.Context, input workspace.RefineGoalAIInput) (workspace.GoalRefineAIResult, workspace.AIUsage, error) {
	result := workspace.GoalRefineAIResult{Suggestion: input.SourceText}
	return result, fakeUsage(input, result), nil
}

func (Fake) GenerateAction(_ context.Context, input workspace.GenerateActionAIInput) (workspace.GenerateActionAIResult, workspace.AIUsage, error) {
	if input.CurrentCycle == nil {
		return workspace.GenerateActionAIResult{}, workspace.AIUsage{}, workspace.ErrAIInputIncomplete
	}
	result := workspace.GenerateActionAIResult{Actions: []string{"次の実行では、計画した手順を一つずつ確認し、完了後に結果を記録する。"}}
	return result, fakeUsage(input, result), nil
}

func (Fake) RefineAction(_ context.Context, input workspace.RefineActionAIInput) (workspace.RefineActionAIResult, workspace.AIUsage, error) {
	if input.CurrentCycle == nil {
		return workspace.RefineActionAIResult{}, workspace.AIUsage{}, workspace.ErrAIInputIncomplete
	}
	result := workspace.RefineActionAIResult{RefinedAction: input.CurrentCycle.Action + " 次のサイクルでは実行結果を記録して確認する。"}
	return result, fakeUsage(input, result), nil
}

func fakeUsage(input, output any) workspace.AIUsage {
	encodedInput, _ := json.Marshal(input)
	encodedOutput, _ := json.Marshal(output)
	return workspace.AIUsage{
		InputTokens: int64(utf8.RuneCount(encodedInput) / 2), OutputTokens: int64(utf8.RuneCount(encodedOutput) / 2),
		ProviderRequestID: "fake",
	}
}
