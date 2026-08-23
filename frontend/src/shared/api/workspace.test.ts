import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequestLease } from "./client";
import {
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
  refineAction,
  refineGoalDraft,
  refineReview,
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

  it.each([
    {
      name: "goal draft load",
      invoke: (signal: AbortSignal) => getGoalDraft(lease, goalId, signal),
    },
    {
      name: "goal draft save",
      invoke: (signal: AbortSignal) =>
        saveGoalDraft(lease, goalId, "目標", 0, "csrf", signal),
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
        saveReview(lease, goalId, reviewDraftId, "見直し", 0, "csrf", signal),
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

  it("leases a review save to the expected draft generation", async () => {
    const response = {
      reviewDraft: {
        id: reviewDraftId,
        goalId,
        draftType: "review",
        body: "見直した目標",
        revision: 1,
        updatedAt: "2026-08-19T00:00:00Z",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authenticatedJSON(response));
    vi.stubGlobal("fetch", fetchMock);

    await saveReview(lease, goalId, reviewDraftId, "見直した目標", 0, "csrf");

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        body: "見直した目標",
        expectedReviewDraftId: reviewDraftId,
        expectedRevision: 0,
      }),
    );
  });

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
