import {
  cycleSchema,
  draftSchema,
  goalVersionSchema,
  reviewSchema,
  saveFrameSchema,
  type GoalReview,
} from "./schemas";

const reviewGoalId = "20000000-0000-7000-8000-000000000001";
const reviewVersionId = "30000000-0000-7000-8000-000000000001";
const reviewCycleId = "40000000-0000-7000-8000-000000000001";
const reviewDraftId = "50000000-0000-7000-8000-000000000001";
const otherId = "90000000-0000-7000-8000-000000000009";

const reviewFixture = (): GoalReview => ({
  goal: {
    id: reviewGoalId,
    status: "goal_review",
    revision: 4,
    currentVersion: {
      id: reviewVersionId,
      versionNumber: 2,
      body: "現在の目標",
      createdAt: "2026-08-19T00:00:00Z",
    },
    currentWork: {
      kind: "goal_review",
      reviewDraftId,
      triggerCycleId: reviewCycleId,
      triggerCycleSequenceNumber: 3,
    },
    nextCycleSequenceNumber: 4,
    cycleCount: 3,
    createdAt: "2026-08-18T00:00:00Z",
    terminalAt: null,
  },
  reviewDraft: {
    id: reviewDraftId,
    draftType: "review",
    goalId: reviewGoalId,
    baseGoalVersionId: reviewVersionId,
    reviewCycleId,
    body: "次のCycleで試す目標",
    revision: 2,
    updatedAt: "2026-08-20T00:02:00Z",
  },
  triggerCycle: {
    id: reviewCycleId,
    goalId: reviewGoalId,
    sequenceNumber: 3,
    status: "completed",
    goalVersion: {
      id: reviewVersionId,
      versionNumber: 2,
      body: "現在の目標",
      createdAt: "2026-08-19T00:00:00Z",
    },
    startedAt: "2026-08-19T00:00:00Z",
    completedAt: "2026-08-20T00:00:00Z",
    canceledAt: null,
    cancellationReason: null,
    plan: "計画",
    do: "実行",
    check: "評価",
    action: "改善",
    contentRevision: 4,
    frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
  },
});

const currentReviewWork = (review: GoalReview) => {
  const currentWork = review.goal.currentWork;
  if (currentWork?.kind !== "goal_review")
    throw new Error("test fixture is not in Goal Review");
  return currentWork;
};

type InvalidReviewCase = {
  readonly label: string;
  readonly expectedPath: readonly PropertyKey[];
  readonly mutate: (review: GoalReview) => void;
};

const invalidReviewCases: readonly InvalidReviewCase[] = [
  {
    label: "a non-review Goal status",
    expectedPath: ["goal", "status"],
    mutate: (review) => {
      review.goal.status = "active_cycle";
    },
  },
  {
    label: "a missing current Review workspace",
    expectedPath: ["goal", "currentWork"],
    mutate: (review) => {
      review.goal.currentWork = null;
    },
  },
  {
    label: "an active Cycle current workspace",
    expectedPath: ["goal", "currentWork"],
    mutate: (review) => {
      review.goal.currentWork = {
        kind: "active_cycle",
        cycleId: otherId,
        cycleSequenceNumber: review.triggerCycle.sequenceNumber,
      };
    },
  },
  {
    label: "a terminal Review Goal",
    expectedPath: ["goal", "terminalAt"],
    mutate: (review) => {
      review.goal.terminalAt = "2026-08-20T00:03:00Z";
    },
  },
  {
    label: "a different current Review Draft",
    expectedPath: ["goal", "currentWork", "reviewDraftId"],
    mutate: (review) => {
      currentReviewWork(review).reviewDraftId = otherId;
    },
  },
  {
    label: "a different current Trigger Cycle",
    expectedPath: ["goal", "currentWork", "triggerCycleId"],
    mutate: (review) => {
      currentReviewWork(review).triggerCycleId = otherId;
    },
  },
  {
    label: "a different current Trigger Cycle sequence",
    expectedPath: ["goal", "currentWork", "triggerCycleSequenceNumber"],
    mutate: (review) => {
      currentReviewWork(review).triggerCycleSequenceNumber += 1;
    },
  },
  {
    label: "a noncontiguous next Cycle sequence",
    expectedPath: ["goal", "nextCycleSequenceNumber"],
    mutate: (review) => {
      review.goal.nextCycleSequenceNumber += 1;
    },
  },
  {
    label: "a Creation Draft",
    expectedPath: ["reviewDraft", "draftType"],
    mutate: (review) => {
      review.reviewDraft.draftType = "creation";
    },
  },
  {
    label: "a missing Draft Goal",
    expectedPath: ["reviewDraft", "goalId"],
    mutate: (review) => {
      delete review.reviewDraft.goalId;
    },
  },
  {
    label: "a different Draft Goal",
    expectedPath: ["reviewDraft", "goalId"],
    mutate: (review) => {
      review.reviewDraft.goalId = otherId;
    },
  },
  {
    label: "a missing Draft base Goal Version",
    expectedPath: ["reviewDraft", "baseGoalVersionId"],
    mutate: (review) => {
      delete review.reviewDraft.baseGoalVersionId;
    },
  },
  {
    label: "a different Draft base Goal Version",
    expectedPath: ["reviewDraft", "baseGoalVersionId"],
    mutate: (review) => {
      review.reviewDraft.baseGoalVersionId = otherId;
    },
  },
  {
    label: "a missing Draft Review Cycle",
    expectedPath: ["reviewDraft", "reviewCycleId"],
    mutate: (review) => {
      delete review.reviewDraft.reviewCycleId;
    },
  },
  {
    label: "a different Draft Review Cycle",
    expectedPath: ["reviewDraft", "reviewCycleId"],
    mutate: (review) => {
      review.reviewDraft.reviewCycleId = otherId;
    },
  },
  {
    label: "a missing Trigger Cycle Goal",
    expectedPath: ["triggerCycle", "goalId"],
    mutate: (review) => {
      delete review.triggerCycle.goalId;
    },
  },
  {
    label: "a different Trigger Cycle Goal",
    expectedPath: ["triggerCycle", "goalId"],
    mutate: (review) => {
      review.triggerCycle.goalId = otherId;
    },
  },
  ...(["active", "canceled"] as const).map(
    (status): InvalidReviewCase => ({
      label: `a ${status} Trigger Cycle`,
      expectedPath: ["triggerCycle", "status"],
      mutate: (review) => {
        review.triggerCycle.status = status;
      },
    }),
  ),
  {
    label: "a different Trigger Cycle Goal Version",
    expectedPath: ["triggerCycle", "goalVersion", "id"],
    mutate: (review) => {
      review.triggerCycle.goalVersion.id = otherId;
    },
  },
  {
    label: "a Trigger Cycle without a completion timestamp",
    expectedPath: ["triggerCycle", "completedAt"],
    mutate: (review) => {
      review.triggerCycle.completedAt = null;
    },
  },
  {
    label: "a Trigger Cycle with a cancellation timestamp",
    expectedPath: ["triggerCycle", "canceledAt"],
    mutate: (review) => {
      review.triggerCycle.canceledAt = "2026-08-20T00:00:00Z";
    },
  },
  {
    label: "a Trigger Cycle with a cancellation reason",
    expectedPath: ["triggerCycle", "cancellationReason"],
    mutate: (review) => {
      review.triggerCycle.cancellationReason = "goal_ended";
    },
  },
];

describe("text response schemas", () => {
  it("accepts 80 Goal code points, rejects 81/NUL, and normalizes line endings", () => {
    for (const schema of [
      draftSchema.shape.body,
      goalVersionSchema.shape.body,
    ]) {
      const maximum = "😀".repeat(80);
      expect(schema.safeParse(maximum).success).toBe(true);
      expect(schema.safeParse(`${maximum}😀`).success).toBe(false);
      expect(schema.safeParse("goal\0text").success).toBe(false);
      expect(schema.parse(" goal\r\ntext\r ")).toBe(" goal\ntext\n ");
    }
  });

  it("accepts 200 Frame code points, rejects 201/NUL, and normalizes line endings", () => {
    for (const schema of [
      cycleSchema.shape.plan,
      saveFrameSchema.shape.content,
    ]) {
      const maximum = "😀".repeat(200);
      expect(schema.safeParse(maximum).success).toBe(true);
      expect(schema.safeParse(`${maximum}😀`).success).toBe(false);
      expect(schema.safeParse("frame\0text").success).toBe(false);
      expect(schema.parse(" frame\r\ntext\r ")).toBe(" frame\ntext\n ");
    }
  });
});

describe("Goal Review response schema", () => {
  it("accepts one coherent Review snapshot after the Draft has changed", () => {
    const review = reviewFixture();

    expect(reviewSchema.parse(review)).toEqual(review);
  });

  it.each(invalidReviewCases)("rejects $label", ({ expectedPath, mutate }) => {
    const review = reviewFixture();
    mutate(review);

    const result = reviewSchema.safeParse(review);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path }) => path)).toContainEqual([
        ...expectedPath,
      ]);
    }
  });
});
