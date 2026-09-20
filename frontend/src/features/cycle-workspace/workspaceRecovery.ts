import type { QueryClient } from "@tanstack/react-query";

import {
  cacheGoal,
  resolvePreferredGoal,
  userQueryKeys,
} from "../goal-collection";
import { APIError } from "../../shared/api/client";
import type { CurrentWork, Cycle, Goal } from "../../shared/api/schemas";
import {
  reconcileActiveCycleSchedule,
  resolvePreferredCycle,
} from "./cycleSnapshot";

export type MovedWorkspace = {
  readonly currentWorkspace: CurrentWork | null;
  readonly href?: string;
  readonly recovery?: "loading" | "failed" | "deleted";
  readonly goalSnapshot?: Goal;
  readonly cycleSnapshot?: Cycle;
};

export type CycleTerminalCommand =
  | "complete"
  | "replan"
  | "terminate"
  | "delete";

export function replayWorkspacePath(
  goalId: string,
  currentWorkspace: CurrentWork | null,
): string {
  if (currentWorkspace?.kind === "active_cycle")
    return `/goals/${goalId}/cycles/${currentWorkspace.cycleId}`;
  if (currentWorkspace?.kind === "goal_review")
    return `/goals/${goalId}/review`;
  return `/history/goals/${goalId}`;
}

export function publishMovedActiveWorkspace(
  cache: QueryClient,
  userId: string,
  movedWorkspace: MovedWorkspace,
): boolean {
  const goalSnapshot = movedWorkspace.goalSnapshot;
  const cycleSnapshot = movedWorkspace.cycleSnapshot;
  if (!goalSnapshot && !cycleSnapshot)
    return movedWorkspace.currentWorkspace?.kind !== "active_cycle";
  if (!goalSnapshot || !cycleSnapshot) return false;

  const goalKey = userQueryKeys.goal(userId, goalSnapshot.id);
  const goalResolution = resolvePreferredGoal(
    cache.getQueryData<{ readonly goal: Goal }>(goalKey)?.goal,
    goalSnapshot,
  );
  if (goalResolution.kind === "invariant") {
    cache.removeQueries({ queryKey: goalKey, exact: true });
    return false;
  }
  const cycleKey = userQueryKeys.cycle(
    userId,
    goalSnapshot.id,
    cycleSnapshot.id,
  );
  const cycleResolution = resolvePreferredCycle(
    cache.getQueryData<{ readonly cycle: Cycle }>(cycleKey)?.cycle,
    cycleSnapshot,
  );
  if (cycleResolution.kind === "invariant") {
    cache.removeQueries({ queryKey: cycleKey, exact: true });
    return false;
  }
  const reconciliation = reconcileActiveCycleSchedule(
    goalResolution.goal,
    cycleResolution.cycle,
  );
  if (reconciliation.kind === "invariant") return false;
  const currentWork = reconciliation.goal.currentWork;
  if (
    reconciliation.goal.status !== "active_cycle" ||
    currentWork?.kind !== "active_cycle" ||
    currentWork.cycleId !== reconciliation.cycle.id ||
    reconciliation.cycle.status !== "active"
  )
    return false;

  cacheGoal(cache, userId, reconciliation.goal);
  cache.setQueryData(cycleKey, { cycle: reconciliation.cycle });
  return true;
}

export function isCycleWorkspaceRecoveryError(
  error: unknown,
): error is APIError {
  return (
    error instanceof APIError &&
    error.status === 409 &&
    (error.code === "CYCLE_REVISION_CONFLICT" ||
      error.code === "GOAL_STATE_CONFLICT" ||
      error.code === "CYCLE_NOT_ACTIVE")
  );
}

export function isGoalNotFound(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.status === 404 &&
    error.code === "GOAL_NOT_FOUND"
  );
}

export function isCycleCommandWorkspaceConflict(
  command: CycleTerminalCommand,
  error: unknown,
): error is APIError {
  if (isGoalNotFound(error)) return true;
  if (!(error instanceof APIError)) return false;
  if (command === "replan")
    return (
      (error.status === 404 && error.code === "CYCLE_NOT_FOUND") ||
      (error.status === 409 &&
        (error.code === "GOAL_STATE_CONFLICT" ||
          error.code === "GOAL_VERSION_CONFLICT" ||
          error.code === "CYCLE_NOT_ACTIVE" ||
          error.code === "CYCLE_REVISION_CONFLICT"))
    );
  if (error.status !== 409) return false;
  if (command === "complete")
    return (
      error.code === "GOAL_STATE_CONFLICT" ||
      error.code === "GOAL_VERSION_CONFLICT" ||
      error.code === "CYCLE_NOT_ACTIVE"
    );
  if (command === "terminate")
    return (
      error.code === "GOAL_STATE_CONFLICT" ||
      error.code === "GOAL_ALREADY_TERMINAL"
    );
  return error.code === "GOAL_DELETE_CONFLICT";
}
