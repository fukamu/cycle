import type { AutoSaveState } from "../../shared/autosave/autoSaveCoordinator";

export type GoalReviewAction = "refine" | "continue" | "terminal";

export type GoalReviewActionDisabledReason =
  | "command-pending"
  | "hydrating"
  | "workspace-moved"
  | "recovery-resolving"
  | "recovery-choice"
  | "save-dirty"
  | "save-saving"
  | "save-failed"
  | "ai-running"
  | "invalid-goal";

export type GoalReviewActionControl = {
  readonly enabled: boolean;
  readonly reason?: GoalReviewActionDisabledReason;
};

export type GoalReviewActionControls = Readonly<
  Record<GoalReviewAction, GoalReviewActionControl>
>;

function control(
  reason?: GoalReviewActionDisabledReason,
): GoalReviewActionControl {
  return reason ? { enabled: false, reason } : { enabled: true };
}

function savedDraftActionReason({
  valid,
  saveState,
  aiRunning,
  pending,
  workspaceMoved,
  hydrating,
  recovery,
}: {
  readonly valid: boolean;
  readonly saveState: AutoSaveState;
  readonly aiRunning: boolean;
  readonly pending: boolean;
  readonly workspaceMoved: boolean;
  readonly hydrating: boolean;
  readonly recovery: "resolving" | "choice" | null;
}): GoalReviewActionDisabledReason | undefined {
  const disabled =
    !valid ||
    saveState.kind !== "saved" ||
    aiRunning ||
    workspaceMoved ||
    pending ||
    hydrating ||
    recovery !== null;
  if (!disabled) return undefined;
  if (workspaceMoved) return "workspace-moved";
  if (recovery === "resolving") return "recovery-resolving";
  if (recovery === "choice") return "recovery-choice";
  if (hydrating) return "hydrating";
  if (pending) return "command-pending";
  if (saveState.kind === "dirty") return "save-dirty";
  if (saveState.kind === "saving") return "save-saving";
  if (saveState.kind === "failed") return "save-failed";
  if (aiRunning) return "ai-running";
  if (!valid) return "invalid-goal";
  return undefined;
}

export function getGoalReviewActionControls({
  valid,
  saveState,
  aiRunning,
  pending,
  hydrating,
  workspaceMoved,
  recovery,
}: {
  readonly valid: boolean;
  readonly saveState: AutoSaveState;
  readonly aiRunning: boolean;
  readonly pending: boolean;
  readonly hydrating: boolean;
  readonly workspaceMoved: boolean;
  readonly recovery: "resolving" | "choice" | null;
}): GoalReviewActionControls {
  const savedDraftReason = savedDraftActionReason({
    valid,
    saveState,
    aiRunning,
    pending,
    workspaceMoved,
    hydrating,
    recovery,
  });
  const terminalReason = workspaceMoved
    ? "workspace-moved"
    : hydrating
      ? "hydrating"
      : pending
        ? "command-pending"
        : aiRunning
          ? "ai-running"
          : undefined;
  return {
    refine: control(savedDraftReason),
    continue: control(savedDraftReason),
    terminal: control(terminalReason),
  };
}
