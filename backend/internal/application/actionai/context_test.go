package actionai

import (
	"strings"
	"testing"
	"unicode/utf8"

	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

type runeTokenCounter struct{}

func (runeTokenCounter) Count(value string) (int, error) {
	return utf8.RuneCountInString(value), nil
}

func (runeTokenCounter) Truncate(value string, limit int, marker string) (string, error) {
	if utf8.RuneCountInString(value) <= limit {
		return value, nil
	}
	markerLength := utf8.RuneCountInString(marker)
	if markerLength > limit {
		return "", nil
	}
	return string([]rune(value)[:limit-markerLength]) + marker, nil
}

func TestContextBuilderAddsNewestWholePastCyclesWithinBudget(t *testing.T) {
	snapshot := contextSnapshot()
	fullBuilder := NewContextBuilder(runeTokenCounter{}, 10_000)
	full, err := fullBuilder.BuildGenerate(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.ContextCycleIDs) != 2 || full.ContextCycleIDs[0] != "past-2" || full.ContextCycleIDs[1] != "past-1" {
		t.Fatalf("context ids = %v", full.ContextCycleIDs)
	}
	firstPastEnd := strings.Index(full.Input, "[Past Completed Cycle 1]")
	if firstPastEnd < 0 {
		t.Fatal("expected both past cycle blocks")
	}

	onePastBudget := utf8.RuneCountInString(full.Instructions + "\n" + full.Input[:firstPastEnd])
	limited, err := NewContextBuilder(runeTokenCounter{}, onePastBudget).BuildGenerate(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited.ContextCycleIDs) != 1 || limited.ContextCycleIDs[0] != "past-2" || strings.Contains(limited.Input, "Past Completed Cycle 1") {
		t.Fatalf("limited context = %#v", limited)
	}
}

func TestContextBuilderTruncatesOnlyProviderCopyOfCurrent(t *testing.T) {
	snapshot := contextSnapshot()
	snapshot.Current.Plan = strings.Repeat("計画", 100)
	original := snapshot.Current.Plan
	result, err := NewContextBuilder(runeTokenCounter{}, 350).BuildGenerate(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !result.CurrentTruncated || !strings.Contains(result.Input, omissionMarker) {
		t.Fatalf("expected truncated provider input: %#v", result)
	}
	if snapshot.Current.Plan != original || len(result.ContextCycleIDs) != 0 {
		t.Fatal("builder modified source or included past context")
	}
	count, _ := runeTokenCounter{}.Count(result.Instructions + "\n" + result.Input)
	if count > 350 {
		t.Fatalf("token count = %d", count)
	}
}

func TestRefineContextKeepsCurrentAction(t *testing.T) {
	result, err := NewContextBuilder(runeTokenCounter{}, 10_000).BuildRefine(contextSnapshot())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Input, "A: current action") || !strings.Contains(result.Instructions, "元の意図") {
		t.Fatalf("refine context = %s / %s", result.Instructions, result.Input)
	}
}

func contextSnapshot() Snapshot {
	return Snapshot{
		Current: domaincycle.PDCACycle{ID: "current", Plan: "plan", Do: "do", Check: "check", Action: "current action"},
		Past: []domaincycle.PDCACycle{
			{ID: "past-2", SequenceNumber: 2, Plan: "p2", Do: "d2", Check: "c2", Action: "a2"},
			{ID: "past-1", SequenceNumber: 1, Plan: "p1", Do: "d1", Check: "c1", Action: "a1"},
		},
	}
}
