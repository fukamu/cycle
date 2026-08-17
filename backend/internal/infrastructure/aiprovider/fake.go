package aiprovider

import (
	"context"
	"unicode/utf8"

	appai "github.com/matoruru/PDCAI/backend/internal/application/actionai"
)

// FakeActionAI is deterministic and is wired only when no provider key is set in
// non-production environments. Tests can use it without network access.
type FakeActionAI struct{}

func (FakeActionAI) Generate(_ context.Context, input appai.GenerateActionAIInput) (appai.GeneratedAction, error) {
	return appai.GeneratedAction{
		Actions: []string{"次の実行では、計画した手順を一つずつ確認し、完了後に結果を記録する"},
		Usage:   fakeUsage(input.Instructions + input.Content),
	}, nil
}

func (FakeActionAI) Refine(_ context.Context, input appai.RefineActionAIInput) (appai.RefinedAction, error) {
	return appai.RefinedAction{
		Action: "次の実行では、変更する手順を事前に一つ決め、実行後に結果を記録して確認する",
		Usage:  fakeUsage(input.Instructions + input.Content),
	}, nil
}

func fakeUsage(input string) appai.Usage {
	return appai.Usage{InputTokens: int64(utf8.RuneCountInString(input) / 2), OutputTokens: 32, ProviderRequestID: "fake"}
}
