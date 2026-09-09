import type { Frame } from "../../../shared/api/schemas";
import type { AutoSaveState } from "../../../shared/autosave/autoSaveCoordinator";
import { hasNonWhitespace } from "../../../shared/text/semantics";

export type FrameValues = Readonly<Record<Frame, string>>;
export type ActionAIStateKind = "idle" | "generating" | "refining";

export type CycleActionCommand = "generate" | "refine" | "complete";

export type CycleGoalActionCommand = "achieve" | "end" | "delete";

export type CycleGoalActionDisabledReason =
  | { readonly kind: "command-pending" }
  | { readonly kind: "recovery-pending" }
  | { readonly kind: "save-dirty" }
  | { readonly kind: "save-saving" }
  | { readonly kind: "save-failed" }
  | { readonly kind: "ai-generating" }
  | { readonly kind: "ai-refining" };

export type CycleGoalActionGuidance = {
  readonly reason: CycleGoalActionDisabledReason;
  readonly commands: readonly CycleGoalActionCommand[];
};

export type CycleActionDisabledReason =
  | { readonly kind: "command-pending" }
  | { readonly kind: "recovery-pending" }
  | { readonly kind: "save-dirty" }
  | { readonly kind: "save-saving" }
  | { readonly kind: "save-failed" }
  | { readonly kind: "ai-generating" }
  | { readonly kind: "ai-refining" }
  | {
      readonly kind: "missing-frames";
      readonly frames: readonly Frame[];
    };

export type CycleActionControl = {
  readonly enabled: boolean;
};

export type CycleActionGuidance = {
  readonly reason: CycleActionDisabledReason;
  readonly commands: readonly CycleActionCommand[];
};

export type CycleActionControls = Readonly<
  Record<CycleActionCommand, CycleActionControl>
> & {
  readonly guidance: CycleActionGuidance | null;
};

export type CycleActionContext = {
  readonly pendingAction: boolean;
  readonly recoveryPending: boolean;
};

export type CycleEligibility = {
  readonly canGenerateAction: boolean;
  readonly canRefineAction: boolean;
  readonly canCompleteCycle: boolean;
  readonly canTerminateActiveGoal: boolean;
};

const allActionCommands = ["generate", "refine", "complete"] as const;
const actionRequiredCommands = ["refine", "complete"] as const;
const allGoalActionCommands = ["achieve", "end", "delete"] as const;
const terminalGoalActionCommands = ["achieve", "end"] as const;
const planDoCheckFrames = ["plan", "do", "check"] as const;

function blockedControls(
  reason: CycleActionDisabledReason,
): CycleActionControls {
  return {
    generate: { enabled: false },
    refine: { enabled: false },
    complete: { enabled: false },
    guidance: { reason, commands: allActionCommands },
  };
}

export function getCycleActionControls(
  values: FrameValues,
  saveState: AutoSaveState,
  aiState: ActionAIStateKind,
  context: CycleActionContext,
): CycleActionControls {
  if (context.pendingAction)
    return blockedControls({ kind: "command-pending" });
  if (context.recoveryPending)
    return blockedControls({ kind: "recovery-pending" });
  if (saveState.kind === "dirty")
    return blockedControls({ kind: "save-dirty" });
  if (saveState.kind === "saving")
    return blockedControls({ kind: "save-saving" });
  if (saveState.kind === "failed")
    return blockedControls({ kind: "save-failed" });
  if (aiState === "generating")
    return blockedControls({ kind: "ai-generating" });
  if (aiState === "refining") return blockedControls({ kind: "ai-refining" });

  const missingPlanDoCheck = planDoCheckFrames.filter(
    (frame) => !hasNonWhitespace(values[frame]),
  );
  if (missingPlanDoCheck.length > 0)
    return {
      generate: { enabled: false },
      refine: { enabled: false },
      complete: { enabled: false },
      guidance: {
        reason: { kind: "missing-frames", frames: missingPlanDoCheck },
        commands: allActionCommands,
      },
    };

  const actionIsMissing = !hasNonWhitespace(values.action);
  return {
    generate: { enabled: true },
    refine: { enabled: !actionIsMissing },
    complete: { enabled: !actionIsMissing },
    guidance: actionIsMissing
      ? {
          reason: { kind: "missing-frames", frames: ["action"] },
          commands: actionRequiredCommands,
        }
      : null,
  };
}

export function getCycleGoalActionGuidance(
  saveState: AutoSaveState,
  aiState: ActionAIStateKind,
  context: CycleActionContext,
): CycleGoalActionGuidance | null {
  if (context.pendingAction)
    return {
      reason: { kind: "command-pending" },
      commands: allGoalActionCommands,
    };

  const reason: CycleGoalActionDisabledReason | null =
    saveState.kind === "dirty"
      ? { kind: "save-dirty" }
      : saveState.kind === "saving"
        ? { kind: "save-saving" }
        : saveState.kind === "failed"
          ? context.recoveryPending
            ? { kind: "recovery-pending" }
            : { kind: "save-failed" }
          : aiState === "generating"
            ? { kind: "ai-generating" }
            : aiState === "refining"
              ? { kind: "ai-refining" }
              : null;

  return reason ? { reason, commands: terminalGoalActionCommands } : null;
}

export function getCycleEligibility(
  values: FrameValues,
  saveState: AutoSaveState,
  aiState: ActionAIStateKind,
): CycleEligibility {
  const actionControls = getCycleActionControls(values, saveState, aiState, {
    pendingAction: false,
    recoveryPending: false,
  });
  const commandsAreIdle = saveState.kind === "saved" && aiState === "idle";

  return {
    canGenerateAction: actionControls.generate.enabled,
    canRefineAction: actionControls.refine.enabled,
    canCompleteCycle: actionControls.complete.enabled,
    canTerminateActiveGoal: commandsAreIdle,
  };
}
