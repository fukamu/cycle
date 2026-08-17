package cycle

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/domain/user"
)

var testNow = time.Date(2026, time.August, 16, 8, 0, 0, 0, time.FixedZone("JST", 9*60*60))

func TestNewInitialCreatesCycleOne(t *testing.T) {
	t.Parallel()

	got := NewInitial("cycle-1", user.ID("user-1"), testNow)
	if got.SequenceNumber != 1 || got.Status != StatusActive {
		t.Fatalf("initial cycle = %#v", got)
	}
	if got.StartedAt.Location() != time.UTC {
		t.Fatalf("StartedAt location = %v", got.StartedAt.Location())
	}
}

func TestCompleteRejectsWhitespaceOnlyFrames(t *testing.T) {
	t.Parallel()

	current := completeReadyCycle()
	current.Do = "\t \n"
	_, err := Complete(current, testNow, "cycle-2", "operation-1", current.ContentRevision, false)
	var incomplete *IncompleteError
	if !errors.As(err, &incomplete) || len(incomplete.MissingFrames) != 1 || incomplete.MissingFrames[0] != FrameDo {
		t.Fatalf("Complete() error = %#v", err)
	}
}

func TestCompleteCreatesImmutableSnapshotAndNextCycle(t *testing.T) {
	t.Parallel()

	current := completeReadyCycle()
	got, err := Complete(current, testNow, "cycle-2", "operation-1", current.ContentRevision, false)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if got.Completed.Status != StatusCompleted || got.Completed.CompletedAt == nil {
		t.Fatalf("completed = %#v", got.Completed)
	}
	if got.Next.Status != StatusActive || got.Next.SequenceNumber != current.SequenceNumber+1 {
		t.Fatalf("next = %#v", got.Next)
	}
	if !got.Next.StartedAt.Equal(*got.Completed.CompletedAt) {
		t.Fatal("completion and next start timestamps differ")
	}
	if got.Completed.ContentRevision != current.ContentRevision {
		t.Fatal("completion changed content revision")
	}
}

func TestTextCodePointLimit(t *testing.T) {
	t.Parallel()

	if _, err := NormalizeAndValidateText(strings.Repeat("改", 2000)); err != nil {
		t.Fatalf("2000 code points error = %v", err)
	}
	if _, err := NormalizeAndValidateText(strings.Repeat("改", 2001)); !errors.Is(err, ErrFrameTooLong) {
		t.Fatalf("2001 code points error = %v", err)
	}
}

func TestTextNormalizationAndForbiddenControl(t *testing.T) {
	t.Parallel()

	got, err := NormalizeAndValidateText("first\r\nsecond\rthird")
	if err != nil || got != "first\nsecond\nthird" {
		t.Fatalf("NormalizeAndValidateText() = %q, %v", got, err)
	}
	if _, err = NormalizeAndValidateText("contains\x00nul"); !errors.Is(err, ErrInvalidText) {
		t.Fatalf("NUL error = %v", err)
	}
}

func TestCompletedCycleCannotBeSavedOrCompletedAgain(t *testing.T) {
	t.Parallel()

	current := completeReadyCycle()
	result, err := Complete(current, testNow, "cycle-2", "operation-1", current.ContentRevision, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = SaveFrame(result.Completed, FramePlan, "changed", result.Completed.PlanRevision, false, testNow); !errors.Is(err, ErrCycleNotActive) {
		t.Fatalf("SaveFrame(completed) error = %v", err)
	}
	if _, err = Complete(result.Completed, testNow, "cycle-3", "operation-2", result.Completed.ContentRevision, false); !errors.Is(err, ErrCycleNotActive) {
		t.Fatalf("Complete(completed) error = %v", err)
	}
}

func TestSaveFrameUsesPerFrameRevisionAndNoOp(t *testing.T) {
	t.Parallel()

	current := NewInitial("cycle-1", user.ID("user-1"), testNow)
	first, err := SaveFrame(current, FramePlan, "plan", 0, false, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if first.Cycle.PlanRevision != 1 || first.Cycle.ContentRevision != 1 {
		t.Fatalf("revisions = %d/%d", first.Cycle.PlanRevision, first.Cycle.ContentRevision)
	}
	second, err := SaveFrame(first.Cycle, FrameDo, "did", 0, false, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if second.Cycle.PlanRevision != 1 || second.Cycle.DoRevision != 1 || second.Cycle.ContentRevision != 2 {
		t.Fatalf("revisions = %#v", second.Cycle)
	}
	noOp, err := SaveFrame(second.Cycle, FrameDo, "did", 1, false, testNow)
	if err != nil || !noOp.NoOp || noOp.Cycle.ContentRevision != 2 {
		t.Fatalf("no-op = %#v, %v", noOp, err)
	}
	if _, err = SaveFrame(second.Cycle, FramePlan, "stale", 0, false, testNow); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale error = %v", err)
	}
}

func TestActionSaveRejectedWhileAIRunning(t *testing.T) {
	t.Parallel()

	current := NewInitial("cycle-1", user.ID("user-1"), testNow)
	if _, err := SaveFrame(current, FrameAction, "action", 0, true, testNow); !errors.Is(err, ErrAIOperationRunning) {
		t.Fatalf("SaveFrame() error = %v", err)
	}
	if _, err := SaveFrame(current, FramePlan, "plan", 0, true, testNow); err != nil {
		t.Fatalf("P save during AI error = %v", err)
	}
}

func TestApplyAIActionUpdatesOnlyAction(t *testing.T) {
	t.Parallel()

	current := completeReadyCycle()
	current.ContentRevision = 5
	got, err := ApplyAIAction(current, "1. 明日試す", 4, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if got.Cycle.Plan != current.Plan || got.Cycle.Do != current.Do || got.Cycle.Check != current.Check {
		t.Fatal("AI changed P/D/C")
	}
	if got.Cycle.Action != "1. 明日試す" || got.Cycle.ActionRevision != current.ActionRevision+1 || got.Cycle.ContentRevision != 6 {
		t.Fatalf("AI result cycle = %#v", got.Cycle)
	}
	if !got.ContextChanged || got.Cycle.ActionUserModifiedAfterAI || got.Cycle.ActionLastAIAppliedContentRevision == nil || *got.Cycle.ActionLastAIAppliedContentRevision != 6 {
		t.Fatalf("AI metadata = %#v", got)
	}
}

func TestUserActionSaveAfterAIMarksModification(t *testing.T) {
	t.Parallel()

	current := completeReadyCycle()
	applied, err := ApplyAIAction(current, "AI action", current.ContentRevision, testNow)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := SaveFrame(applied.Cycle, FrameAction, "my action", applied.Cycle.ActionRevision, false, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.Cycle.ActionUserModifiedAfterAI {
		t.Fatal("user modification flag is false")
	}
}

func completeReadyCycle() PDCACycle {
	current := NewInitial("cycle-1", user.ID("user-1"), testNow)
	current.Plan = "plan"
	current.Do = "do"
	current.Check = "check"
	current.Action = "action"
	return current
}
