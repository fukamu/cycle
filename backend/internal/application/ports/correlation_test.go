package ports

import (
	"context"
	"testing"
)

func TestCorrelationContextComposesRequestAndAIGeneration(t *testing.T) {
	ctx := WithRequestCorrelation(context.Background(), "0198c20b-7b95-7000-8000-000000000001")
	ctx = WithAIGenerationCorrelation(ctx, "0198c20b-7b95-7000-8000-000000000002", "goal_refine")

	got := CorrelationFromContext(ctx)
	if got.RequestID != "0198c20b-7b95-7000-8000-000000000001" ||
		got.AIGenerationID != "0198c20b-7b95-7000-8000-000000000002" ||
		got.AIOperationType != "goal_refine" {
		t.Fatalf("unexpected correlation: %#v", got)
	}
	if original := CorrelationFromContext(context.Background()); original != (Correlation{}) {
		t.Fatalf("background context unexpectedly changed: %#v", original)
	}
}

func TestCorrelationFromNilContextIsEmpty(t *testing.T) {
	if got := CorrelationFromContext(nil); got != (Correlation{}) {
		t.Fatalf("nil context correlation = %#v", got)
	}
}
