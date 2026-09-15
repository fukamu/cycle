import type { Cycle, Goal } from "../../shared/api/schemas";

export type CycleSnapshotResolution =
  | { readonly kind: "accept"; readonly cycle: Cycle }
  | { readonly kind: "invariant" };

export function resolvePreferredCycle(
  current: Cycle | undefined,
  incoming: Cycle,
): CycleSnapshotResolution {
  if (!current) return { kind: "accept", cycle: incoming };
  if (
    current.id !== incoming.id ||
    (current.goalId !== undefined &&
      incoming.goalId !== undefined &&
      current.goalId !== incoming.goalId)
  )
    return { kind: "invariant" };
  const currentTerminal = current.status !== "active";
  const incomingTerminal = incoming.status !== "active";
  if (currentTerminal !== incomingTerminal)
    return {
      kind: "accept",
      cycle: currentTerminal ? current : incoming,
    };
  if (currentTerminal && current.status !== incoming.status)
    return { kind: "accept", cycle: current };
  if (
    currentTerminal &&
    (current.reviewScheduleRevision !== incoming.reviewScheduleRevision ||
      current.reviewDate !== incoming.reviewDate)
  )
    return { kind: "invariant" };
  const preferred =
    current.contentRevision >= incoming.contentRevision ? current : incoming;
  if (currentTerminal) return { kind: "accept", cycle: preferred };

  if (
    current.reviewScheduleRevision === incoming.reviewScheduleRevision &&
    current.reviewDate !== incoming.reviewDate
  )
    return { kind: "invariant" };

  const schedule =
    incoming.reviewScheduleRevision > current.reviewScheduleRevision
      ? {
          reviewDate: incoming.reviewDate,
          reviewScheduleRevision: incoming.reviewScheduleRevision,
        }
      : {
          reviewDate: current.reviewDate,
          reviewScheduleRevision: current.reviewScheduleRevision,
        };
  if (
    preferred.reviewDate === schedule.reviewDate &&
    preferred.reviewScheduleRevision === schedule.reviewScheduleRevision
  )
    return { kind: "accept", cycle: preferred };
  return { kind: "accept", cycle: { ...preferred, ...schedule } };
}

export type ActiveCycleScheduleReconciliation =
  | { readonly kind: "accept"; readonly goal: Goal; readonly cycle: Cycle }
  | { readonly kind: "invariant" };

export function reconcileActiveCycleSchedule(
  goal: Goal,
  cycle: Cycle,
): ActiveCycleScheduleReconciliation {
  const work = goal.currentWork;
  const goalOwnsActiveCycle =
    goal.status === "active_cycle" &&
    work?.kind === "active_cycle" &&
    work.cycleId === cycle.id;
  if (cycle.status === "active" && !goalOwnsActiveCycle)
    return { kind: "invariant" };
  if (
    goalOwnsActiveCycle &&
    cycle.goalId !== undefined &&
    cycle.goalId !== goal.id
  )
    return { kind: "invariant" };
  if (!goalOwnsActiveCycle || cycle.status !== "active")
    return { kind: "accept", goal, cycle };
  const goalSchedule = work.reviewSchedule;
  const cycleSchedule = {
    reviewDate: cycle.reviewDate,
    reviewScheduleRevision: cycle.reviewScheduleRevision,
  };
  if (
    goalSchedule.reviewScheduleRevision ===
      cycleSchedule.reviewScheduleRevision &&
    goalSchedule.reviewDate !== cycleSchedule.reviewDate
  )
    return { kind: "invariant" };
  if (
    goalSchedule.reviewScheduleRevision > cycleSchedule.reviewScheduleRevision
  )
    return {
      kind: "accept",
      goal,
      cycle: {
        ...cycle,
        reviewDate: goalSchedule.reviewDate,
        reviewScheduleRevision: goalSchedule.reviewScheduleRevision,
      },
    };
  if (
    cycleSchedule.reviewScheduleRevision > goalSchedule.reviewScheduleRevision
  )
    return {
      kind: "accept",
      goal: {
        ...goal,
        currentWork: { ...work, reviewSchedule: cycleSchedule },
      },
      cycle,
    };
  return { kind: "accept", goal, cycle };
}
