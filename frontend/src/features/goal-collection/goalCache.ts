import type { QueryClient } from "@tanstack/react-query";

import type {
  Cycle,
  Goal,
  GoalDraft,
  GoalReview,
  Home,
  SaveFrameResponse,
} from "../../shared/api/schemas";

const userQueryRoot = (userId: string) => ["user", userId] as const;

export const userQueryKeys = {
  root: userQueryRoot,
  home: (userId: string) => [...userQueryRoot(userId), "home"] as const,
  goals: (userId: string, scope: string) =>
    [...userQueryRoot(userId), "goals", scope] as const,
  goal: (userId: string, goalId: string) =>
    [...userQueryRoot(userId), "goal", goalId] as const,
  review: (userId: string, goalId: string) =>
    [...userQueryRoot(userId), "goal-review", goalId] as const,
  goalCycles: (userId: string, goalId: string) =>
    [...userQueryRoot(userId), "goal-cycles", goalId] as const,
  cycle: (userId: string, goalId: string, cycleId: string) =>
    [...userQueryRoot(userId), "cycle", goalId, cycleId] as const,
};

export const userMutationKeys = {
  createGoalDraft: (userId: string) =>
    [...userQueryRoot(userId), "create-goal-draft"] as const,
};

export function preferGoal(current: Goal | undefined, incoming: Goal): Goal {
  return current && current.revision >= incoming.revision ? current : incoming;
}

export function cacheGoal(
  cache: QueryClient,
  userId: string,
  goal: Goal,
  updatedAt?: number,
): Goal {
  const queryKey = userQueryKeys.goal(userId, goal.id);
  const current = cache.getQueryData<{ readonly goal: Goal }>(queryKey);
  const canonicalGoal = preferGoal(current?.goal, goal);
  if (current?.goal === canonicalGoal) return canonicalGoal;

  cache.setQueryData(
    queryKey,
    { goal: canonicalGoal },
    updatedAt === undefined ? undefined : { updatedAt },
  );
  return canonicalGoal;
}

export function cacheGoals(
  cache: QueryClient,
  userId: string,
  goals: readonly Goal[],
  updatedAt?: number,
): void {
  for (const goal of goals) cacheGoal(cache, userId, goal, updatedAt);
}

export function cacheCycle(
  cache: QueryClient,
  userId: string,
  goal: Goal,
  cycle: Cycle,
): void {
  cacheGoal(cache, userId, goal);
  cache.setQueryData(userQueryKeys.cycle(userId, goal.id, cycle.id), { cycle });
}

export function cacheCycleFrame(
  cache: QueryClient,
  userId: string,
  goalId: string,
  saved: Pick<
    SaveFrameResponse,
    "cycleId" | "frame" | "content" | "frameRevision" | "contentRevision"
  >,
): void {
  cache.setQueryData<{ readonly cycle: Cycle }>(
    userQueryKeys.cycle(userId, goalId, saved.cycleId),
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

export function cacheReview(
  cache: QueryClient,
  userId: string,
  review: GoalReview,
): void {
  cacheGoal(cache, userId, review.goal);
  cache.setQueryData(userQueryKeys.review(userId, review.goal.id), review);
}

export function cacheReviewDraft(
  cache: QueryClient,
  userId: string,
  goalId: string,
  reviewDraft: GoalDraft,
): void {
  cache.setQueryData<GoalReview>(
    userQueryKeys.review(userId, goalId),
    (review) => (review ? { ...review, reviewDraft } : review),
  );
}

export function cacheCreationDraft(
  cache: QueryClient,
  userId: string,
  creationDraft: GoalDraft,
): void {
  cache.setQueryData<Home>(userQueryKeys.home(userId), (home) =>
    home
      ? {
          ...home,
          creationDraft,
          canCreateGoalDraft: false,
        }
      : home,
  );
}
