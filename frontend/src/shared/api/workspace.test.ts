import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeCycle,
  listCycles,
  refineReview,
  saveCycleFrame,
} from "./workspace";

const goalId = "00000000-0000-7000-8000-000000000001";
const cycleId = "00000000-0000-7000-8000-000000000002";

afterEach(() => vi.unstubAllGlobals());

describe("goal-scoped workspace API", () => {
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
      .mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    await saveCycleFrame(goalId, cycleId, "plan", "計画", 0, "csrf");
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
      .mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await listCycles(goalId, "opaque+cursor/=");
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "cursor=opaque%2Bcursor%2F%3D",
    );
  });

  it("sends goal and cycle revisions when completing without creating a next cycle client-side", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      completeCycle(goalId, cycleId, 4, 9, "csrf"),
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
      Response.json({
        replayed: true,
        operation: "complete_cycle",
        resourceIds: { goalId, cycleId },
        currentGoalState: "active_cycle",
        currentWorkspace: { kind: "active_cycle", cycleId: nextCycleId },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeCycle(goalId, cycleId, 4, 9, "csrf");
    expect(result).toMatchObject({
      replayed: true,
      operation: "complete_cycle",
      currentWorkspace: { cycleId: nextCycleId },
    });
  });

  it("preserves revision zero in a goal review refinement response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        generationId: "00000000-0000-7000-8000-000000000003",
        sourceDraftRevision: 0,
        sourceGoalRevision: 1,
        suggestion: "AIからの提案",
        contextChanged: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refineReview(goalId, 0, 1, "csrf");

    expect(result.sourceDraftRevision).toBe(0);
  });

  it("rejects a goal refinement response without its source revision", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        generationId: "00000000-0000-7000-8000-000000000003",
        suggestion: "AIからの提案",
        contextChanged: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refineReview(goalId, 0, 1, "csrf")).rejects.toBeDefined();
  });
});
