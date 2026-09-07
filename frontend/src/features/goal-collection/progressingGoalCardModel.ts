import type { Goal } from "../../shared/api/schemas";

export type ProgressingGoalCardViewModel = {
  readonly goalId: string;
  readonly goalBody: string;
  readonly currentPlace: string;
  readonly helper: string;
  readonly target: string;
  readonly cta: string;
};

export function getProgressingGoalCardViewModel(
  goal: Goal,
): ProgressingGoalCardViewModel | null {
  const work = goal.currentWork;
  if (goal.status === "active_cycle" && work?.kind === "active_cycle")
    return {
      goalId: goal.id,
      goalBody: goal.currentVersion.body,
      currentPlace: `Cycle ${work.cycleSequenceNumber} 実行中`,
      helper: "P/D/C/Aの記録を続けましょう。",
      target: `/goals/${goal.id}/cycles/${work.cycleId}`,
      cta: `Cycle ${work.cycleSequenceNumber}を続ける`,
    };
  if (goal.status === "goal_review" && work?.kind === "goal_review")
    return {
      goalId: goal.id,
      goalBody: goal.currentVersion.body,
      currentPlace: "目標の見直し中",
      helper: `Cycle ${work.triggerCycleSequenceNumber}を振り返り、目標を続けるか決めましょう。`,
      target: `/goals/${goal.id}/review`,
      cta: "目標を見直す",
    };
  return null;
}
