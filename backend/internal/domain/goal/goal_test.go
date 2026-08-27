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

func TestGoalTextUsesNonBMPCodePointBoundariesAndPreservesWhitespace(t *testing.T) {
	atLimit := strings.Repeat("🌱", MaxGoalCodePoints)
	if normalized, err := NormalizeText(atLimit, false); err != nil || normalized != atLimit {
		t.Fatalf("80 non-BMP code points = %q, %v", normalized, err)
	}
	if _, err := NormalizeText(atLimit+"🌱", false); !errors.Is(err, ErrTextTooLong) {
		t.Fatalf("81 non-BMP code points error = %v, want %v", err, ErrTextTooLong)
	}

	const input = "  目標\r\n本文\r末尾 \t"
	const want = "  目標\n本文\n末尾 \t"
	if normalized, err := NormalizeText(input, false); err != nil || normalized != want {
		t.Fatalf("normalized goal text = %q, %v, want %q", normalized, err, want)
	}
}

func TestUnicodeWhitespaceBlankSemanticsMatchFrontend(t *testing.T) {
	if _, err := NormalizeText("\u0085", false); !errors.Is(err, ErrTextRequired) {
		t.Fatalf("U+0085 Goal error = %v, want %v", err, ErrTextRequired)
	}
	if normalized, err := NormalizeText("\uFEFF", false); err != nil || normalized != "\uFEFF" {
		t.Fatalf("U+FEFF Goal = %q, %v", normalized, err)
	}
}

func TestSaveDraftTreatsSameBodyWithStaleRevisionAsNoOp(t *testing.T) {
	draft, err := NewDraft("draft", "user", "保存済み目標", now)
	if err != nil {
		t.Fatal(err)
	}
	draft.Revision = 2
	draft.UpdatedAt = now.Add(time.Minute)

	saved, noOp, err := SaveDraft(draft, draft.Body, 1, now.Add(2*time.Minute))
	if err != nil || !noOp || saved != draft {
		t.Fatalf("stale same-body save = %#v, noOp = %t, error = %v", saved, noOp, err)
	}
	if _, _, err = SaveDraft(draft, "異なる目標", 1, now.Add(2*time.Minute)); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("stale different-body save error = %v, want %v", err, ErrStateConflict)
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

func TestReviewComparisonNormalizesAllLineEndingsWithoutTrimming(t *testing.T) {
	t.Run("CRLF and lone CR are equivalent to LF", func(t *testing.T) {
		current, version, draft := reviewFixture(t, "目標\r\n本文\r末尾")
		draft.Body = "目標\n本文\n末尾"
		result, err := ContinueReview(current, version, draft, "unused", "cycle-2", "continue", "hash", now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if result.VersionCreated || result.Version.ID != version.ID || result.Cycle.GoalVersionID != version.ID {
			t.Fatalf("newline-only review change created a version: %#v", result)
		}
	})

	t.Run("trailing whitespace is an exact content change", func(t *testing.T) {
		current, version, draft := reviewFixture(t, "目標\n本文")
		draft.Body = "目標\n本文 \t"
		result, err := ContinueReview(current, version, draft, "version-2", "cycle-2", "continue", "hash", now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if !result.VersionCreated || result.Version.Body != draft.Body || result.Cycle.GoalVersionID != result.Version.ID {
			t.Fatalf("trailing-whitespace review change = %#v", result)
		}
	})
}

func TestReviewComparisonRequiresReviewCycleReference(t *testing.T) {
	current, version, draft := reviewFixture(t, "目標")
	draft.ReviewCycleID = nil
	if _, _, err := ReviewBodyChanged(current, version, draft); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("Continue comparison error = %v, want %v", err, ErrStateConflict)
	}
	if _, err := ReviewDraftDiffersFromVersion(current, version, draft); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("discard comparison error = %v, want %v", err, ErrStateConflict)
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
