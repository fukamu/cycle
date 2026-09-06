import { QueryClient } from "@tanstack/react-query";

import type {
  Cycle,
  Goal,
  GoalDraft,
  GoalReview,
  Home,
} from "../../shared/api/schemas";
import {
  cacheCreationDraft,
  cacheCycle,
  cacheCycleFrame,
  cacheGoal,
  cacheGoals,
  cacheReview,
  cacheReviewDraft,
  preferGoal,
  preferGoalReview,
  removeGoalFromCache,
  userMutationKeys,
  userQueryKeys,
} from "./goalCache";

const userId = "10000000-0000-7000-8000-000000000001";
const otherUserId = "10000000-0000-7000-8000-000000000002";

const goal: Goal = {
  id: "20000000-0000-7000-8000-000000000001",
  status: "active_cycle",
  revision: 0,
  currentVersion: {
    id: "30000000-0000-7000-8000-000000000001",
    versionNumber: 1,
    body: "目標",
    createdAt: "2026-08-20T00:00:00.000Z",
  },
  currentWork: {
    kind: "active_cycle",
    cycleId: "40000000-0000-7000-8000-000000000001",
    cycleSequenceNumber: 1,
  },
  nextCycleSequenceNumber: 2,
  cycleCount: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  terminalAt: null,
};

const cycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: goal.id,
  sequenceNumber: 1,
  status: "active",
  goalVersion: goal.currentVersion,
  startedAt: "2026-08-20T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  plan: "",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};

const draft: GoalDraft = {
  id: "10000000-0000-7000-8000-000000000001",
  draftType: "creation",
  body: "",
  revision: 0,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const reviewDraft: GoalDraft = {
  ...draft,
  id: "10000000-0000-7000-8000-000000000002",
  draftType: "review",
  goalId: goal.id,
  baseGoalVersionId: goal.currentVersion.id,
  reviewCycleId: cycle.id,
  body: "目標",
};

const goalReview: GoalReview = {
  goal,
  reviewDraft,
  triggerCycle: cycle,
};

describe("goal cache", () => {
  it("defines every server-state key under the owning user root", () => {
    expect(userQueryKeys.root(userId)).toEqual(["user", userId]);
    expect(userQueryKeys.home(userId)).toEqual(["user", userId, "home"]);
    expect(userQueryKeys.goals(userId, "all")).toEqual([
      "user",
      userId,
      "goals",
      "all",
    ]);
    expect(userQueryKeys.goal(userId, goal.id)).toEqual([
      "user",
      userId,
      "goal",
      goal.id,
    ]);
    expect(userQueryKeys.review(userId, goal.id)).toEqual([
      "user",
      userId,
      "goal-review",
      goal.id,
    ]);
    expect(userQueryKeys.goalCycles(userId, goal.id)).toEqual([
      "user",
      userId,
      "goal-cycles",
      goal.id,
    ]);
    expect(userQueryKeys.cycle(userId, goal.id, cycle.id)).toEqual([
      "user",
      userId,
      "cycle",
      goal.id,
      cycle.id,
    ]);
    expect(userMutationKeys.createGoalDraft(userId)).toEqual([
      "user",
      userId,
      "create-goal-draft",
    ]);
  });

  it("removes deleted Goal collections and details without touching other ownership", () => {
    const cache = new QueryClient();
    const otherGoalId = "20000000-0000-7000-8000-000000000099";
    const affectedKeys = [
      userQueryKeys.home(userId),
      userQueryKeys.goals(userId, "all"),
      userQueryKeys.goal(userId, goal.id),
      userQueryKeys.review(userId, goal.id),
      userQueryKeys.goalCycles(userId, goal.id),
      userQueryKeys.cycle(userId, goal.id, cycle.id),
    ] as const;
    const retainedKeys = [
      userQueryKeys.goal(userId, otherGoalId),
      userQueryKeys.cycle(userId, otherGoalId, cycle.id),
      userQueryKeys.home(otherUserId),
      userQueryKeys.goal(otherUserId, goal.id),
    ] as const;
    for (const key of [...affectedKeys, ...retainedKeys])
      cache.setQueryData(key, { marker: key.join(":") });

    removeGoalFromCache(cache, userId, goal.id);

    for (const key of affectedKeys)
      expect(cache.getQueryData(key)).toBeUndefined();
    for (const key of retainedKeys)
      expect(cache.getQueryData(key)).toEqual({ marker: key.join(":") });
  });

  it("primes goal and cycle details from a transition response", () => {
    const cache = new QueryClient();

    cacheCycle(cache, userId, goal, cycle);

    expect(cache.getQueryData(userQueryKeys.goal(userId, goal.id))).toEqual({
      goal,
    });
    expect(
      cache.getQueryData(userQueryKeys.cycle(userId, goal.id, cycle.id)),
    ).toEqual({ cycle });
  });

  it("adds a created draft only to the captured user's home response", () => {
    const cache = new QueryClient();
    const home: Home = {
      progressingGoals: [],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: true,
    };
    const otherHome = { ...home, progressingGoals: [goal] };
    cache.setQueryData(userQueryKeys.home(userId), home);
    cache.setQueryData(userQueryKeys.home(otherUserId), otherHome);

    cacheCreationDraft(cache, userId, draft);

    expect(cache.getQueryData<Home>(userQueryKeys.home(userId))).toEqual({
      ...home,
      creationDraft: draft,
      canCreateGoalDraft: false,
    });
    expect(cache.getQueryData<Home>(userQueryKeys.home(otherUserId))).toEqual(
      otherHome,
    );
  });

  it("keeps a saved frame in the canonical cycle detail", () => {
    const cache = new QueryClient();
    cacheCycle(cache, userId, goal, cycle);

    cacheCycleFrame(cache, userId, goal.id, {
      cycleId: cycle.id,
      frame: "plan",
      content: "保存後のP",
      frameRevision: 1,
      contentRevision: 1,
    });

    expect(
      cache.getQueryData<{ cycle: Cycle }>(
        userQueryKeys.cycle(userId, goal.id, cycle.id),
      )?.cycle,
    ).toEqual({
      ...cycle,
      plan: "保存後のP",
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    });
  });

  it("does not let an older frame response regress canonical state", () => {
    const cache = new QueryClient();
    cacheCycle(cache, userId, goal, {
      ...cycle,
      plan: "newer",
      contentRevision: 3,
      frameRevisions: { ...cycle.frameRevisions, plan: 2 },
    });

    cacheCycleFrame(cache, userId, goal.id, {
      cycleId: cycle.id,
      frame: "plan",
      content: "older",
      frameRevision: 1,
      contentRevision: 2,
    });

    expect(
      cache.getQueryData<{ cycle: Cycle }>(
        userQueryKeys.cycle(userId, goal.id, cycle.id),
      )?.cycle,
    ).toMatchObject({
      plan: "newer",
      contentRevision: 3,
      frameRevisions: { plan: 2 },
    });
  });

  it("does not let a late goal collection snapshot regress a newer detail", () => {
    const cache = new QueryClient();
    const newer = {
      ...goal,
      revision: 2,
      currentVersion: { ...goal.currentVersion, body: "新しい目標" },
    };
    const older = {
      ...goal,
      revision: 1,
      currentVersion: { ...goal.currentVersion, body: "古い目標" },
    };
    cache.setQueryData(userQueryKeys.goal(userId, goal.id), { goal: newer });

    cacheGoals(cache, userId, [older]);

    expect(cache.getQueryData(userQueryKeys.goal(userId, goal.id))).toEqual({
      goal: newer,
    });
  });

  it("returns the canonical goal selected by the shared revision policy", () => {
    const cache = new QueryClient();
    const newer = {
      ...goal,
      revision: 2,
      currentVersion: { ...goal.currentVersion, body: "新しい目標" },
    };
    const older = {
      ...goal,
      revision: 1,
      currentVersion: { ...goal.currentVersion, body: "古い目標" },
    };

    expect(preferGoal(older, newer)).toBe(newer);
    expect(preferGoal(newer, older)).toBe(newer);
    expect(cacheGoal(cache, userId, newer)).toBe(newer);
    expect(cacheGoal(cache, userId, older)).toBe(newer);
    expect(cache.getQueryData(userQueryKeys.goal(userId, goal.id))).toEqual({
      goal: newer,
    });
  });

  it.each([
    { label: "older", revision: 1 },
    { label: "equal", revision: 2 },
  ])(
    "keeps the exact current review for a $label same-draft payload",
    ({ revision }) => {
      const current: GoalReview = {
        ...goalReview,
        reviewDraft: {
          ...reviewDraft,
          body: "現在のReview",
          revision: 2,
        },
      };
      const incoming: GoalReview = {
        goal: {
          ...goal,
          currentVersion: {
            ...goal.currentVersion,
            body: "遅延payloadのGoal",
          },
        },
        reviewDraft: {
          ...reviewDraft,
          body: "遅延payloadのReview",
          revision,
        },
        triggerCycle: { ...cycle, plan: "遅延payloadのCycle" },
      };

      expect(preferGoalReview(current, incoming)).toBe(current);
    },
  );

  it("accepts the exact whole payload only when the same draft is strictly newer", () => {
    const current: GoalReview = {
      ...goalReview,
      reviewDraft: {
        ...reviewDraft,
        body: "現在のReview",
        revision: 2,
      },
    };
    const incoming: GoalReview = {
      goal: {
        ...goal,
        currentVersion: {
          ...goal.currentVersion,
          body: "incoming payloadのGoal",
        },
      },
      reviewDraft: {
        ...reviewDraft,
        body: "incoming payloadのReview",
        revision: 3,
      },
      triggerCycle: { ...cycle, plan: "incoming payloadのCycle" },
    };

    const preferred = preferGoalReview(current, incoming);

    expect(preferred).toBe(incoming);
    expect(preferred).toEqual(incoming);
  });

  it("accepts a replacement draft as a whole payload without comparing revisions", () => {
    const current: GoalReview = {
      ...goalReview,
      reviewDraft: { ...reviewDraft, revision: 9 },
    };
    const incoming: GoalReview = {
      ...goalReview,
      reviewDraft: {
        ...reviewDraft,
        id: "10000000-0000-7000-8000-000000000003",
        body: "新しいReview世代",
        revision: 0,
      },
    };

    expect(preferGoalReview(current, incoming)).toBe(incoming);
  });

  it("accepts a different Goal identity as a whole payload", () => {
    const incomingGoalId = "20000000-0000-7000-8000-000000000002";
    const incoming: GoalReview = {
      ...goalReview,
      goal: { ...goal, id: incomingGoalId },
      reviewDraft: {
        ...reviewDraft,
        goalId: incomingGoalId,
        revision: 0,
      },
    };

    expect(preferGoalReview(goalReview, incoming)).toBe(incoming);
  });

  it("keeps a saved review draft in the canonical review detail", () => {
    const cache = new QueryClient();
    cacheReview(cache, userId, goalReview);
    const saved = { ...reviewDraft, body: "保存後の目標", revision: 1 };

    cacheReviewDraft(cache, userId, goal.id, saved);

    const cached = cache.getQueryData<GoalReview>(
      userQueryKeys.review(userId, goal.id),
    );
    expect(cached).not.toBe(goalReview);
    expect(cached?.reviewDraft).toEqual(saved);
    expect(cached).toEqual({ goal, reviewDraft: saved, triggerCycle: cycle });
  });

  it.each([
    { label: "older", revision: 1 },
    { label: "equal", revision: 2 },
  ])(
    "keeps the exact cached review for a $label draft mutation result",
    ({ revision }) => {
      const cache = new QueryClient();
      const current: GoalReview = {
        ...goalReview,
        reviewDraft: {
          ...reviewDraft,
          body: "現在のReview",
          revision: 2,
        },
      };
      cacheReview(cache, userId, current);

      cacheReviewDraft(cache, userId, goal.id, {
        ...reviewDraft,
        body: "遅延した保存結果",
        revision,
      });

      expect(cache.getQueryData(userQueryKeys.review(userId, goal.id))).toBe(
        current,
      );
    },
  );

  it("rejects a mutation result for an old review draft generation", () => {
    const cache = new QueryClient();
    cacheReview(cache, userId, goalReview);

    cacheReviewDraft(cache, userId, goal.id, {
      ...reviewDraft,
      id: "10000000-0000-7000-8000-000000000003",
      body: "旧Review世代への保存結果",
      revision: 99,
    });

    expect(cache.getQueryData(userQueryKeys.review(userId, goal.id))).toBe(
      goalReview,
    );
  });

  it("does not create or cross-publish a review for mismatched Goal identity", () => {
    const cache = new QueryClient();
    const otherGoalId = "20000000-0000-7000-8000-000000000002";

    cacheReviewDraft(cache, userId, goal.id, reviewDraft);
    expect(
      cache.getQueryData(userQueryKeys.review(userId, goal.id)),
    ).toBeUndefined();

    cacheReview(cache, userId, goalReview);
    cacheReviewDraft(cache, userId, goal.id, {
      ...reviewDraft,
      goalId: otherGoalId,
      revision: 1,
    });
    expect(cache.getQueryData(userQueryKeys.review(userId, goal.id))).toBe(
      goalReview,
    );

    cache.setQueryData(userQueryKeys.review(userId, otherGoalId), goalReview);
    cacheReviewDraft(cache, userId, otherGoalId, {
      ...reviewDraft,
      goalId: otherGoalId,
      revision: 1,
    });
    expect(cache.getQueryData(userQueryKeys.review(userId, otherGoalId))).toBe(
      goalReview,
    );
  });

  it("invalidates only queries under the captured user root", async () => {
    const cache = new QueryClient();
    cache.setQueryData(userQueryKeys.home(userId), { owner: userId });
    cache.setQueryData(userQueryKeys.home(otherUserId), {
      owner: otherUserId,
    });

    await cache.invalidateQueries({
      queryKey: userQueryKeys.root(userId),
      refetchType: "none",
    });

    expect(cache.getQueryState(userQueryKeys.home(userId))?.isInvalidated).toBe(
      true,
    );
    expect(
      cache.getQueryState(userQueryKeys.home(otherUserId))?.isInvalidated,
    ).toBe(false);
  });
});
