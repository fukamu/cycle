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
  publishGoalReview,
  removeGoalFromCache,
  resolveGoalReviewPublication,
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

function reviewGeneration({
  goalRevision,
  draftId,
  draftRevision,
  cycleId,
  cycleSequenceNumber,
}: {
  readonly goalRevision: number;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly cycleId: string;
  readonly cycleSequenceNumber: number;
}): GoalReview {
  const triggerCycle: Cycle = {
    ...cycle,
    id: cycleId,
    sequenceNumber: cycleSequenceNumber,
    status: "completed",
    completedAt: "2026-08-20T01:00:00.000Z",
  };
  const generationDraft: GoalDraft = {
    ...reviewDraft,
    id: draftId,
    reviewCycleId: cycleId,
    revision: draftRevision,
  };
  return {
    goal: {
      ...goal,
      status: "goal_review",
      revision: goalRevision,
      currentWork: {
        kind: "goal_review",
        reviewDraftId: draftId,
        triggerCycleId: cycleId,
        triggerCycleSequenceNumber: cycleSequenceNumber,
      },
      nextCycleSequenceNumber: cycleSequenceNumber + 1,
      cycleCount: cycleSequenceNumber,
    },
    reviewDraft: generationDraft,
    triggerCycle,
  };
}

const editableGoalReview = reviewGeneration({
  goalRevision: 1,
  draftId: reviewDraft.id,
  draftRevision: reviewDraft.revision,
  cycleId: cycle.id,
  cycleSequenceNumber: cycle.sequenceNumber,
});

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
    expect(userQueryKeys.reviewTransport(userId, goal.id, "entry-1")).toEqual([
      "user",
      userId,
      "goal-review",
      goal.id,
      "transport",
      "entry-1",
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

  describe("Goal Review publication resolution", () => {
    const reviewA = reviewGeneration({
      goalRevision: 1,
      draftId: "10000000-0000-7000-8000-000000000011",
      draftRevision: 2,
      cycleId: "40000000-0000-7000-8000-000000000011",
      cycleSequenceNumber: 1,
    });
    const reviewB = reviewGeneration({
      goalRevision: 3,
      draftId: "10000000-0000-7000-8000-000000000012",
      draftRevision: 0,
      cycleId: "40000000-0000-7000-8000-000000000012",
      cycleSequenceNumber: 2,
    });
    const reviewAWork = reviewA.goal.currentWork;
    if (reviewAWork?.kind !== "goal_review")
      throw new Error("Review A fixture must own a Review workspace");

    it("accepts the incoming whole snapshot when no cache has been published", () => {
      expect(
        resolveGoalReviewPublication({
          canonicalGoal: undefined,
          currentReview: undefined,
          incoming: reviewA,
        }),
      ).toEqual({ kind: "accept", snapshot: reviewA });
    });

    it.each([
      { label: "older", revision: 1 },
      { label: "equal", revision: 2 },
    ])(
      "preserves the exact current snapshot for a $label same-Draft payload",
      ({ revision }) => {
        const incoming: GoalReview = {
          ...reviewA,
          reviewDraft: {
            ...reviewA.reviewDraft,
            body: "遅延した同一Draft payload",
            revision,
          },
        };

        expect(
          resolveGoalReviewPublication({
            canonicalGoal: reviewA.goal,
            currentReview: reviewA,
            incoming,
          }),
        ).toEqual({ kind: "preserve-current", snapshot: reviewA });
      },
    );

    it("accepts a strictly newer same-Draft payload as one whole snapshot", () => {
      const incoming: GoalReview = {
        ...reviewA,
        goal: {
          ...reviewA.goal,
          currentVersion: {
            ...reviewA.goal.currentVersion,
            body: "incoming snapshotのGoal",
          },
        },
        reviewDraft: {
          ...reviewA.reviewDraft,
          body: "incoming snapshotのDraft",
          revision: 3,
        },
        triggerCycle: {
          ...reviewA.triggerCycle,
          plan: "incoming snapshotのCycle",
        },
      };

      expect(
        resolveGoalReviewPublication({
          canonicalGoal: reviewA.goal,
          currentReview: reviewA,
          incoming,
        }),
      ).toEqual({ kind: "accept", snapshot: incoming });
    });

    it("preserves a newer Review generation without comparing Draft revisions", () => {
      const lateReviewA: GoalReview = {
        ...reviewA,
        reviewDraft: { ...reviewA.reviewDraft, revision: 99 },
      };

      expect(
        resolveGoalReviewPublication({
          canonicalGoal: undefined,
          currentReview: reviewB,
          incoming: lateReviewA,
        }),
      ).toEqual({ kind: "preserve-current", snapshot: reviewB });
    });

    it("accepts a newer valid Review generation without comparing Draft revisions", () => {
      const currentReviewA: GoalReview = {
        ...reviewA,
        reviewDraft: { ...reviewA.reviewDraft, revision: 99 },
      };

      expect(
        resolveGoalReviewPublication({
          canonicalGoal: reviewA.goal,
          currentReview: currentReviewA,
          incoming: reviewB,
        }),
      ).toEqual({ kind: "accept", snapshot: reviewB });
    });

    it("fails closed for different Draft IDs at the same Goal revision", () => {
      const conflicting = reviewGeneration({
        goalRevision: reviewA.goal.revision,
        draftId: reviewB.reviewDraft.id,
        draftRevision: 0,
        cycleId: reviewB.triggerCycle.id,
        cycleSequenceNumber: reviewB.triggerCycle.sequenceNumber,
      });

      expect(
        resolveGoalReviewPublication({
          canonicalGoal: undefined,
          currentReview: reviewA,
          incoming: conflicting,
        }),
      ).toEqual({ kind: "invariant" });
    });

    it.each(["active_cycle", "achieved", "ended"] as const)(
      "reports a same-revision %s canonical Goal as a moved workspace",
      (status) => {
        const canonicalGoal: Goal = {
          ...reviewA.goal,
          status,
          currentWork:
            status === "active_cycle"
              ? {
                  kind: "active_cycle",
                  cycleId: "40000000-0000-7000-8000-000000000099",
                  cycleSequenceNumber: 2,
                }
              : null,
          terminalAt:
            status === "active_cycle" ? null : "2026-08-20T02:00:00.000Z",
        };

        expect(
          resolveGoalReviewPublication({
            canonicalGoal,
            currentReview: reviewA,
            incoming: reviewA,
          }),
        ).toEqual({ kind: "workspace-moved", goal: canonicalGoal });
      },
    );

    it("reports any newer canonical Goal as a moved workspace", () => {
      expect(
        resolveGoalReviewPublication({
          canonicalGoal: reviewB.goal,
          currentReview: reviewA,
          incoming: reviewA,
        }),
      ).toEqual({ kind: "workspace-moved", goal: reviewB.goal });
    });

    it("reports a newer Active Cycle as a moved workspace", () => {
      const activeGoal: Goal = {
        ...reviewA.goal,
        status: "active_cycle",
        revision: reviewA.goal.revision + 1,
        currentWork: {
          kind: "active_cycle",
          cycleId: "40000000-0000-7000-8000-000000000099",
          cycleSequenceNumber: 2,
        },
      };

      expect(
        resolveGoalReviewPublication({
          canonicalGoal: activeGoal,
          currentReview: reviewA,
          incoming: reviewA,
        }),
      ).toEqual({ kind: "workspace-moved", goal: activeGoal });
    });

    it.each(["achieved", "ended"] as const)(
      "never accepts a Review newer than an irreversible %s Goal",
      (status) => {
        const terminalGoal: Goal = {
          ...reviewA.goal,
          status,
          currentWork: null,
          terminalAt: "2026-08-20T02:00:00.000Z",
        };

        expect(
          resolveGoalReviewPublication({
            canonicalGoal: terminalGoal,
            currentReview: reviewA,
            incoming: reviewB,
          }),
        ).toEqual({ kind: "workspace-moved", goal: terminalGoal });
      },
    );

    it("preserves a live Review matching the newer canonical workspace", () => {
      expect(
        resolveGoalReviewPublication({
          canonicalGoal: reviewB.goal,
          currentReview: reviewB,
          incoming: reviewA,
        }),
      ).toEqual({ kind: "preserve-current", snapshot: reviewB });
    });

    it.each([
      {
        label: "Draft",
        currentWork: {
          ...reviewAWork,
          reviewDraftId: reviewB.reviewDraft.id,
        },
      },
      {
        label: "trigger Cycle",
        currentWork: {
          ...reviewAWork,
          triggerCycleId: reviewB.triggerCycle.id,
        },
      },
      {
        label: "trigger Cycle sequence",
        currentWork: {
          ...reviewAWork,
          triggerCycleSequenceNumber: reviewB.triggerCycle.sequenceNumber,
        },
      },
    ])(
      "fails closed when the same-revision canonical $label differs",
      ({ currentWork }) => {
        const canonicalGoal: Goal = { ...reviewA.goal, currentWork };

        expect(
          resolveGoalReviewPublication({
            canonicalGoal,
            currentReview: undefined,
            incoming: reviewA,
          }),
        ).toEqual({ kind: "invariant" });
      },
    );

    it("fails closed instead of crossing Goal identities", () => {
      const canonicalGoal: Goal = {
        ...reviewA.goal,
        id: "20000000-0000-7000-8000-000000000099",
      };

      expect(
        resolveGoalReviewPublication({
          canonicalGoal,
          currentReview: reviewA,
          incoming: reviewA,
        }),
      ).toEqual({ kind: "invariant" });
    });

    it("publishes only an accepted whole snapshot", () => {
      const cache = new QueryClient();
      const goalKey = userQueryKeys.goal(userId, reviewA.goal.id);
      const reviewKey = userQueryKeys.review(userId, reviewA.goal.id);

      expect(publishGoalReview(cache, userId, reviewA)).toEqual({
        kind: "accept",
        snapshot: reviewA,
      });
      expect(
        cache.getQueryData<{ readonly goal: Goal }>(goalKey)?.goal,
      ).toEqual(reviewA.goal);
      expect(cache.getQueryData(reviewKey)).toEqual(reviewA);

      expect(publishGoalReview(cache, userId, reviewB)).toEqual({
        kind: "accept",
        snapshot: reviewB,
      });
      expect(
        cache.getQueryData<{ readonly goal: Goal }>(goalKey)?.goal,
      ).toEqual(reviewB.goal);
      expect(cache.getQueryData(reviewKey)).toEqual(reviewB);
    });

    it("keeps every cache signal unchanged when Review A arrives after Review B", () => {
      const cache = new QueryClient();
      const goalKey = userQueryKeys.goal(userId, reviewA.goal.id);
      const reviewKey = userQueryKeys.review(userId, reviewA.goal.id);
      publishGoalReview(cache, userId, reviewA);
      publishGoalReview(cache, userId, reviewB);

      const goalBefore = cache.getQueryData(goalKey);
      const reviewBefore = cache.getQueryData(reviewKey);
      const goalStateBefore = cache.getQueryState(goalKey);
      const reviewStateBefore = cache.getQueryState(reviewKey);
      if (goalStateBefore === undefined || reviewStateBefore === undefined)
        throw new Error(
          "Review B fixture must be published before late Review A",
        );

      const resolution = publishGoalReview(cache, userId, reviewA);
      expect(resolution.kind).toBe("preserve-current");
      if (resolution.kind !== "preserve-current")
        throw new Error("late Review A must preserve Review B");
      expect(resolution.snapshot).toBe(reviewBefore);

      expect(cache.getQueryData(goalKey)).toBe(goalBefore);
      expect(cache.getQueryData(reviewKey)).toBe(reviewBefore);
      expect(cache.getQueryState(goalKey)).toBe(goalStateBefore);
      expect(cache.getQueryState(reviewKey)).toBe(reviewStateBefore);
      expect(cache.getQueryState(goalKey)?.dataUpdatedAt).toBe(
        goalStateBefore.dataUpdatedAt,
      );
      expect(cache.getQueryState(goalKey)?.dataUpdateCount).toBe(
        goalStateBefore.dataUpdateCount,
      );
      expect(cache.getQueryState(reviewKey)?.dataUpdatedAt).toBe(
        reviewStateBefore.dataUpdatedAt,
      );
      expect(cache.getQueryState(reviewKey)?.dataUpdateCount).toBe(
        reviewStateBefore.dataUpdateCount,
      );
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
    cacheReview(cache, userId, editableGoalReview);
    const saved = { ...reviewDraft, body: "保存後の目標", revision: 1 };

    cacheReviewDraft(cache, userId, goal.id, saved);

    const cached = cache.getQueryData<GoalReview>(
      userQueryKeys.review(userId, goal.id),
    );
    expect(cached).not.toBe(editableGoalReview);
    expect(cached?.reviewDraft).toEqual(saved);
    expect(cached).toEqual({ ...editableGoalReview, reviewDraft: saved });
  });

  it.each([
    { label: "older", revision: 1 },
    { label: "equal", revision: 2 },
  ])(
    "keeps the exact cached review for a $label draft mutation result",
    ({ revision }) => {
      const cache = new QueryClient();
      const current: GoalReview = {
        ...editableGoalReview,
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
    cacheReview(cache, userId, editableGoalReview);

    cacheReviewDraft(cache, userId, goal.id, {
      ...reviewDraft,
      id: "10000000-0000-7000-8000-000000000003",
      body: "旧Review世代への保存結果",
      revision: 99,
    });

    expect(cache.getQueryData(userQueryKeys.review(userId, goal.id))).toBe(
      editableGoalReview,
    );
  });

  it.each([
    {
      status: "active_cycle",
      currentWork: {
        kind: "active_cycle",
        cycleId: "40000000-0000-7000-8000-000000000099",
        cycleSequenceNumber: 2,
      },
      terminalAt: null,
    },
    {
      status: "achieved",
      currentWork: null,
      terminalAt: "2026-08-20T02:00:00.000Z",
    },
    {
      status: "ended",
      currentWork: null,
      terminalAt: "2026-08-20T02:00:00.000Z",
    },
  ] as const)(
    "does not freshen a Review Draft after its Goal becomes $status",
    ({ status, currentWork, terminalAt }) => {
      const cache = new QueryClient();
      const reviewKey = userQueryKeys.review(userId, goal.id);
      cacheReview(cache, userId, editableGoalReview);
      cacheGoal(cache, userId, {
        ...editableGoalReview.goal,
        status,
        revision: editableGoalReview.goal.revision + 1,
        currentWork,
        terminalAt,
      });
      const reviewBefore = cache.getQueryData(reviewKey);
      const stateBefore = cache.getQueryState(reviewKey);

      cacheReviewDraft(cache, userId, goal.id, {
        ...editableGoalReview.reviewDraft,
        body: "Goal遷移後に届いた保存結果",
        revision: editableGoalReview.reviewDraft.revision + 1,
      });

      expect(cache.getQueryData(reviewKey)).toBe(reviewBefore);
      expect(cache.getQueryState(reviewKey)).toBe(stateBefore);
    },
  );

  it("does not create or cross-publish a review for mismatched Goal identity", () => {
    const cache = new QueryClient();
    const otherGoalId = "20000000-0000-7000-8000-000000000002";

    cacheReviewDraft(cache, userId, goal.id, reviewDraft);
    expect(
      cache.getQueryData(userQueryKeys.review(userId, goal.id)),
    ).toBeUndefined();

    cacheReview(cache, userId, editableGoalReview);
    cacheReviewDraft(cache, userId, goal.id, {
      ...reviewDraft,
      goalId: otherGoalId,
      revision: 1,
    });
    expect(cache.getQueryData(userQueryKeys.review(userId, goal.id))).toBe(
      editableGoalReview,
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
