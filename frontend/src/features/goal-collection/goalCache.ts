import type { QueryClient } from "@tanstack/react-query";

import type {
  Cycle,
  Goal,
  GoalDraft,
  GoalReview,
  Home,
  ReviewSchedule,
  SaveFrameResponse,
} from "../../shared/api/schemas";

const userQueryRoot = (userId: string) => ["user", userId] as const;
const goalReviewQueryKey = (userId: string, goalId: string) =>
  [...userQueryRoot(userId), "goal-review", goalId] as const;

export const userQueryKeys = {
  root: userQueryRoot,
  home: (userId: string) => [...userQueryRoot(userId), "home"] as const,
  goals: (userId: string, scope: string) =>
    [...userQueryRoot(userId), "goals", scope] as const,
  goal: (userId: string, goalId: string) =>
    [...userQueryRoot(userId), "goal", goalId] as const,
  review: goalReviewQueryKey,
  reviewTransport: (userId: string, goalId: string, entryId: string) =>
    [...goalReviewQueryKey(userId, goalId), "transport", entryId] as const,
  goalCycles: (userId: string, goalId: string) =>
    [...userQueryRoot(userId), "goal-cycles", goalId] as const,
  cycle: (userId: string, goalId: string, cycleId: string) =>
    [...userQueryRoot(userId), "cycle", goalId, cycleId] as const,
};

export const userMutationKeys = {
  createGoalDraft: (userId: string) =>
    [...userQueryRoot(userId), "create-goal-draft"] as const,
};

const goalCollectionQueryKinds = new Set(["home", "goals"]);
const goalDetailQueryKinds = new Set([
  "goal",
  "goal-review",
  "goal-cycles",
  "cycle",
]);

export function removeGoalFromCache(
  cache: QueryClient,
  userId: string,
  goalId: string,
): void {
  cache.removeQueries({
    predicate: ({ queryKey }) => {
      if (queryKey[0] !== "user" || queryKey[1] !== userId) return false;
      const kind = queryKey[2];
      if (typeof kind !== "string") return false;
      if (goalCollectionQueryKinds.has(kind)) return true;
      return goalDetailQueryKinds.has(kind) && queryKey[3] === goalId;
    },
  });
}

export type GoalSnapshotResolution =
  | { readonly kind: "accept"; readonly goal: Goal }
  | { readonly kind: "invariant" };

export function resolvePreferredGoal(
  current: Goal | undefined,
  incoming: Goal,
): GoalSnapshotResolution {
  if (!current) return { kind: "accept", goal: incoming };
  const preferred = current.revision >= incoming.revision ? current : incoming;
  if (current.id !== incoming.id) return { kind: "accept", goal: preferred };
  const currentWork = current.currentWork;
  const incomingWork = incoming.currentWork;
  if (
    current.status !== "active_cycle" ||
    incoming.status !== "active_cycle" ||
    currentWork?.kind !== "active_cycle" ||
    incomingWork?.kind !== "active_cycle" ||
    currentWork.cycleId !== incomingWork.cycleId
  )
    return { kind: "accept", goal: preferred };

  if (
    currentWork.reviewSchedule.reviewScheduleRevision ===
      incomingWork.reviewSchedule.reviewScheduleRevision &&
    currentWork.reviewSchedule.reviewDate !==
      incomingWork.reviewSchedule.reviewDate
  )
    return { kind: "invariant" };

  const selectedSchedule =
    incomingWork.reviewSchedule.reviewScheduleRevision >
    currentWork.reviewSchedule.reviewScheduleRevision
      ? incomingWork.reviewSchedule
      : currentWork.reviewSchedule;
  const preferredWork = preferred.currentWork;
  if (
    preferredWork?.kind !== "active_cycle" ||
    schedulesEqual(preferredWork.reviewSchedule, selectedSchedule)
  )
    return { kind: "accept", goal: preferred };
  return {
    kind: "accept",
    goal: {
      ...preferred,
      currentWork: {
        ...preferredWork,
        reviewSchedule: selectedSchedule,
      },
    },
  };
}

export function preferGoal(current: Goal | undefined, incoming: Goal): Goal {
  const resolution = resolvePreferredGoal(current, incoming);
  return resolution.kind === "accept" ? resolution.goal : (current ?? incoming);
}

export type GoalReviewPublicationResolution =
  | { readonly kind: "accept"; readonly snapshot: GoalReview }
  | { readonly kind: "preserve-current"; readonly snapshot: GoalReview }
  | { readonly kind: "workspace-moved"; readonly goal: Goal }
  | { readonly kind: "invariant" };

export function resolveGoalReviewPublication({
  canonicalGoal,
  currentReview,
  incoming,
}: {
  readonly canonicalGoal: Goal | undefined;
  readonly currentReview: GoalReview | undefined;
  readonly incoming: GoalReview;
}): GoalReviewPublicationResolution {
  if (canonicalGoal !== undefined && canonicalGoal.id !== incoming.goal.id)
    return { kind: "invariant" };
  if (currentReview !== undefined && currentReview.goal.id !== incoming.goal.id)
    return { kind: "invariant" };

  if (
    currentReview !== undefined &&
    currentReview.goal.revision === incoming.goal.revision &&
    (currentReview.reviewDraft.id !== incoming.reviewDraft.id ||
      currentReview.triggerCycle.id !== incoming.triggerCycle.id)
  )
    return { kind: "invariant" };
  if (canonicalGoal?.status === "achieved" || canonicalGoal?.status === "ended")
    return { kind: "workspace-moved", goal: canonicalGoal };

  const currentRevision = currentReview?.goal.revision ?? -1;
  const canonicalRevision = canonicalGoal?.revision ?? -1;
  if (
    currentReview !== undefined &&
    currentRevision > canonicalRevision &&
    currentRevision > incoming.goal.revision
  )
    return { kind: "preserve-current", snapshot: currentReview };
  if (
    incoming.goal.revision > canonicalRevision &&
    incoming.goal.revision > currentRevision
  )
    return { kind: "accept", snapshot: incoming };

  if (
    canonicalGoal !== undefined &&
    canonicalGoal.revision > incoming.goal.revision
  ) {
    if (canonicalGoal.status !== "goal_review")
      return { kind: "workspace-moved", goal: canonicalGoal };

    const canonicalWork = canonicalGoal.currentWork;
    if (canonicalWork?.kind !== "goal_review") return { kind: "invariant" };
    if (currentReview?.goal.revision !== canonicalGoal.revision)
      return { kind: "workspace-moved", goal: canonicalGoal };
    if (
      canonicalWork.reviewDraftId !== currentReview.reviewDraft.id ||
      canonicalWork.triggerCycleId !== currentReview.triggerCycle.id ||
      canonicalWork.triggerCycleSequenceNumber !==
        currentReview.triggerCycle.sequenceNumber
    )
      return { kind: "invariant" };
    return { kind: "preserve-current", snapshot: currentReview };
  }

  if (
    canonicalGoal !== undefined &&
    canonicalGoal.revision === incoming.goal.revision
  ) {
    if (canonicalGoal.status !== "goal_review")
      return { kind: "workspace-moved", goal: canonicalGoal };

    const canonicalWork = canonicalGoal.currentWork;
    if (
      canonicalWork?.kind !== "goal_review" ||
      canonicalWork.reviewDraftId !== incoming.reviewDraft.id ||
      canonicalWork.triggerCycleId !== incoming.triggerCycle.id ||
      canonicalWork.triggerCycleSequenceNumber !==
        incoming.triggerCycle.sequenceNumber
    )
      return { kind: "invariant" };
  }

  if (currentReview === undefined)
    return { kind: "accept", snapshot: incoming };
  if (currentReview.goal.revision > incoming.goal.revision)
    return { kind: "preserve-current", snapshot: currentReview };
  if (currentReview.goal.revision < incoming.goal.revision)
    return { kind: "accept", snapshot: incoming };

  if (
    currentReview.reviewDraft.id !== incoming.reviewDraft.id ||
    currentReview.triggerCycle.id !== incoming.triggerCycle.id
  )
    return { kind: "invariant" };
  if (currentReview.reviewDraft.revision >= incoming.reviewDraft.revision)
    return { kind: "preserve-current", snapshot: currentReview };
  return { kind: "accept", snapshot: incoming };
}

export function preferGoalReview(
  current: GoalReview | undefined,
  incoming: GoalReview,
): GoalReview {
  if (
    !current ||
    current.goal.id !== incoming.goal.id ||
    current.reviewDraft.id !== incoming.reviewDraft.id ||
    current.reviewDraft.revision < incoming.reviewDraft.revision
  )
    return incoming;
  return current;
}

export function cacheGoal(
  cache: QueryClient,
  userId: string,
  goal: Goal,
  updatedAt?: number,
): Goal {
  const queryKey = userQueryKeys.goal(userId, goal.id);
  const current = cache.getQueryData<{ readonly goal: Goal }>(queryKey);
  const resolution = resolvePreferredGoal(current?.goal, goal);
  if (resolution.kind === "invariant") {
    cache.removeQueries({ queryKey, exact: true });
    return current?.goal ?? goal;
  }
  const canonicalGoal = resolution.goal;
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
  for (const goal of goals) {
    const currentGoal = cache.getQueryData<{ readonly goal: Goal }>(
      userQueryKeys.goal(userId, goal.id),
    )?.goal;
    const currentWork = currentGoal?.currentWork;
    const incomingWork = goal.currentWork;
    const scheduleInvariant =
      currentGoal?.status === "active_cycle" &&
      goal.status === "active_cycle" &&
      currentWork?.kind === "active_cycle" &&
      incomingWork?.kind === "active_cycle" &&
      currentWork.cycleId === incomingWork.cycleId &&
      currentWork.reviewSchedule.reviewScheduleRevision ===
        incomingWork.reviewSchedule.reviewScheduleRevision &&
      currentWork.reviewSchedule.reviewDate !==
        incomingWork.reviewSchedule.reviewDate;
    cacheGoal(cache, userId, goal, updatedAt);
    const work = incomingWork;
    if (goal.status !== "active_cycle" || work?.kind !== "active_cycle")
      continue;
    const cycleKey = userQueryKeys.cycle(userId, goal.id, work.cycleId);
    if (scheduleInvariant) {
      cache.removeQueries({
        queryKey: userQueryKeys.goal(userId, goal.id),
        exact: true,
      });
      cache.removeQueries({ queryKey: cycleKey, exact: true });
      continue;
    }
    const currentCycle = cache.getQueryData<{ readonly cycle: Cycle }>(
      cycleKey,
    )?.cycle;
    if (!currentCycle) continue;
    const resolution = publishReviewSchedule(
      cache,
      userId,
      goal.id,
      work.cycleId,
      {
        ...currentCycle,
        reviewDate: work.reviewSchedule.reviewDate,
        reviewScheduleRevision: work.reviewSchedule.reviewScheduleRevision,
      },
    );
    if (resolution.kind === "invariant") {
      cache.removeQueries({
        queryKey: userQueryKeys.goal(userId, goal.id),
        exact: true,
      });
      cache.removeQueries({ queryKey: cycleKey, exact: true });
    }
  }
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

export type ReviewSchedulePublicationResolution =
  | {
      readonly kind: "accept" | "preserve-current";
      readonly schedule: ReviewSchedule;
    }
  | { readonly kind: "workspace-moved" }
  | { readonly kind: "invariant" };

function scheduleFromCycle(cycle: Cycle): ReviewSchedule {
  return {
    reviewDate: cycle.reviewDate,
    reviewScheduleRevision: cycle.reviewScheduleRevision,
  };
}

function schedulesEqual(left: ReviewSchedule, right: ReviewSchedule): boolean {
  return (
    left.reviewScheduleRevision === right.reviewScheduleRevision &&
    left.reviewDate === right.reviewDate
  );
}

export function publishReviewSchedule(
  cache: QueryClient,
  userId: string,
  goalId: string,
  cycleId: string,
  incomingCycle: Cycle,
): ReviewSchedulePublicationResolution {
  if (
    incomingCycle.id !== cycleId ||
    (incomingCycle.goalId !== undefined && incomingCycle.goalId !== goalId)
  )
    return { kind: "invariant" };
  if (incomingCycle.status !== "active") return { kind: "workspace-moved" };

  const cycleKey = userQueryKeys.cycle(userId, goalId, cycleId);
  const goalKey = userQueryKeys.goal(userId, goalId);
  const homeKey = userQueryKeys.home(userId);
  const currentCycle = cache.getQueryData<{ readonly cycle: Cycle }>(cycleKey);
  const currentGoal = cache.getQueryData<{ readonly goal: Goal }>(goalKey);
  const currentHome = cache.getQueryData<Home>(homeKey);
  const homeGoals = currentHome?.progressingGoals.filter(
    (candidate) => candidate.id === goalId,
  );
  if ((homeGoals?.length ?? 0) > 1) return { kind: "invariant" };
  const homeGoal = homeGoals?.[0];

  if (
    currentCycle &&
    (currentCycle.cycle.id !== cycleId ||
      (currentCycle.cycle.goalId !== undefined &&
        currentCycle.cycle.goalId !== goalId))
  )
    return { kind: "invariant" };
  if (currentCycle && currentCycle.cycle.status !== "active")
    return { kind: "workspace-moved" };
  if (currentGoal && currentGoal.goal.id !== goalId)
    return { kind: "invariant" };

  const matchingActiveWork = (goal: Goal | undefined) => {
    if (!goal) return undefined;
    if (
      goal.status !== "active_cycle" ||
      goal.currentWork?.kind !== "active_cycle" ||
      goal.currentWork.cycleId !== cycleId
    )
      return null;
    return goal.currentWork;
  };
  const goalWork = matchingActiveWork(currentGoal?.goal);
  const homeWork = matchingActiveWork(homeGoal);
  if (goalWork === null || homeWork === null)
    return { kind: "workspace-moved" };

  const incomingSchedule = scheduleFromCycle(incomingCycle);
  const candidates = [
    incomingSchedule,
    ...(currentCycle ? [scheduleFromCycle(currentCycle.cycle)] : []),
    ...(goalWork ? [goalWork.reviewSchedule] : []),
    ...(homeWork ? [homeWork.reviewSchedule] : []),
  ];
  let selected = incomingSchedule;
  for (const candidate of candidates) {
    if (candidate.reviewScheduleRevision > selected.reviewScheduleRevision) {
      selected = candidate;
      continue;
    }
    if (
      candidate.reviewScheduleRevision === selected.reviewScheduleRevision &&
      candidate.reviewDate !== selected.reviewDate
    )
      return { kind: "invariant" };
  }

  if (
    !currentCycle ||
    !schedulesEqual(scheduleFromCycle(currentCycle.cycle), selected)
  )
    cache.setQueryData<{ readonly cycle: Cycle }>(cycleKey, (current) => ({
      cycle: {
        ...(current?.cycle ?? incomingCycle),
        reviewDate: selected.reviewDate,
        reviewScheduleRevision: selected.reviewScheduleRevision,
      },
    }));
  if (goalWork && !schedulesEqual(goalWork.reviewSchedule, selected))
    cache.setQueryData<{ readonly goal: Goal }>(goalKey, (current) =>
      current?.goal.currentWork?.kind === "active_cycle" &&
      current.goal.currentWork.cycleId === cycleId
        ? {
            goal: {
              ...current.goal,
              currentWork: {
                ...current.goal.currentWork,
                reviewSchedule: selected,
              },
            },
          }
        : current,
    );
  if (homeWork && !schedulesEqual(homeWork.reviewSchedule, selected))
    cache.setQueryData<Home>(homeKey, (current) =>
      current
        ? {
            ...current,
            progressingGoals: current.progressingGoals.map((goal) =>
              goal.id === goalId &&
              goal.status === "active_cycle" &&
              goal.currentWork?.kind === "active_cycle" &&
              goal.currentWork.cycleId === cycleId
                ? {
                    ...goal,
                    currentWork: {
                      ...goal.currentWork,
                      reviewSchedule: selected,
                    },
                  }
                : goal,
            ),
          }
        : current,
    );

  return {
    kind: schedulesEqual(selected, incomingSchedule)
      ? "accept"
      : "preserve-current",
    schedule: selected,
  };
}

export function cacheReview(
  cache: QueryClient,
  userId: string,
  review: GoalReview,
): void {
  publishGoalReview(cache, userId, review);
}

export function publishGoalReview(
  cache: QueryClient,
  userId: string,
  review: GoalReview,
): GoalReviewPublicationResolution {
  const goalKey = userQueryKeys.goal(userId, review.goal.id);
  const reviewKey = userQueryKeys.review(userId, review.goal.id);
  const resolution = resolveGoalReviewPublication({
    canonicalGoal: cache.getQueryData<{ readonly goal: Goal }>(goalKey)?.goal,
    currentReview: cache.getQueryData<GoalReview>(reviewKey),
    incoming: review,
  });
  if (resolution.kind !== "accept") return resolution;

  cache.setQueryData(goalKey, { goal: resolution.snapshot.goal });
  cache.setQueryData(reviewKey, resolution.snapshot);
  return resolution;
}

export function cacheReviewDraft(
  cache: QueryClient,
  userId: string,
  goalId: string,
  reviewDraft: GoalDraft,
): void {
  const reviewKey = userQueryKeys.review(userId, goalId);
  const current = cache.getQueryData<GoalReview>(reviewKey);
  if (
    !current ||
    current.goal.id !== goalId ||
    reviewDraft.goalId !== goalId ||
    current.reviewDraft.id !== reviewDraft.id
  )
    return;

  const resolution = resolveGoalReviewPublication({
    canonicalGoal: cache.getQueryData<{ readonly goal: Goal }>(
      userQueryKeys.goal(userId, goalId),
    )?.goal,
    currentReview: current,
    incoming: { ...current, reviewDraft },
  });
  if (resolution.kind !== "accept") return;
  cache.setQueryData(reviewKey, resolution.snapshot);
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
