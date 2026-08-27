package aiprovider

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/fukamu/cycle/backend/internal/application/workspace"
)

func TestFakeProviderIsTypedDeterministicAndLeavesSemanticsToApplication(t *testing.T) {
	t.Parallel()

	provider := Fake{}
	goal, goalUsage, err := provider.RefineGoal(context.Background(), workspace.RefineGoalAIInput{SourceText: "  \r\n"})
	if err != nil || goal.Suggestion != "  \r\n" || goalUsage.ProviderRequestID != "fake" {
		t.Fatalf("goal result/usage/error = %#v/%#v/%v", goal, goalUsage, err)
	}
	generated, generatedUsage, err := provider.GenerateAction(context.Background(), workspace.GenerateActionAIInput{CurrentCycle: &workspace.AIInputCycle{}})
	wantActions := []string{"次の実行では、計画した手順を一つずつ確認し、完了後に結果を記録する。"}
	if err != nil || !reflect.DeepEqual(generated.Actions, wantActions) || generatedUsage.ProviderRequestID != "fake" {
		t.Fatalf("generated result/usage/error = %#v/%#v/%v", generated, generatedUsage, err)
	}
	refined, refinedUsage, err := provider.RefineAction(context.Background(), workspace.RefineActionAIInput{
		CurrentCycle: &workspace.AIInputCycle{Action: "メールより先に仕事をする"},
	})
	if err != nil || !strings.HasPrefix(refined.RefinedAction, "メールより先に仕事をする") || refinedUsage.ProviderRequestID != "fake" {
		t.Fatalf("refined result/usage/error = %#v/%#v/%v", refined, refinedUsage, err)
	}
}

func TestFakeActionProviderRejectsMissingCurrentCycle(t *testing.T) {
	t.Parallel()

	provider := Fake{}
	if _, _, err := provider.GenerateAction(context.Background(), workspace.GenerateActionAIInput{}); !errors.Is(err, workspace.ErrAIInputIncomplete) {
		t.Fatalf("GenerateAction() error = %v", err)
	}
	if _, _, err := provider.RefineAction(context.Background(), workspace.RefineActionAIInput{}); !errors.Is(err, workspace.ErrAIInputIncomplete) {
		t.Fatalf("RefineAction() error = %v", err)
	}
}
