package aiprovider

import (
	"context"
	"fmt"
	"unicode/utf8"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
)

// Fake is deterministic and must never be enabled in production.
type Fake struct{}

func (Fake) Execute(_ context.Context, input workspace.AIProviderRequest) (workspace.AIProviderResult, error) {
	output := ""
	switch input.Operation {
	case "goal_refine":
		output = input.SourceText
	case "action_generate":
		output = "1. 次の実行では、計画した手順を一つずつ確認し、完了後に結果を記録する。"
	case "action_refine":
		if input.CurrentCycle == nil {
			return workspace.AIProviderResult{}, workspace.ErrAIInputIncomplete
		}
		output = input.CurrentCycle.Action + " 次のサイクルでは実行結果を記録して確認する。"
	default:
		return workspace.AIProviderResult{}, fmt.Errorf("unsupported fake operation: %s", input.Operation)
	}
	return workspace.AIProviderResult{
		Output: output, InputTokens: int64(utf8.RuneCountInString(input.GoalBody+input.SourceText) / 2),
		OutputTokens: int64(utf8.RuneCountInString(output) / 2), ProviderRequestID: "fake", Attempts: 1,
	}, nil
}
