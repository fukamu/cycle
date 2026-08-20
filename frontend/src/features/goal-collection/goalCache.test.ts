import { QueryClient } from "@tanstack/react-query";

import type { Cycle, Goal, GoalDraft, Home } from "../../shared/api/schemas";
import {
  cacheCreationDraft,
  cacheCycle,
  cycleQueryKey,
  goalQueryKey,
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
});
