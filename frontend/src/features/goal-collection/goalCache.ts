import type { QueryClient } from "@tanstack/react-query";

import type {
  Cycle,
  Goal,
  GoalDraft,
  GoalReview,
  Home,
  SaveFrameResponse,
} from "../../shared/api/schemas";

export const goalQueryKey = (goalId: string) => ["goal", goalId] as const;
export const cycleQueryKey = (goalId: string, cycleId: string) =>
  ["goal", goalId, "cycle", cycleId] as const;
export const reviewQueryKey = (goalId: string) =>
  ["goal", goalId, "review"] as const;

export function cacheGoal(
  cache: QueryClient,
  goal: Goal,
  updatedAt?: number,
): void {
  cache.setQueryData(
    goalQueryKey(goal.id),
    { goal },
    updatedAt === undefined ? undefined : { updatedAt },
  );
}

export function cacheGoals(
  cache: QueryClient,
  goals: readonly Goal[],
  updatedAt?: number,
): void {
  for (const goal of goals) cacheGoal(cache, goal, updatedAt);
}

export function cacheCycle(cache: QueryClient, goal: Goal, cycle: Cycle): void {
  cacheGoal(cache, goal);
  cache.setQueryData(cycleQueryKey(goal.id, cycle.id), { cycle });
}

export function cacheCycleFrame(
  cache: QueryClient,
  goalId: string,
  saved: Pick<
    SaveFrameResponse,
    "cycleId" | "frame" | "content" | "frameRevision" | "contentRevision"
  >,
): void {
  cache.setQueryData<{ readonly cycle: Cycle }>(
    cycleQueryKey(goalId, saved.cycleId),
    (current) => {
      if (
        !current ||
        saved.frameRevision < current.cycle.frameRevisions[saved.frame]
      )
        return current;
      return {
        cycle: {
          ...current.cycle,
          [saved.frame]: saved.content,
          contentRevision: Math.max(
            current.cycle.contentRevision,
            saved.contentRevision,
          ),
          frameRevisions: {
            ...current.cycle.frameRevisions,
            [saved.frame]: saved.frameRevision,
          },
        },
      };
    },
  );
}

export function cacheReview(cache: QueryClient, review: GoalReview): void {
  cacheGoal(cache, review.goal);
  cache.setQueryData(reviewQueryKey(review.goal.id), review);
}

export function cacheReviewDraft(
  cache: QueryClient,
  goalId: string,
  reviewDraft: GoalDraft,
): void {
  cache.setQueryData<GoalReview>(reviewQueryKey(goalId), (review) =>
    review ? { ...review, reviewDraft } : review,
  );
}

export function cacheCreationDraft(
  cache: QueryClient,
  creationDraft: GoalDraft,
): void {
  cache.setQueryData<Home>(["home"], (home) =>
    home
      ? {
          ...home,
          creationDraft,
          canCreateGoalDraft: false,
        }
      : home,
  );
}
