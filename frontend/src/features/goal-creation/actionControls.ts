import type { AutoSaveState } from "../../shared/autosave/autoSaveCoordinator";

export type GoalCreationAction = "refine" | "start" | "discard";

export type GoalCreationActionDisabledReason =
  | "command-pending"
  | "hydrating"
  | "scope-moved"
  | "recovery-resolving"
  | "recovery-choice"
  | "save-dirty"
  | "save-saving"
  | "save-failed"
  | "ai-running"
  | "invalid-goal"
  | "progressing-goal-limit";

export type GoalCreationActionControl = {
  readonly enabled: boolean;
  readonly reason?: GoalCreationActionDisabledReason;
};

export type GoalCreationActionControls = Readonly<
  Record<GoalCreationAction, GoalCreationActionControl>
>;

function savedDraftActionReason({
  valid,
  saveState,
  aiRunning,
  pending,
  hydrating,
  scopeMoved,
  recovery,
}: {
  readonly valid: boolean;
  readonly saveState: AutoSaveState;
  readonly aiRunning: boolean;
  readonly pending: boolean;
  readonly hydrating: boolean;
  readonly scopeMoved: boolean;
  readonly recovery: "resolving" | "choice" | null;
}): GoalCreationActionDisabledReason | undefined {
  const disabled =
    !valid ||
    saveState.kind !== "saved" ||
    aiRunning ||
    pending ||
    hydrating ||
    scopeMoved ||
    recovery !== null;
  if (!disabled) return undefined;
  if (scopeMoved) return "scope-moved";
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

function control(
  reason?: GoalCreationActionDisabledReason,
): GoalCreationActionControl {
  return reason ? { enabled: false, reason } : { enabled: true };
}

export function getGoalCreationActionControls({
  valid,
  saveState,
  aiRunning,
  pending,
  canStartProgressingGoal,
  hydrating,
  scopeMoved,
  recovery,
}: {
  readonly valid: boolean;
  readonly saveState: AutoSaveState;
  readonly aiRunning: boolean;
  readonly pending: boolean;
  readonly canStartProgressingGoal: boolean;
  readonly hydrating: boolean;
  readonly scopeMoved: boolean;
  readonly recovery: "resolving" | "choice" | null;
}): GoalCreationActionControls {
  const savedDraftReason = savedDraftActionReason({
    valid,
    saveState,
    aiRunning,
    pending,
    hydrating,
    scopeMoved,
    recovery,
  });
  const startReason =
    savedDraftReason === "scope-moved" ||
    savedDraftReason === "recovery-resolving" ||
    savedDraftReason === "recovery-choice" ||
    savedDraftReason === "hydrating" ||
    savedDraftReason === "command-pending"
      ? savedDraftReason
      : canStartProgressingGoal
        ? savedDraftReason
        : "progressing-goal-limit";
  return {
    refine: control(savedDraftReason),
    start: control(startReason),
    discard: control(
      scopeMoved
        ? "scope-moved"
        : hydrating
          ? "hydrating"
          : pending
            ? "command-pending"
            : undefined,
    ),
  };
}
