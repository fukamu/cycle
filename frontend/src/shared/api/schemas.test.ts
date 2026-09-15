import {
  cycleSchema,
  currentWorkSchema,
  draftSchema,
  goalVersionSchema,
  reviewSchema,
  reviewDateSchema,
  reviewScheduleSchema,
  saveFrameSchema,
  sessionSchema,
  type GoalReview,
} from "./schemas";

const reviewGoalId = "20000000-0000-7000-8000-000000000001";
const reviewVersionId = "30000000-0000-7000-8000-000000000001";
const reviewCycleId = "40000000-0000-7000-8000-000000000001";
const reviewDraftId = "50000000-0000-7000-8000-000000000001";
const otherId = "90000000-0000-7000-8000-000000000009";

const sessionFixture = (csrfToken: string) => ({
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken,
});

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
    previousCompletedCycleAction: null,
    reviewDate: null,
    reviewScheduleRevision: 0,
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
        reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
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

describe("Cycle previous completed Action schema", () => {
  const currentCycleId = "40000000-0000-7000-8000-000000000003";
  const previousCycleId = "40000000-0000-7000-8000-000000000002";
  const activeCycle = () => ({
    id: currentCycleId,
    goalId: reviewGoalId,
    sequenceNumber: 3,
    status: "active" as const,
    goalVersion: {
      id: reviewVersionId,
      versionNumber: 2,
      body: "現在の目標",
      createdAt: "2026-08-20T00:00:00Z",
    },
    previousCompletedCycleAction: {
      cycleId: previousCycleId,
      cycleSequenceNumber: 2,
      goalVersionNumber: 1,
      action: "前回の改善\r\n次の一歩",
    },
    reviewDate: null,
    reviewScheduleRevision: 0,
    startedAt: "2026-08-20T00:00:00Z",
    completedAt: null,
    canceledAt: null,
    cancellationReason: null,
    plan: "",
    do: "",
    check: "",
    action: "",
    contentRevision: 0,
    frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
  });

  it.each([
    ["the immediately previous Goal Version", 1],
    ["the same Goal Version", 2],
  ])("accepts %s", (_label, goalVersionNumber) => {
    const candidate = activeCycle();
    candidate.previousCompletedCycleAction.goalVersionNumber =
      goalVersionNumber;

    const parsed = cycleSchema.parse(candidate);

    expect(parsed.previousCompletedCycleAction?.action).toBe(
      "前回の改善\n次の一歩",
    );
  });

  it.each([
    {
      label: "a missing required field",
      mutate: (candidate: Record<string, unknown>) => {
        delete candidate.previousCompletedCycleAction;
      },
    },
    {
      label: "a null predecessor on Cycle 2 or later",
      mutate: (candidate: Record<string, unknown>) => {
        candidate.previousCompletedCycleAction = null;
      },
    },
    {
      label: "the current Cycle identity",
      mutate: (candidate: ReturnType<typeof activeCycle>) => {
        candidate.previousCompletedCycleAction.cycleId = currentCycleId;
      },
    },
    {
      label: "a non-v7 Cycle identity",
      mutate: (candidate: ReturnType<typeof activeCycle>) => {
        candidate.previousCompletedCycleAction.cycleId = "not-a-uuid";
      },
    },
    {
      label: "a non-direct sequence",
      mutate: (candidate: ReturnType<typeof activeCycle>) => {
        candidate.previousCompletedCycleAction.cycleSequenceNumber = 1;
      },
    },
    {
      label: "a future Goal Version",
      mutate: (candidate: ReturnType<typeof activeCycle>) => {
        candidate.previousCompletedCycleAction.goalVersionNumber = 3;
      },
    },
    {
      label: "a Goal Version more than one behind",
      mutate: (candidate: ReturnType<typeof activeCycle>) => {
        candidate.goalVersion.versionNumber = 3;
      },
    },
    {
      label: "a blank Action",
      mutate: (candidate: ReturnType<typeof activeCycle>) => {
        candidate.previousCompletedCycleAction.action = " \n\t";
      },
    },
    {
      label: "an oversized Action",
      mutate: (candidate: ReturnType<typeof activeCycle>) => {
        candidate.previousCompletedCycleAction.action = "😀".repeat(201);
      },
    },
  ])("rejects $label", ({ mutate }) => {
    const candidate = activeCycle();
    mutate(candidate);

    expect(cycleSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ["Cycle 1", { sequenceNumber: 1, status: "active" }],
    [
      "a completed Cycle",
      {
        sequenceNumber: 3,
        status: "completed",
        completedAt: "2026-08-21T00:00:00Z",
      },
    ],
    [
      "a canceled Cycle",
      {
        sequenceNumber: 3,
        status: "canceled",
        canceledAt: "2026-08-21T00:00:00Z",
        cancellationReason: "goal_ended",
      },
    ],
  ])("requires null for %s", (_label, overrides) => {
    const candidate = { ...activeCycle(), ...overrides };

    expect(cycleSchema.safeParse(candidate).success).toBe(false);
    expect(
      cycleSchema.safeParse({
        ...candidate,
        previousCompletedCycleAction: null,
      }).success,
    ).toBe(true);
  });

  it.each(["reviewDate", "reviewScheduleRevision"] as const)(
    "rejects a full Cycle missing required %s",
    (field) => {
      const candidate: Record<string, unknown> = activeCycle();
      delete candidate[field];

      const parsed = cycleSchema.safeParse(candidate);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: [field] })]),
        );
    },
  );
});

describe("Review schedule schemas", () => {
  it.each(["0001-01-01", "2000-02-29", "9999-12-31"])(
    "accepts the canonical Gregorian date %s",
    (reviewDate) => {
      expect(reviewDateSchema.parse(reviewDate)).toBe(reviewDate);
      expect(
        reviewScheduleSchema.parse({
          reviewDate,
          reviewScheduleRevision: 1,
        }),
      ).toEqual({ reviewDate, reviewScheduleRevision: 1 });
    },
  );

  it.each([
    "0000-01-01",
    "10000-01-01",
    "2026-02-29",
    "2026-9-15",
    "2026-09-15T00:00:00Z",
  ])("rejects the invalid or non-canonical date %s", (reviewDate) => {
    expect(reviewDateSchema.safeParse(reviewDate).success).toBe(false);
  });

  it("requires a positive revision for a configured date but retains revision after clear", () => {
    expect(
      reviewScheduleSchema.safeParse({
        reviewDate: "2026-09-15",
        reviewScheduleRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      reviewScheduleSchema.parse({
        reviewDate: null,
        reviewScheduleRevision: 4,
      }),
    ).toEqual({ reviewDate: null, reviewScheduleRevision: 4 });
  });

  it("requires the schedule only on an active Cycle workspace", () => {
    const active = {
      kind: "active_cycle",
      cycleId: reviewCycleId,
      cycleSequenceNumber: 3,
    };
    expect(currentWorkSchema.safeParse(active).success).toBe(false);
    expect(
      currentWorkSchema.safeParse({
        ...active,
        reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
      }).success,
    ).toBe(true);
    expect(
      currentWorkSchema.safeParse({
        kind: "goal_review",
        reviewDraftId,
        triggerCycleId: reviewCycleId,
        triggerCycleSequenceNumber: 3,
        reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("Session response schema", () => {
  it.each([
    ["stable derived", "A".repeat(43)],
    ["legacy random", "Q".repeat(43)],
  ])("accepts a canonical %s CSRF token", (name, csrfToken) => {
    expect(
      sessionSchema.safeParse(sessionFixture(csrfToken)).success,
      `${name} fixture must satisfy the Session parser without exposing its value`,
    ).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["short", "A".repeat(42)],
    ["long", "A".repeat(44)],
    ["padded", `${"A".repeat(43)}=`],
    ["non-base64url", `${"A".repeat(42)}+`],
    ["noncanonical", `${"A".repeat(42)}B`],
  ])("rejects a %s CSRF token at the parser boundary", (name, csrfToken) => {
    expect(
      sessionSchema.safeParse(sessionFixture(csrfToken)).success,
      `${name} fixture must be rejected without exposing its value`,
    ).toBe(false);
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
