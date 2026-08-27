import type { Frame } from "../../../shared/api/schemas";
import type { AutoSaveState } from "../../../shared/autosave/autoSaveCoordinator";
import { hasNonWhitespace } from "../../../shared/text/semantics";

export type FrameValues = Readonly<Record<Frame, string>>;
export type ActionAIStateKind = "idle" | "generating" | "refining";

export type CycleEligibility = {
  readonly canGenerateAction: boolean;
  readonly canRefineAction: boolean;
  readonly canCompleteCycle: boolean;
  readonly canTerminateActiveGoal: boolean;
};

export function getCycleEligibility(
  values: FrameValues,
  saveState: AutoSaveState,
  aiState: ActionAIStateKind,
): CycleEligibility {
  const commandsAreIdle = saveState.kind === "saved" && aiState === "idle";
  const planDoCheckAreReady = [values.plan, values.do, values.check].every(
    hasNonWhitespace,
  );
  const everyFrameIsReady =
    planDoCheckAreReady && hasNonWhitespace(values.action);

  return {
    canGenerateAction: commandsAreIdle && planDoCheckAreReady,
    canRefineAction: commandsAreIdle && everyFrameIsReady,
    canCompleteCycle: commandsAreIdle && everyFrameIsReady,
    canTerminateActiveGoal: commandsAreIdle,
  };
}
