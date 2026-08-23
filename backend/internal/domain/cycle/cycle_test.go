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

func TestSaveFrameTreatsSameContentWithStaleRevisionAsNoOp(t *testing.T) {
	current := New("cycle", "user", "goal", "version", 1, "operation", "hash", testNow)
	saved, err := SaveFrame(current, FramePlan, "保存済みPlan", 0, false, testNow.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}

	replayed, err := SaveFrame(saved.Cycle, FramePlan, saved.Content, 0, false, testNow.Add(2*time.Minute))
	if err != nil || !replayed.NoOp || replayed.Cycle != saved.Cycle || replayed.SavedAt != saved.SavedAt {
		t.Fatalf("stale same-content save = %#v, error = %v", replayed, err)
	}
	if _, err = SaveFrame(saved.Cycle, FramePlan, "異なるPlan", 0, false, testNow.Add(2*time.Minute)); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale different-content save error = %v, want %v", err, ErrRevisionConflict)
	}
}

func TestSaveFrameNoOpPreservesStateAndAIGuards(t *testing.T) {
	current := New("cycle", "user", "goal", "version", 1, "operation", "hash", testNow)
	if _, err := SaveFrame(current, Frame("invalid"), "", 0, false, testNow); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("invalid same-content frame error = %v, want %v", err, ErrInvalidFrame)
	}
	if _, err := SaveFrame(current, FrameAction, "", 0, true, testNow); !errors.Is(err, ErrAIOperationRunning) {
		t.Fatalf("AI-running same-content Action error = %v, want %v", err, ErrAIOperationRunning)
	}

	plan, err := SaveFrame(current, FramePlan, "P", 0, true, testNow.Add(time.Minute))
	if err != nil {
		t.Fatalf("AI-running Plan save error = %v", err)
	}
	replayed, err := SaveFrame(plan.Cycle, FramePlan, "P", 0, true, testNow.Add(2*time.Minute))
	if err != nil || !replayed.NoOp {
		t.Fatalf("AI-running stale same-content Plan = %#v, error = %v", replayed, err)
	}

	completedInput := readyCycle(t)
	completed, err := Complete(
		completedInput,
		"complete-operation",
		"complete-hash",
		completedInput.Revisions.Content,
		false,
		testNow.Add(3*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = SaveFrame(completed, FramePlan, completed.Plan, completed.Revisions.Plan, false, testNow.Add(4*time.Minute)); !errors.Is(err, ErrCycleNotActive) {
		t.Fatalf("completed same-content frame error = %v, want %v", err, ErrCycleNotActive)
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
