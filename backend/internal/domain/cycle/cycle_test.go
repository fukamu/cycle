package cycle

import (
	"errors"
	"strings"
	"testing"
	"time"
)

var testNow = time.Date(2026, time.August, 19, 0, 0, 0, 0, time.UTC)

func TestCycleRequiresGoalAndNumbersWithinGoal(t *testing.T) {
	cycle := New("cycle", "user", "goal-a", "version-a", 1, "operation", "hash", testNow)
	if cycle.GoalID != "goal-a" || cycle.GoalVersionID != "version-a" || cycle.SequenceNumber != 1 {
		t.Fatalf("unexpected cycle: %#v", cycle)
	}
	other := New("cycle-2", "user", "goal-b", "version-b", 1, "operation-2", "hash-2", testNow)
	if other.SequenceNumber != 1 {
		t.Fatal("cycle numbering must restart for another goal")
	}
}

func TestSaveFrameUsesPerFrameCASAndPreservesOtherFrame(t *testing.T) {
	current := New("cycle", "user", "goal", "version", 1, "operation", "hash", testNow)
	plan, err := SaveFrame(current, FramePlan, "P", 0, false, testNow.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	do, err := SaveFrame(plan.Cycle, FrameDo, "D", 0, false, testNow.Add(2*time.Minute))
	if err != nil || do.Cycle.Plan != "P" || do.Cycle.Do != "D" || do.Cycle.Revisions.Content != 2 {
		t.Fatalf("save result: %#v, %v", do, err)
	}
	if _, err := SaveFrame(do.Cycle, FramePlan, "old", 0, false, testNow); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
}

func TestCompleteDoesNotCreateNextCycleAndCompletedIsImmutable(t *testing.T) {
	current := readyCycle(t)
	completed, err := Complete(current, "complete-op", "hash", current.Revisions.Content, false, testNow.Add(time.Hour))
	if err != nil || completed.Status != StatusCompleted || completed.CompletedAt == nil {
		t.Fatalf("complete: %#v, %v", completed, err)
	}
	if _, err := SaveFrame(completed, FramePlan, "changed", completed.Revisions.Plan, false, testNow); !errors.Is(err, ErrCycleNotActive) {
		t.Fatalf("completed cycle changed: %v", err)
	}
}

func TestCancelAllowsIncompleteContentAndIsImmutable(t *testing.T) {
	current := New("cycle", "user", "goal", "version", 2, "operation", "hash", testNow)
	canceled, err := Cancel(current, CancellationGoalEnded, testNow.Add(time.Minute))
	if err != nil || canceled.Status != StatusCanceled || canceled.CanceledAt == nil {
		t.Fatalf("cancel: %#v, %v", canceled, err)
	}
	if _, err := Complete(canceled, "complete", "hash", 0, false, testNow); !errors.Is(err, ErrCycleNotActive) {
		t.Fatalf("canceled cycle completed: %v", err)
	}
}

func TestTextLimitsUseCodePointsAndNeverTruncate(t *testing.T) {
	if _, err := NormalizeAndValidateText(strings.Repeat("界", 200)); err != nil {
		t.Fatal(err)
	}
	value := strings.Repeat("界", 201)
	if normalized, err := NormalizeAndValidateText(value); !errors.Is(err, ErrFrameTextTooLong) || normalized != "" {
		t.Fatalf("oversize output was not rejected: %d, %v", len(normalized), err)
	}
}

func readyCycle(t *testing.T) PDCACycle {
	t.Helper()
	current := New("cycle", "user", "goal", "version", 1, "operation", "hash", testNow)
	for _, frame := range allFrames {
		result, err := SaveFrame(current, frame, strings.ToUpper(string(frame)), current.FrameRevision(frame), false, testNow)
		if err != nil {
			t.Fatal(err)
		}
		current = result.Cycle
	}
	return current
}
