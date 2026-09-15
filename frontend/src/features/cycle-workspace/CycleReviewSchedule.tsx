import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type { Cycle, ReviewSchedule } from "../../shared/api/schemas";
import type { ReviewScheduleChange } from "../../shared/api/workspace";
import {
  classifyReviewDate,
  isValidLocalDate,
} from "../../shared/date/localDate";
import { reviewScheduleCopy } from "../../shared/copy/ja";

export type ReviewScheduleMutationOutcome =
  | { readonly kind: "saved"; readonly schedule: ReviewSchedule }
  | { readonly kind: "conflict" | "error"; readonly message: string }
  | { readonly kind: "abandoned" };

type Feedback = Readonly<{
  kind: "success" | "error";
  message: string;
}>;

export function CycleReviewSchedule({
  cycle,
  today,
  disabled = false,
  terminalCommandGuidanceId,
  onSubmit,
  onPendingChange,
}: {
  readonly cycle: Pick<
    Cycle,
    "status" | "reviewDate" | "reviewScheduleRevision"
  >;
  readonly today: string;
  readonly disabled?: boolean;
  readonly terminalCommandGuidanceId: string;
  readonly onSubmit: (
    change: ReviewScheduleChange,
  ) => Promise<ReviewScheduleMutationOutcome>;
  readonly onPendingChange: (pending: boolean) => void;
}) {
  const inputId = useId();
  const guideId = useId();
  const canonicalDate = cycle.reviewDate ?? "";
  const previousCanonicalRef = useRef(canonicalDate);
  const [draft, setDraft] = useState(canonicalDate);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const editable = cycle.status === "active";
  const validDraft = isValidLocalDate(draft);

  useEffect(() => {
    if (previousCanonicalRef.current === canonicalDate) return;
    previousCanonicalRef.current = canonicalDate;
    if (!dirty) setDraft(canonicalDate);
  }, [canonicalDate, dirty]);

  const finish = (outcome: ReviewScheduleMutationOutcome) => {
    if (outcome.kind === "saved") {
      const savedDate = outcome.schedule.reviewDate ?? "";
      previousCanonicalRef.current = savedDate;
      setDraft(savedDate);
      setDirty(false);
      setFeedback({ kind: "success", message: reviewScheduleCopy.saved });
    } else if (outcome.kind !== "abandoned") {
      setFeedback({ kind: "error", message: outcome.message });
    }
  };

  const submitSet = async (event: FormEvent) => {
    event.preventDefault();
    if (!validDraft || !dirty || pending || disabled) {
      if (!validDraft)
        setFeedback({ kind: "error", message: reviewScheduleCopy.invalid });
      return;
    }
    onPendingChange(true);
    setPending(true);
    setFeedback(undefined);
    try {
      finish(
        await onSubmit({
          action: "set",
          reviewDate: draft,
          expectedReviewScheduleRevision: cycle.reviewScheduleRevision,
        }),
      );
    } finally {
      onPendingChange(false);
      setPending(false);
    }
  };

  const submitClear = async () => {
    if (cycle.reviewDate === null || pending || disabled) return;
    onPendingChange(true);
    setPending(true);
    setFeedback(undefined);
    try {
      finish(
        await onSubmit({
          action: "clear",
          expectedReviewScheduleRevision: cycle.reviewScheduleRevision,
        }),
      );
    } finally {
      onPendingChange(false);
      setPending(false);
    }
  };

  const currentState = cycle.reviewDate
    ? classifyReviewDate(cycle.reviewDate, today)
    : undefined;

  return (
    <section
      className="cycle-review-schedule"
      aria-labelledby={`${inputId}-heading`}
    >
      <div className="cycle-review-schedule__summary">
        <h2 id={`${inputId}-heading`}>{reviewScheduleCopy.heading}</h2>
        {cycle.reviewDate && currentState ? (
          <p>
            見直す日：
            <time dateTime={cycle.reviewDate}>{cycle.reviewDate}</time>
            <span>（{reviewScheduleCopy.state[currentState]}）</span>
          </p>
        ) : (
          <p>{reviewScheduleCopy.unset}</p>
        )}
        {!editable && <p>{reviewScheduleCopy.terminal}</p>}
      </div>
      {editable && (
        <form onSubmit={(event) => void submitSet(event)}>
          <label htmlFor={inputId}>{reviewScheduleCopy.inputLabel}</label>
          <input
            id={inputId}
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={draft}
            aria-describedby={guideId}
            disabled={pending || disabled}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setDraft(next);
              setDirty(next !== canonicalDate);
              setFeedback(undefined);
            }}
          />
          <p id={guideId} className="cycle-review-schedule__guide">
            {disabled
              ? reviewScheduleCopy.commandPending
              : reviewScheduleCopy.inputGuide}
          </p>
          {pending && (
            <p
              id={terminalCommandGuidanceId}
              className="cycle-review-schedule__terminal-guidance"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {reviewScheduleCopy.terminalCommandsPending}
            </p>
          )}
          <div className="button-row cycle-review-schedule__actions">
            <button
              className="button button--primary"
              type="submit"
              disabled={pending || disabled || !dirty || !validDraft}
            >
              {pending
                ? reviewScheduleCopy.saving
                : cycle.reviewDate
                  ? reviewScheduleCopy.change
                  : reviewScheduleCopy.set}
            </button>
            {cycle.reviewDate !== null && (
              <button
                className="button button--secondary"
                type="button"
                disabled={pending || disabled}
                onClick={() => void submitClear()}
              >
                {reviewScheduleCopy.clear}
              </button>
            )}
          </div>
          {feedback && (
            <p
              className={
                feedback.kind === "error" ? "inline-error" : "inline-success"
              }
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.message}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
