import { useId } from "react";

import type { Cycle } from "../../shared/api/schemas";
import { cyclePreviousActionReferenceCopy } from "../../shared/copy/ja";

type PreviousCompletedCycleAction = NonNullable<
  Cycle["previousCompletedCycleAction"]
>;

export function CyclePreviousActionReference({
  previousAction,
  currentGoalVersionNumber,
}: {
  readonly previousAction: PreviousCompletedCycleAction;
  readonly currentGoalVersionNumber: number;
}) {
  const headingId = useId();
  const goalVersionChanged =
    previousAction.goalVersionNumber !== currentGoalVersionNumber;

  return (
    <section
      className="cycle-previous-action-reference"
      aria-labelledby={headingId}
    >
      <div className="cycle-previous-action-reference__heading">
        <h3 id={headingId}>{cyclePreviousActionReferenceCopy.heading}</h3>
        <span>{cyclePreviousActionReferenceCopy.referenceOnly}</span>
      </div>
      <p className="cycle-previous-action-reference__metadata">
        {cyclePreviousActionReferenceCopy.metadata(
          previousAction.cycleSequenceNumber,
          previousAction.goalVersionNumber,
        )}
      </p>
      <p className="cycle-previous-action-reference__guide">
        {cyclePreviousActionReferenceCopy.guide}
      </p>
      {goalVersionChanged && (
        <p className="cycle-previous-action-reference__version-warning">
          {cyclePreviousActionReferenceCopy.goalVersionChanged}
        </p>
      )}
      <p className="cycle-previous-action-reference__content">
        {previousAction.action}
      </p>
    </section>
  );
}
