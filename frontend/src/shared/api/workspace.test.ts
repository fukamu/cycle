import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import type { AuthenticatedRequestLease } from "./client";
import { reviewSchema } from "./schemas";
import {
  adoptReview,
  completeCycle,
  continueReview,
  deleteGoal,
  generateAction,
  getCycle,
  getGoal,
  getGoalDraft,
  getHome,
  getReview,
  listCycles,
  replanCycle,
  refineAction,
  refineGoalDraft,
  refineReview,
  changeReviewSchedule,
  saveGoalDraft,
  saveReview,
  saveCycleFrame,
  startGoal,
  terminateGoal,
} from "./workspace";

const goalId = "00000000-0000-7000-8000-000000000001";
const reviewDraftId = "00000000-0000-7000-8000-000000000004";
const cycleId = "00000000-0000-7000-8000-000000000002";
const suppliedOperationId = "00000000-0000-7000-8000-000000000003";
const commandOptions = {
  operationId: suppliedOperationId,
  csrfToken: "csrf",
} as const;
const lease: AuthenticatedRequestLease = {
  expectedUserId: goalId,
  signal: new AbortController().signal,
  isCurrent: () => true,
};

const authenticatedJSON = (payload: unknown) =>
  Response.json(payload, {
    headers: { "X-Fukamu-Authenticated-User-ID": goalId },
  });

const collectZodIssuePaths = (
  issues: ZodError["issues"],
): ReadonlyArray<ReadonlyArray<PropertyKey>> =>
  issues.flatMap((issue) =>
    issue.code === "invalid_union"
      ? issue.errors.flatMap((branch) => collectZodIssuePaths(branch))
      : [issue.path],
  );

const reviewResponse = (responseGoalId = goalId) => {
  const goalVersion = {
    id: "00000000-0000-7000-8000-000000000005",
    versionNumber: 2,
    body: "現在の目標",
    successSignal: null,
    createdAt: "2026-08-19T00:00:00Z",
  };
  return {
    goal: {
      id: responseGoalId,
      status: "goal_review",
      revision: 4,
      currentVersion: goalVersion,
      currentWork: {
        kind: "goal_review",
        reviewDraftId,
        triggerCycleId: cycleId,
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
      goalId: responseGoalId,
      baseGoalVersionId: goalVersion.id,
      reviewCycleId: cycleId,
      body: "次のCycleで試す目標",
      successSignal: null,
      revision: 2,
      updatedAt: "2026-08-20T00:02:00Z",
    },
    triggerCycle: {
      id: cycleId,
      goalId: responseGoalId,
      sequenceNumber: 3,
      status: "completed",
      goalVersion: { ...goalVersion },
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
  };
};

const reviewScheduleCycleResponse = (
  overrides: Readonly<Record<string, unknown>> = {},
) => ({
  id: cycleId,
  goalId,
  sequenceNumber: 1,
  status: "active",
  goalVersion: {
    id: "00000000-0000-7000-8000-000000000005",
    versionNumber: 1,
    body: "現在の目標",
    successSignal: null,
    createdAt: "2026-08-19T00:00:00Z",
  },
  previousCompletedCycleAction: null,
  reviewDate: "2026-09-25",
  reviewScheduleRevision: 1,
  startedAt: "2026-08-20T00:00:00Z",
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  plan: "計画",
  do: "実行",
  check: "評価",
  action: "改善",
  contentRevision: 4,
  frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
  ...overrides,
});

const replanResponse = () => {
  const successorCycleId = "00000000-0000-7000-8000-000000000006";
  const goalVersion = {
    id: "00000000-0000-7000-8000-000000000005",
    versionNumber: 1,
    body: "現在の目標",
    successSignal: null,
    createdAt: "2026-08-19T00:00:00Z",
  };
  return {
    canceledCycle: {
      id: cycleId,
      goalId,
      sequenceNumber: 1,
      status: "canceled",
      goalVersion: { ...goalVersion },
      previousCompletedCycleAction: null,
      reviewDate: "2026-09-25",
      reviewScheduleRevision: 2,
      startedAt: "2026-08-20T00:00:00Z",
      completedAt: null,
      canceledAt: "2026-08-21T00:00:00Z",
      cancellationReason: "replanned",
      plan: "計画",
      do: "実行",
      check: "評価",
      action: "改善",
      contentRevision: 4,
      frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
    },
    goal: {
      id: goalId,
      status: "active_cycle",
      revision: 5,
      currentVersion: { ...goalVersion },
      currentWork: {
        kind: "active_cycle",
        cycleId: successorCycleId,
        cycleSequenceNumber: 2,
        reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
      },
      nextCycleSequenceNumber: 3,
      cycleCount: 2,
      createdAt: "2026-08-19T00:00:00Z",
      terminalAt: null,
    },
    cycle: {
      id: successorCycleId,
      goalId,
      sequenceNumber: 2,
      status: "active",
      goalVersion: { ...goalVersion },
      previousCompletedCycleAction: null,
      reviewDate: null,
      reviewScheduleRevision: 0,
      startedAt: "2026-08-21T00:00:00Z",
      completedAt: null,
      canceledAt: null,
      cancellationReason: null,
      plan: "",
      do: "",
      check: "",
      action: "",
      contentRevision: 0,
      frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
    },
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("goal-scoped workspace API", () => {
  it("requires an authenticated lease and disables browser HTTP caching", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          progressingGoals: [],
          creationDraft: null,
          canCreateGoalDraft: true,
          progressingGoalLimit: 3,
          canStartProgressingGoal: true,
        },
        { headers: { "X-Fukamu-Authenticated-User-ID": goalId } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getHome(lease)).resolves.toBeDefined();
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
  });

  it("accepts a coherent Review response for the requested Goal", async () => {
    const response = reviewResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authenticatedJSON(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getReview(lease, goalId)).resolves.toEqual(response);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/goals/${goalId}/review`);
  });

  it("rejects an internally coherent Review for a different path Goal", async () => {
    const otherGoalId = "10000000-0000-7000-8000-000000000001";
    const response = reviewResponse(otherGoalId);
    expect(reviewSchema.safeParse(response).success).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
    );

    await expect(getReview(lease, goalId)).rejects.toMatchObject({
      name: "ZodError",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["goal", "id"] }),
      ]),
    });
  });

  it("rejects a Goal detail response for a different path Goal", async () => {
    const otherGoalId = "10000000-0000-7000-8000-000000000001";
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          authenticatedJSON({ goal: reviewResponse(otherGoalId).goal }),
        ),
    );

    await expect(getGoal(lease, goalId)).rejects.toMatchObject({
      name: "ZodError",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["goal", "id"] }),
      ]),
    });
  });

  it.each([
    ["Cycle", { id: "00000000-0000-7000-8000-000000000099" }],
    ["Goal", { goalId: "00000000-0000-7000-8000-000000000099" }],
  ] as const)(
    "rejects a Cycle detail response for a different path %s",
    async (_label, overrides) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          authenticatedJSON({
            cycle: reviewScheduleCycleResponse(overrides),
          }),
        ),
      );

      await expect(getCycle(lease, goalId, cycleId)).rejects.toMatchObject({
        name: "ZodError",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["cycle", "id"] }),
        ]),
      });
    },
  );

  it.each([
    {
      label: "object",
      sequenceNumber: 2,
      goalVersionNumber: 2,
      previousCompletedCycleAction: {
        cycleId: "00000000-0000-7000-8000-000000000006",
        cycleSequenceNumber: 1,
        goalVersionNumber: 1,
        action: "次は通知を切る\n30分集中する",
      },
    },
    {
      label: "null",
      sequenceNumber: 1,
      goalVersionNumber: 1,
      previousCompletedCycleAction: null,
    },
  ])(
    "requires and preserves the activated $label previous Action",
    async ({
      sequenceNumber,
      goalVersionNumber,
      previousCompletedCycleAction,
    }) => {
      const response = {
        cycle: {
          id: cycleId,
          goalId,
          sequenceNumber,
          status: "active",
          goalVersion: {
            id: "00000000-0000-7000-8000-000000000005",
            versionNumber: goalVersionNumber,
            body: "現在の目標",
            successSignal: null,
            createdAt: "2026-08-19T00:00:00Z",
          },
          previousCompletedCycleAction,
          reviewDate: null,
          reviewScheduleRevision: 0,
          startedAt: "2026-08-20T00:00:00Z",
          completedAt: null,
          canceledAt: null,
          cancellationReason: null,
          plan: "計画",
          do: "実行",
          check: "評価",
          action: "改善",
          contentRevision: 4,
          frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
      );

      const parsed = await getCycle(lease, goalId, cycleId);

      expect(parsed.cycle).toMatchObject({
        id: cycleId,
        sequenceNumber,
        status: "active",
        previousCompletedCycleAction,
      });
    },
  );

  it.each([
    {
      name: "Goal Start",
      surface: "start",
      field: "cycle",
      invoke: () => startGoal(lease, goalId, 0, commandOptions),
    },
    {
      name: "Cycle detail",
      surface: "detail",
      field: "cycle",
      invoke: () => getCycle(lease, goalId, cycleId),
    },
    {
      name: "Goal Review trigger",
      surface: "review",
      field: "triggerCycle",
      invoke: () => getReview(lease, goalId),
    },
    {
      name: "Cycle Complete",
      surface: "complete",
      field: "completedCycle",
      invoke: () => completeCycle(lease, goalId, cycleId, 4, 9, commandOptions),
    },
    {
      name: "Goal Review Continue",
      surface: "continue",
      field: "cycle",
      invoke: () => continueReview(lease, goalId, 4, 2, commandOptions),
    },
    {
      name: "Goal Terminate",
      surface: "terminate",
      field: "canceledCycle",
      invoke: () =>
        terminateGoal(
          lease,
          goalId,
          "ended",
          4,
          "active_cycle",
          commandOptions,
          { id: cycleId, revision: 9 },
        ),
    },
  ] as const)(
    "rejects a $name full Cycle response that omits the activated previous Action field",
    async ({ field, invoke, surface }) => {
      const review = reviewResponse();
      const cycleWithoutField: Record<string, unknown> = {
        ...review.triggerCycle,
      };
      delete cycleWithoutField.previousCompletedCycleAction;
      const responsePayload =
        surface === "review"
          ? { ...review, triggerCycle: cycleWithoutField }
          : surface === "complete"
            ? {
                goal: review.goal,
                reviewDraft: review.reviewDraft,
                completedCycle: cycleWithoutField,
              }
            : surface === "terminate"
              ? { goal: review.goal, canceledCycle: cycleWithoutField }
              : surface === "start"
                ? { goal: review.goal, cycle: cycleWithoutField }
                : surface === "continue"
                  ? {
                      goal: review.goal,
                      versionCreated: false,
                      cycle: cycleWithoutField,
                    }
                  : { cycle: cycleWithoutField };
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(authenticatedJSON(responsePayload)),
      );

      let failure: unknown;
      try {
        await invoke();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ZodError);
      if (failure instanceof ZodError) {
        expect(collectZodIssuePaths(failure.issues)).toContainEqual([
          field,
          "previousCompletedCycleAction",
        ]);
      }
    },
  );

  it.each([
    {
      name: "goal draft load",
      invoke: (signal: AbortSignal) => getGoalDraft(lease, goalId, signal),
    },
    {
      name: "goal draft save",
      invoke: (signal: AbortSignal) =>
        saveGoalDraft(
          lease,
          goalId,
          { body: "目標", successSignal: null },
          0,
          "csrf",
          signal,
        ),
    },
    {
      name: "goal load",
      invoke: (signal: AbortSignal) => getGoal(lease, goalId, signal),
    },
    {
      name: "review load",
      invoke: (signal: AbortSignal) => getReview(lease, goalId, signal),
    },
    {
      name: "review save",
      invoke: (signal: AbortSignal) =>
        saveReview(
          lease,
          goalId,
          reviewDraftId,
          { body: "見直し", successSignal: null },
          0,
          "csrf",
          signal,
        ),
    },
    {
      name: "cycle load",
      invoke: (signal: AbortSignal) => getCycle(lease, goalId, cycleId, signal),
    },
    {
      name: "cycle frame save",
      invoke: (signal: AbortSignal) =>
        saveCycleFrame(
          lease,
          goalId,
          cycleId,
          "plan",
          "計画",
          0,
          "csrf",
          signal,
        ),
    },
  ])("composes the caller and lease signals for $name", async ({ invoke }) => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("request aborted"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(invoke(controller.signal)).rejects.toBeInstanceOf(TypeError);

    expect(fetchMock).toHaveBeenCalledOnce();
    const forwardedSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(forwardedSignal).not.toBe(controller.signal);
    expect(forwardedSignal).not.toBe(lease.signal);
    expect(forwardedSignal?.aborted).toBe(false);
    controller.abort();
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it.each([
    {
      name: "goal draft refinement",
      wire: "header",
      invoke: () => refineGoalDraft(lease, goalId, 0, commandOptions),
    },
    {
      name: "goal start",
      wire: "body",
      invoke: () => startGoal(lease, goalId, 0, commandOptions),
    },
    {
      name: "goal review refinement",
      wire: "header",
      invoke: () => refineReview(lease, goalId, 0, 1, commandOptions),
    },
    {
      name: "goal review continuation",
      wire: "body",
      invoke: () => continueReview(lease, goalId, 1, 0, commandOptions),
    },
    {
      name: "goal termination",
      wire: "body",
      invoke: () =>
        terminateGoal(
          lease,
          goalId,
          "ended",
          1,
          "active_cycle",
          commandOptions,
          {
            id: cycleId,
            revision: 4,
          },
        ),
    },
    {
      name: "goal deletion",
      wire: "header",
      invoke: () => deleteGoal(lease, goalId, 1, commandOptions),
    },
    {
      name: "action generation",
      wire: "header",
      invoke: () =>
        generateAction(lease, goalId, cycleId, 4, false, commandOptions),
    },
    {
      name: "action refinement",
      wire: "header",
      invoke: () => refineAction(lease, goalId, cycleId, 4, commandOptions),
    },
    {
      name: "cycle completion",
      wire: "body",
      invoke: () => completeCycle(lease, goalId, cycleId, 1, 4, commandOptions),
    },
  ])(
    "sends the same caller-owned ID on two $name attempts",
    async ({ invoke, wire }) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("response lost"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(invoke()).rejects.toBeInstanceOf(TypeError);
      await expect(invoke()).rejects.toBeInstanceOf(TypeError);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [, options] of fetchMock.mock.calls) {
        const headers = new Headers(options?.headers);
        const body = JSON.parse(String(options?.body)) as Record<
          string,
          unknown
        >;
        expect(headers.get("X-CSRF-Token")).toBe(commandOptions.csrfToken);
        if (wire === "header") {
          expect(headers.get("Idempotency-Key")).toBe(suppliedOperationId);
          expect(body).not.toHaveProperty("operationId");
        } else {
          expect(headers.get("Idempotency-Key")).toBeNull();
          expect(body.operationId).toBe(suppliedOperationId);
        }
      }
    },
  );

  it("serializes Goal termination as a state-specific request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("response lost"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      terminateGoal(lease, goalId, "ended", 1, "active_cycle", commandOptions, {
        id: cycleId,
        revision: 4,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      terminateGoal(
        lease,
        goalId,
        "achieved",
        2,
        "goal_review",
        commandOptions,
      ),
    ).rejects.toBeInstanceOf(TypeError);

    const activeRequest = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    );
    expect(activeRequest).toEqual({
      operationId: suppliedOperationId,
      outcome: "ended",
      expectedGoalRevision: 1,
      expectedState: "active_cycle",
      activeCycleId: cycleId,
      expectedCycleContentRevision: 4,
    });

    const reviewRequest = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    );
    expect(reviewRequest).toEqual({
      operationId: suppliedOperationId,
      outcome: "achieved",
      expectedGoalRevision: 2,
      expectedState: "goal_review",
      confirmDiscardReviewDraft: true,
    });
  });
  it("saves a frame through the nested goal/cycle route with CSRF", async () => {
    const response = {
      cycleId,
      frame: "plan",
      content: "計画",
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-19T00:00:00Z",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authenticatedJSON(response));
    vi.stubGlobal("fetch", fetchMock);
    await saveCycleFrame(lease, goalId, cycleId, "plan", "計画", 0, "csrf");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/goals/${goalId}/cycles/${cycleId}/frames/plan`,
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.method).toBe("PATCH");
    expect(new Headers(options?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(options?.body).toBe(
      JSON.stringify({ content: "計画", expectedFrameRevision: 0 }),
    );
  });

  it("sets and clears a review date through the nested Cycle route with exact bodies", async () => {
    const cycle = reviewScheduleCycleResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authenticatedJSON({ cycle }))
      .mockResolvedValueOnce(
        authenticatedJSON({
          cycle: {
            ...cycle,
            reviewDate: null,
            reviewScheduleRevision: 2,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await changeReviewSchedule(
      lease,
      goalId,
      cycleId,
      {
        action: "set",
        reviewDate: "2026-09-25",
        expectedReviewScheduleRevision: 0,
      },
      "csrf",
    );
    await changeReviewSchedule(
      lease,
      goalId,
      cycleId,
      { action: "clear", expectedReviewScheduleRevision: 1 },
      "csrf",
    );

    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(
        `/api/v1/goals/${goalId}/cycles/${cycleId}/review-schedule`,
      );
      expect(call[1]?.method).toBe("PATCH");
      expect(new Headers(call[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
    }
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        action: "set",
        reviewDate: "2026-09-25",
        expectedReviewScheduleRevision: 0,
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        action: "clear",
        expectedReviewScheduleRevision: 1,
      }),
    );
  });

  it.each([
    ["Cycle", { id: "00000000-0000-7000-8000-000000000099" }, ["cycle", "id"]],
    [
      "Goal",
      { goalId: "00000000-0000-7000-8000-000000000099" },
      ["cycle", "id"],
    ],
  ] as const)(
    "rejects a review schedule response for a different %s identity",
    async (_label, overrides, expectedPath) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          authenticatedJSON({
            cycle: reviewScheduleCycleResponse(overrides),
          }),
        ),
      );

      await expect(
        changeReviewSchedule(
          lease,
          goalId,
          cycleId,
          {
            action: "set",
            reviewDate: "2026-09-25",
            expectedReviewScheduleRevision: 0,
          },
          "csrf",
        ),
      ).rejects.toMatchObject({
        name: "ZodError",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: [...expectedPath] }),
        ]),
      });
    },
  );

  it("uses a signed cursor opaquely when listing a goal timeline", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authenticatedJSON({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await listCycles(lease, goalId, "opaque+cursor/=");
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "cursor=opaque%2Bcursor%2F%3D",
    );
  });

  it("sends every Replan precondition and accepts the fresh empty successor", async () => {
    const response = replanResponse();
    response.goal.currentVersion.createdAt = "2026-08-19T09:00:00+09:00";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authenticatedJSON(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      replanCycle(lease, goalId, cycleId, 4, 4, 2, commandOptions),
    ).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/goals/${goalId}/cycles/${cycleId}/replan`,
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({
      operationId: suppliedOperationId,
      expectedGoalRevision: 4,
      expectedContentRevision: 4,
      expectedReviewScheduleRevision: 2,
      confirmed: true,
    });
  });

  it("accepts an idempotent Replan replay after its successor reached a later state", async () => {
    const fresh = replanResponse();
    const response = {
      ...fresh,
      replayed: true as const,
      goal: {
        ...fresh.goal,
        status: "goal_review",
        revision: 6,
        currentWork: {
          kind: "goal_review",
          reviewDraftId: reviewDraftId,
          triggerCycleId: fresh.cycle.id,
          triggerCycleSequenceNumber: fresh.cycle.sequenceNumber,
        },
      },
      cycle: {
        ...fresh.cycle,
        status: "completed",
        completedAt: "2026-08-22T00:00:00Z",
        plan: "再計画後の計画",
        do: "再計画後の実行",
        check: "再計画後の評価",
        action: "再計画後の改善",
        contentRevision: 4,
        frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
    );

    await expect(
      replanCycle(lease, goalId, cycleId, 4, 4, 2, commandOptions),
    ).resolves.toEqual(response);
  });

  it("accepts an idempotent Replan replay after the active successor changed", async () => {
    const fresh = replanResponse();
    const response = {
      ...fresh,
      replayed: true as const,
      goal: {
        ...fresh.goal,
        revision: 7,
        currentWork: {
          ...fresh.goal.currentWork,
          reviewSchedule: {
            reviewDate: "2026-09-30",
            reviewScheduleRevision: 1,
          },
        },
      },
      cycle: {
        ...fresh.cycle,
        reviewDate: "2026-09-30",
        reviewScheduleRevision: 1,
        plan: "再計画後に保存した計画",
        contentRevision: 1,
        frameRevisions: { plan: 1, do: 0, check: 0, action: 0 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
    );

    await expect(
      replanCycle(lease, goalId, cycleId, 4, 4, 2, commandOptions),
    ).resolves.toEqual(response);
  });

  it.each([
    {
      label: "a different source Cycle",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.canceledCycle.id = "00000000-0000-7000-8000-000000000009";
      },
    },
    {
      label: "a non-replanned source",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.canceledCycle.cancellationReason = "goal_ended";
      },
    },
    {
      label: "a non-contiguous successor",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.cycle.sequenceNumber += 1;
      },
    },
    {
      label: "a successor on another Goal Version",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.cycle.goalVersion.id = "00000000-0000-7000-8000-000000000009";
      },
    },
    {
      label: "copied content in a fresh successor",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.cycle.plan = "引き継がれた計画";
        response.cycle.contentRevision = 1;
        response.cycle.frameRevisions.plan = 1;
      },
    },
    {
      label: "a source content revision other than the request",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.canceledCycle.contentRevision = 3;
      },
    },
    {
      label: "a source review schedule revision other than the request",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.canceledCycle.reviewScheduleRevision = 1;
      },
    },
    {
      label: "a successor started at a different instant",
      mutate: (response: ReturnType<typeof replanResponse>) => {
        response.cycle.startedAt = "2026-08-21T00:00:01Z";
      },
    },
  ])("rejects a Replan response with $label", async ({ mutate }) => {
    const response = replanResponse();
    mutate(response);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
    );

    await expect(
      replanCycle(lease, goalId, cycleId, 4, 4, 2, commandOptions),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects an active Replan replay whose Goal points at another workspace", async () => {
    const fresh = replanResponse();
    const response = {
      ...fresh,
      replayed: true as const,
      goal: {
        ...fresh.goal,
        currentWork: {
          ...fresh.goal.currentWork,
          cycleId: "00000000-0000-7000-8000-000000000009",
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
    );

    await expect(
      replanCycle(lease, goalId, cycleId, 4, 4, 2, commandOptions),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a Replan replay whose Goal revision did not advance", async () => {
    const response = { ...replanResponse(), replayed: true as const };
    response.goal.revision = 4;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
    );

    await expect(
      replanCycle(lease, goalId, cycleId, 4, 4, 2, commandOptions),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each([
    {
      label: "a Completed successor still selected as Active work",
      response: () => {
        const fresh = replanResponse();
        return {
          ...fresh,
          replayed: true as const,
          cycle: {
            ...fresh.cycle,
            status: "completed",
            completedAt: "2026-08-22T00:00:00Z",
          },
        };
      },
    },
    {
      label: "a goal-ended successor with an Achieved Goal",
      response: () => {
        const fresh = replanResponse();
        return {
          ...fresh,
          replayed: true as const,
          goal: {
            ...fresh.goal,
            status: "achieved",
            currentWork: null,
            terminalAt: "2026-08-22T00:00:00Z",
          },
          cycle: {
            ...fresh.cycle,
            status: "canceled",
            canceledAt: "2026-08-22T00:00:00Z",
            cancellationReason: "goal_ended",
          },
        };
      },
    },
  ])("rejects terminal Replan replay with $label", async ({ response }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response())),
    );

    await expect(
      replanCycle(lease, goalId, cycleId, 4, 4, 2, commandOptions),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("requires expanded Cycle summary cancellation reasons", async () => {
    const goalVersion = {
      id: "00000000-0000-7000-8000-000000000005",
      versionNumber: 1,
      body: "現在の目標",
      successSignal: null,
      createdAt: "2026-08-19T00:00:00Z",
    };
    const completedSummary = {
      id: "00000000-0000-7000-8000-000000000006",
      sequenceNumber: 1,
      status: "completed",
      startedAt: "2026-08-19T00:00:00Z",
      completedAt: "2026-08-20T00:00:00Z",
      canceledAt: null,
      cancellationReason: null,
      goalVersion,
      planPreview: "最初の計画",
      learningPreview: {
        check: { text: "分かったこと", truncated: false },
        action: { text: "次に変えること", truncated: false },
      },
    };
    const replannedSummary = {
      ...completedSummary,
      id: "00000000-0000-7000-8000-000000000008",
      sequenceNumber: 2,
      status: "canceled",
      completedAt: null,
      canceledAt: "2026-08-21T00:00:00Z",
      cancellationReason: "replanned",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        authenticatedJSON({
          items: [completedSummary, replannedSummary],
          nextCursor: null,
        }),
      ),
    );

    const page = await listCycles(lease, goalId);

    expect(page.items[0]?.cancellationReason).toBeNull();
    expect(page.items[1]?.cancellationReason).toBe("replanned");
  });

  it("rejects a Cycle summary missing its required cancellation reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        authenticatedJSON({
          items: [
            {
              id: cycleId,
              sequenceNumber: 1,
              status: "completed",
              startedAt: "2026-08-19T00:00:00Z",
              completedAt: "2026-08-20T00:00:00Z",
              canceledAt: null,
              goalVersion: {
                id: "00000000-0000-7000-8000-000000000005",
                versionNumber: 1,
                body: "現在の目標",
                successSignal: null,
                createdAt: "2026-08-19T00:00:00Z",
              },
              planPreview: "最初の計画",
              learningPreview: {
                check: { text: "分かったこと", truncated: false },
                action: { text: "次に変えること", truncated: false },
              },
            },
          ],
          nextCursor: null,
        }),
      ),
    );

    await expect(listCycles(lease, goalId)).rejects.toBeInstanceOf(ZodError);
  });

  it.each(["manual_restart", "goal_deleted"])(
    "rejects the out-of-contract Cycle summary cancellation reason %s",
    async (cancellationReason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          authenticatedJSON({
            items: [
              {
                id: cycleId,
                sequenceNumber: 1,
                status: "canceled",
                startedAt: "2026-08-19T00:00:00Z",
                completedAt: null,
                canceledAt: "2026-08-20T00:00:00Z",
                cancellationReason,
                goalVersion: {
                  id: "00000000-0000-7000-8000-000000000005",
                  versionNumber: 1,
                  body: "現在の目標",
                  successSignal: null,
                  createdAt: "2026-08-19T00:00:00Z",
                },
                planPreview: "最初の計画",
                learningPreview: {
                  check: { text: "分かったこと", truncated: false },
                  action: { text: "次に変えること", truncated: false },
                },
              },
            ],
            nextCursor: null,
          }),
        ),
      );

      await expect(listCycles(lease, goalId)).rejects.toBeInstanceOf(ZodError);
    },
  );

  it("rejects a Cycle summary missing its required learning preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        authenticatedJSON({
          items: [
            {
              id: cycleId,
              sequenceNumber: 1,
              status: "active",
              startedAt: "2026-08-19T00:00:00Z",
              completedAt: null,
              canceledAt: null,
              cancellationReason: null,
              goalVersion: {
                id: "00000000-0000-7000-8000-000000000005",
                versionNumber: 1,
                body: "現在の目標",
                successSignal: null,
                createdAt: "2026-08-19T00:00:00Z",
              },
              planPreview: "最初の計画",
            },
          ],
          nextCursor: null,
        }),
      ),
    );

    await expect(listCycles(lease, goalId)).rejects.toBeInstanceOf(ZodError);
  });

  it("leases a review save to the expected draft generation", async () => {
    const response = {
      reviewDraft: {
        id: reviewDraftId,
        goalId,
        draftType: "review",
        body: "見直した目標",
        successSignal: "週3回できる",
        revision: 1,
        updatedAt: "2026-08-19T00:00:00Z",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authenticatedJSON(response));
    vi.stubGlobal("fetch", fetchMock);

    await saveReview(
      lease,
      goalId,
      reviewDraftId,
      { body: "見直した目標", successSignal: "週3回できる" },
      0,
      "csrf",
    );

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        body: "見直した目標",
        successSignal: "週3回できる",
        expectedReviewDraftId: reviewDraftId,
        expectedRevision: 0,
      }),
    );
  });

  it("preserves a non-null success signal in a strict Review adoption response", async () => {
    const generationId = "00000000-0000-7000-8000-000000000007";
    const response = {
      reviewDraft: {
        id: reviewDraftId,
        goalId,
        draftType: "review",
        baseGoalVersionId: "00000000-0000-7000-8000-000000000005",
        reviewCycleId: cycleId,
        body: "整理されたレビュー目標",
        successSignal: "週3回できる\n夕方に余裕がある",
        revision: 3,
        updatedAt: "2026-08-20T00:03:00Z",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authenticatedJSON(response));
    vi.stubGlobal("fetch", fetchMock);

    const adopted = await adoptReview(
      lease,
      goalId,
      generationId,
      2,
      4,
      "csrf",
    );

    expect(adopted.reviewDraft.successSignal).toBe(
      response.reviewDraft.successSignal,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ expectedDraftRevision: 2, expectedGoalRevision: 4 }),
    );
  });

  it("rejects a Review adoption response missing the required success signal", async () => {
    const response = {
      reviewDraft: {
        id: reviewDraftId,
        goalId,
        draftType: "review",
        baseGoalVersionId: "00000000-0000-7000-8000-000000000005",
        reviewCycleId: cycleId,
        body: "整理されたレビュー目標",
        revision: 3,
        updatedAt: "2026-08-20T00:03:00Z",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(authenticatedJSON(response)),
    );

    await expect(
      adoptReview(
        lease,
        goalId,
        "00000000-0000-7000-8000-000000000007",
        2,
        4,
        "csrf",
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each([
    { label: "sets", successSignal: "週3回\nできる" },
    { label: "clears", successSignal: null },
  ])(
    "$label a Goal Draft success signal explicitly",
    async ({ successSignal }) => {
      const response = {
        draft: {
          id: goalId,
          draftType: "creation",
          body: "目標",
          successSignal,
          revision: 1,
          updatedAt: "2026-08-19T00:00:00Z",
        },
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(authenticatedJSON(response));
      vi.stubGlobal("fetch", fetchMock);

      await saveGoalDraft(
        lease,
        goalId,
        { body: "目標", successSignal },
        0,
        "csrf",
      );

      expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
        JSON.stringify({ body: "目標", successSignal, expectedRevision: 0 }),
      );
    },
  );

  it("sends goal and cycle revisions when completing without creating a next cycle client-side", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 500,
        headers: { "X-Fukamu-Authenticated-User-ID": goalId },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      completeCycle(lease, goalId, cycleId, 4, 9, commandOptions),
    ).rejects.toBeDefined();
    const options = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      expectedGoalRevision: 4,
      expectedContentRevision: 9,
    });
    expect(body).toHaveProperty("operationId");
    expect(body).not.toHaveProperty("nextCycleId");
  });

  it("accepts a command replay response after the workspace has already advanced", async () => {
    const nextCycleId = "00000000-0000-7000-8000-000000000003";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      authenticatedJSON({
        replayed: true,
        operation: "complete_cycle",
        resourceIds: { goalId, cycleId },
        currentGoalState: "active_cycle",
        currentWorkspace: {
          kind: "active_cycle",
          cycleId: nextCycleId,
          cycleSequenceNumber: 2,
          reviewSchedule: {
            reviewDate: null,
            reviewScheduleRevision: 0,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeCycle(
      lease,
      goalId,
      cycleId,
      4,
      9,
      commandOptions,
    );
    expect(result).toMatchObject({
      replayed: true,
      operation: "complete_cycle",
      currentWorkspace: { cycleId: nextCycleId },
    });
  });

  it("rejects an incomplete current workspace replay", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      authenticatedJSON({
        replayed: true,
        operation: "complete_cycle",
        resourceIds: { goalId, cycleId },
        currentGoalState: "active_cycle",
        currentWorkspace: { kind: "active_cycle", cycleId },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeCycle(lease, goalId, cycleId, 4, 9, commandOptions),
    ).rejects.toBeDefined();
  });

  it("preserves revision zero in a goal review refinement response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      authenticatedJSON({
        generationId: "00000000-0000-7000-8000-000000000003",
        sourceDraftRevision: 0,
        sourceGoalRevision: 1,
        suggestion: "AIからの提案",
        contextChanged: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refineReview(lease, goalId, 0, 1, commandOptions);

    expect(result.sourceDraftRevision).toBe(0);
  });

  it("rejects a goal refinement response without its source revision", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      authenticatedJSON({
        generationId: "00000000-0000-7000-8000-000000000003",
        suggestion: "AIからの提案",
        contextChanged: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refineReview(lease, goalId, 0, 1, commandOptions),
    ).rejects.toBeDefined();
  });
});
