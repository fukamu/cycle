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

func TestApplyAIActionPreservesCurrentPDCDriftAndUpdatesActionMetadata(t *testing.T) {
	current := New("cycle", "user", "goal", "version", 1, "operation", "hash", testNow)
	for _, frame := range []Frame{FramePlan, FrameDo, FrameCheck, FrameAction} {
		result, err := SaveFrame(current, frame, strings.ToUpper(string(frame)), current.FrameRevision(frame), false, testNow)
		if err != nil {
			t.Fatal(err)
		}
		current = result.Cycle
	}

	previousAIRevision := current.Revisions.Content
	current.ActionLastAIRevision = &previousAIRevision
	modified, err := SaveFrame(current, FrameAction, "手動で変更したAction", current.Revisions.Action, false, testNow.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	current = modified.Cycle
	providerTargetRevision := current.Revisions.Content

	for index, update := range []struct {
		frame   Frame
		content string
	}{
		{frame: FramePlan, content: "provider待機中のPlan"},
		{frame: FrameDo, content: "provider待機中のDo"},
		{frame: FrameCheck, content: "provider待機中のCheck"},
	} {
		result, saveErr := SaveFrame(
			current,
			update.frame,
			update.content,
			current.FrameRevision(update.frame),
			false,
			testNow.Add(time.Duration(index+2)*time.Minute),
		)
		if saveErr != nil {
			t.Fatal(saveErr)
		}
		current = result.Cycle
	}
	if current.Revisions.Content == providerTargetRevision {
		t.Fatal("test setup did not create provider-time content drift")
	}

	before := current
	location := time.FixedZone("test-offset", 9*60*60)
	appliedAt := time.Date(2026, time.August, 20, 12, 34, 56, 789, location)
	applied, err := ApplyAIAction(current, "  AI Action\r\n次の行動 \t", appliedAt)
	if err != nil {
		t.Fatal(err)
	}

	if applied.Plan != before.Plan || applied.Do != before.Do || applied.Check != before.Check {
		t.Fatalf("P/D/C drift was overwritten: before=%#v, applied=%#v", before, applied)
	}
	if applied.Action != "  AI Action\n次の行動 \t" {
		t.Fatalf("Action = %q", applied.Action)
	}
	if applied.Revisions.Content != before.Revisions.Content+1 || applied.Revisions.Action != before.Revisions.Action+1 {
		t.Fatalf("revisions = %#v, before = %#v", applied.Revisions, before.Revisions)
	}
	if applied.Revisions.Plan != before.Revisions.Plan || applied.Revisions.Do != before.Revisions.Do || applied.Revisions.Check != before.Revisions.Check {
		t.Fatalf("P/D/C revisions changed: %#v, before = %#v", applied.Revisions, before.Revisions)
	}
	if applied.ActionLastAIRevision == nil || *applied.ActionLastAIRevision != applied.Revisions.Content {
		t.Fatalf("ActionLastAIRevision = %v, content revision = %d", applied.ActionLastAIRevision, applied.Revisions.Content)
	}
	if applied.ActionModifiedAfterAI {
		t.Fatal("ActionModifiedAfterAI must be reset after AI application")
	}
	if applied.UpdatedAt != appliedAt.UTC() || applied.UpdatedAt.Location() != time.UTC {
		t.Fatalf("UpdatedAt = %v, want UTC %v", applied.UpdatedAt, appliedAt.UTC())
	}

	expected := before
	expected.Action = "  AI Action\n次の行動 \t"
	expected.Revisions.Content++
	expected.Revisions.Action++
	expected.ActionLastAIRevision = applied.ActionLastAIRevision
	expected.ActionModifiedAfterAI = false
	expected.UpdatedAt = appliedAt.UTC()
	if applied != expected {
		t.Fatalf("fields outside A and its revision metadata changed: applied=%#v, expected=%#v", applied, expected)
	}
}

func TestApplyAIActionRejectsInactiveBlankAndInvalidAction(t *testing.T) {
	active := New("cycle", "user", "goal", "version", 1, "operation", "hash", testNow)
	completed := active
	completed.Status = StatusCompleted
	canceled := active
	canceled.Status = StatusCanceled

	for _, test := range []struct {
		name    string
		current PDCACycle
		action  string
		wantErr error
	}{
		{name: "completed", current: completed, action: "Action", wantErr: ErrCycleNotActive},
		{name: "canceled", current: canceled, action: "Action", wantErr: ErrCycleNotActive},
		{name: "blank", current: active, action: " \n\t ", wantErr: ErrCycleIncomplete},
		{name: "forbidden control", current: active, action: "Action\x00", wantErr: ErrForbiddenCharacter},
		{name: "too long", current: active, action: strings.Repeat("界", MaxFrameCodePoints+1), wantErr: ErrFrameTextTooLong},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ApplyAIAction(test.current, test.action, testNow); !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
		})
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

func TestFrameTextUsesNonBMPCodePointBoundariesAndPreservesWhitespace(t *testing.T) {
	atLimit := strings.Repeat("🌱", MaxFrameCodePoints)
	if normalized, err := NormalizeAndValidateText(atLimit); err != nil || normalized != atLimit {
		t.Fatalf("200 non-BMP code points = %q, %v", normalized, err)
	}
	if normalized, err := NormalizeAndValidateText(atLimit + "🌱"); !errors.Is(err, ErrFrameTextTooLong) || normalized != "" {
		t.Fatalf("201 non-BMP code points = %q, %v", normalized, err)
	}

	current := New("cycle", "user", "goal", "version", 1, "operation", "hash", testNow)
	result, err := SaveFrame(current, FramePlan, "  P\r\nD\rA \t", 0, false, testNow.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "  P\nD\nA \t" || result.Cycle.Plan != result.Content {
		t.Fatalf("saved frame content = %q, cycle plan = %q", result.Content, result.Cycle.Plan)
	}
}

func TestUnicodeWhitespaceBlankSemanticsMatchFrontend(t *testing.T) {
	if !IsBlank("\u0085") {
		t.Fatal("U+0085 must be blank")
	}
	if IsBlank("\uFEFF") {
		t.Fatal("U+FEFF must not be blank")
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
