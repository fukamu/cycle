package goal

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
)

var now = time.Date(2026, time.August, 19, 1, 0, 0, 0, time.UTC)

func TestInitialStartCreatesGoalVersionAndCycleAtomically(t *testing.T) {
	draft, err := NewDraft("draft", "user", " 目標 ", now)
	if err != nil {
		t.Fatal(err)
	}
	aggregate, err := StartInitial(draft, "goal", "version", "cycle", "operation", "hash", now)
	if err != nil {
		t.Fatal(err)
	}
	if aggregate.Goal.Status != StatusActiveCycle || aggregate.Version.VersionNumber != 1 || aggregate.Cycle.SequenceNumber != 1 || aggregate.Cycle.GoalVersionID != aggregate.Version.ID {
		t.Fatalf("unexpected initial aggregate: %#v", aggregate)
	}
}

func TestGoalTextLimitUsesCodePoints(t *testing.T) {
	if _, err := NormalizeText(strings.Repeat("界", 80), false); err != nil {
		t.Fatal(err)
	}
	if _, err := NormalizeText(strings.Repeat("界", 81), false); !errors.Is(err, ErrTextTooLong) {
		t.Fatalf("expected oversize error, got %v", err)
	}
}

func TestReviewSameBodyKeepsVersionAndCreatesNextCycle(t *testing.T) {
	current, version, draft := reviewFixture(t, "目標\r\n本文")
	draft.Body = "目標\n本文"
	result, err := ContinueReview(current, version, draft, "unused", "cycle-2", "continue", "hash", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if result.VersionCreated || result.Version.VersionNumber != 1 || result.Cycle.SequenceNumber != 2 || result.Cycle.GoalVersionID != version.ID {
		t.Fatalf("unexpected continue: %#v", result)
	}
}

func TestReviewChangedBodyCreatesImmutableNextVersion(t *testing.T) {
	current, version, draft := reviewFixture(t, "元の目標")
	draft.Body = "変更した目標"
	result, err := ContinueReview(current, version, draft, "version-2", "cycle-2", "continue", "hash", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !result.VersionCreated || result.Version.VersionNumber != 2 || result.Version.Body != draft.Body || result.Cycle.GoalVersionID != "version-2" {
		t.Fatalf("unexpected version transition: %#v", result)
	}
	if version.Body != "元の目標" {
		t.Fatal("past version was mutated")
	}
}

func TestTerminalGoalCannotReopen(t *testing.T) {
	current, _, _ := reviewFixture(t, "目標")
	terminal, err := Terminate(current, StatusAchieved, "terminal", "hash", now)
	if err != nil || terminal.CurrentVersionNumber != 1 {
		t.Fatalf("terminate: %#v, %v", terminal, err)
	}
	if _, err := EnterReview(terminal, now); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("terminal goal reopened: %v", err)
	}
}

func reviewFixture(t *testing.T, body string) (Goal, Version, Draft) {
	t.Helper()
	draft, _ := NewDraft("draft", "user", body, now)
	aggregate, err := StartInitial(draft, "goal", "version-1", "cycle-1", "start", "hash", now)
	if err != nil {
		t.Fatal(err)
	}
	completed := aggregate.Cycle
	for _, frame := range []cycle.Frame{cycle.FramePlan, cycle.FrameDo, cycle.FrameCheck, cycle.FrameAction} {
		saved, saveErr := cycle.SaveFrame(completed, frame, "value", completed.FrameRevision(frame), false, now)
		if saveErr != nil {
			t.Fatal(saveErr)
		}
		completed = saved.Cycle
	}
	completed, err = cycle.Complete(completed, "complete", "hash", completed.Revisions.Content, false, now)
	if err != nil {
		t.Fatal(err)
	}
	current, err := EnterReview(aggregate.Goal, now)
	if err != nil {
		t.Fatal(err)
	}
	review, err := NewReviewDraft("review", current, aggregate.Version, completed, now)
	if err != nil {
		t.Fatal(err)
	}
	return current, aggregate.Version, review
}
