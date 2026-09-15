import type { Cycle } from "../../shared/api/schemas";
import { cycleCancellationReasonCopy } from "../../shared/copy/ja";

export function CycleCancellationReason({
  cycle,
}: {
  readonly cycle: Pick<Cycle, "status" | "cancellationReason">;
}) {
  if (cycle.status !== "canceled" || cycle.cancellationReason !== "replanned")
    return null;

  return (
    <p className="cycle-cancellation-reason">
      {cycleCancellationReasonCopy.replanned}
    </p>
  );
}
