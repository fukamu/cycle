package aiprovider

import (
	"context"
	"strings"
	"testing"

	"github.com/matoruru/PDCAI/backend/internal/application/workspace"
)

func TestFakeProviderIsDeterministicAndPreservesEditableSource(t *testing.T) {
	provider := Fake{}
	goal, err := provider.Execute(context.Background(), workspace.AIProviderRequest{
		Operation: "goal_refine", SourceText: "本を読む習慣をつけたい",
	})
	if err != nil || goal.Output != "本を読む習慣をつけたい" {
		t.Fatalf("goal result/error = %#v/%v", goal, err)
	}
	action, err := provider.Execute(context.Background(), workspace.AIProviderRequest{
		Operation: "action_refine", CurrentCycle: &workspace.AIProviderCycle{Action: "メールより先に仕事をする"},
	})
	if err != nil || !strings.HasPrefix(action.Output, "メールより先に仕事をする") {
		t.Fatalf("action result/error = %#v/%v", action, err)
	}
}
