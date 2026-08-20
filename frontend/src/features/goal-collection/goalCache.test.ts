import { QueryClient } from "@tanstack/react-query";

import type { Cycle, Goal, GoalDraft, Home } from "../../shared/api/schemas";
import {
  cacheCreationDraft,
  cacheCycle,
  cacheCycleFrame,
  cacheReview,
  cacheReviewDraft,
  cycleQueryKey,
  goalQueryKey,
  reviewQueryKey,
} from "./goalCache";

const goal: Goal = {
  id: "20000000-0000-0000-0000-000000000001",
  status: "active_cycle",
  revision: 0,
  currentVersion: {
    id: "30000000-0000-0000-0000-000000000001",
    versionNumber: 1,
    body: "目標",
    createdAt: "2026-08-20T00:00:00.000Z",
  },
  currentWork: {
    kind: "active_cycle",
    cycleId: "40000000-0000-0000-0000-000000000001",
    cycleSequenceNumber: 1,
  },
  nextCycleSequenceNumber: 2,
  cycleCount: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  terminalAt: null,
};

const cycle: Cycle = {
  id: "40000000-0000-0000-0000-000000000001",
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
  id: "10000000-0000-0000-0000-000000000001",
  draftType: "creation",
  body: "",
  revision: 0,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const reviewDraft: GoalDraft = {
  ...draft,
  id: "10000000-0000-0000-0000-000000000002",
  draftType: "review",
  goalId: goal.id,
  baseGoalVersionId: goal.currentVersion.id,
  reviewCycleId: cycle.id,
  body: "目標",
};

describe("goal cache", () => {
  it("primes goal and cycle details from a transition response", () => {
    const cache = new QueryClient();

    cacheCycle(cache, goal, cycle);

    expect(cache.getQueryData(goalQueryKey(goal.id))).toEqual({ goal });
    expect(cache.getQueryData(cycleQueryKey(goal.id, cycle.id))).toEqual({
      cycle,
    });
  });

  it("adds a created draft to an existing home response", () => {
    const cache = new QueryClient();
    const home: Home = {
      progressingGoals: [],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 3,
      canStartProgressingGoal: true,
    };
    cache.setQueryData(["home"], home);

    cacheCreationDraft(cache, draft);

    expect(cache.getQueryData<Home>(["home"])).toEqual({
      ...home,
      creationDraft: draft,
      canCreateGoalDraft: false,
    });
  });

  it("keeps a saved frame in the canonical cycle detail", () => {
    const cache = new QueryClient();
    cacheCycle(cache, goal, cycle);

    cacheCycleFrame(cache, goal.id, {
      cycleId: cycle.id,
      frame: "plan",
      content: "保存後のP",
      frameRevision: 1,
      contentRevision: 1,
    });

    expect(
      cache.getQueryData<{ cycle: Cycle }>(cycleQueryKey(goal.id, cycle.id))
        ?.cycle,
    ).toEqual({
      ...cycle,
      plan: "保存後のP",
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    });
  });

  it("does not let an older frame response regress canonical state", () => {
    const cache = new QueryClient();
    cacheCycle(cache, goal, {
      ...cycle,
      plan: "newer",
      contentRevision: 3,
      frameRevisions: { ...cycle.frameRevisions, plan: 2 },
    });

    cacheCycleFrame(cache, goal.id, {
      cycleId: cycle.id,
      frame: "plan",
      content: "older",
      frameRevision: 1,
      contentRevision: 2,
    });

    expect(
      cache.getQueryData<{ cycle: Cycle }>(cycleQueryKey(goal.id, cycle.id))
        ?.cycle,
    ).toMatchObject({
      plan: "newer",
      contentRevision: 3,
      frameRevisions: { plan: 2 },
    });
  });

  it("keeps a saved review draft in the canonical review detail", () => {
    const cache = new QueryClient();
    cacheReview(cache, { goal, reviewDraft, triggerCycle: cycle });
    const saved = { ...reviewDraft, body: "保存後の目標", revision: 1 };

    cacheReviewDraft(cache, goal.id, saved);

    expect(cache.getQueryData(reviewQueryKey(goal.id))).toEqual({
      goal,
      reviewDraft: saved,
      triggerCycle: cycle,
    });
  });
});
