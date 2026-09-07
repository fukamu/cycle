import { useId } from "react";

import { cycleCheckComparisonCopy, frameCopy } from "../../shared/copy/ja";

type ComparisonFrame = "plan" | "do";

const comparisonFrames: readonly ComparisonFrame[] = ["plan", "do"];
const comparisonFrameLabels: Readonly<Record<ComparisonFrame, "P" | "D">> = {
  plan: "P",
  do: "D",
};

export function CycleCheckComparison({
  values,
  recoveryPending,
  onReviewRecovery,
}: {
  readonly values: Readonly<Record<ComparisonFrame, string>>;
  readonly recoveryPending: ReadonlySet<ComparisonFrame>;
  readonly onReviewRecovery: (frame: ComparisonFrame) => void;
}) {
  const headingId = useId();

  return (
    <section className="cycle-check-comparison" aria-labelledby={headingId}>
      <div className="cycle-check-comparison__intro">
        <h3 id={headingId}>{cycleCheckComparisonCopy.heading}</h3>
        <p>{cycleCheckComparisonCopy.guide}</p>
      </div>
      <div className="cycle-check-comparison__grid">
        {comparisonFrames.map((frame) => {
          const copy = frameCopy[frame];
          const needsReview = recoveryPending.has(frame);
          const hasContent = values[frame].trim().length > 0;

          return (
            <article className="cycle-check-comparison__item" key={frame}>
              <div className="cycle-check-comparison__item-heading">
                <h4 aria-label={`${copy.label} — ${copy.name}`}>
                  <span aria-hidden="true">{copy.label}</span>
                  {copy.name}
                </h4>
                {needsReview && (
                  <span className="cycle-check-comparison__status">
                    {cycleCheckComparisonCopy.recoveryPending}
                  </span>
                )}
              </div>
              {needsReview && (
                <div className="cycle-check-comparison__recovery">
                  <p>{cycleCheckComparisonCopy.recoveryGuide}</p>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => onReviewRecovery(frame)}
                  >
                    {cycleCheckComparisonCopy.reviewRecovery(
                      comparisonFrameLabels[frame],
                    )}
                  </button>
                </div>
              )}
              <p
                className={
                  hasContent
                    ? "cycle-check-comparison__content"
                    : "cycle-check-comparison__content cycle-check-comparison__content--empty"
                }
              >
                {hasContent ? values[frame] : cycleCheckComparisonCopy.empty}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
