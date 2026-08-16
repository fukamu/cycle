import { act, renderHook } from "@testing-library/react";

import type {
  ActiveCycle,
  SaveFrameResponse,
} from "../../../shared/api/schemas";
import { useAutoSave } from "./useAutoSave";

const mocks = vi.hoisted(() => ({
  saveFrame: vi.fn(),
  putDraft: vi.fn().mockResolvedValue(undefined),
  deleteDraft: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../shared/api/cycles", () => ({ saveFrame: mocks.saveFrame }));
vi.mock("../draft/draftRepository", () => ({
  putDraft: mocks.putDraft,
  deleteDraft: mocks.deleteDraft,
}));

const cycle: ActiveCycle = {
  id: "00000000-0000-4000-8000-000000000001",
  sequenceNumber: 1,
  status: "active",
  startedAt: "2026-08-16T00:00:00Z",
  completedAt: null,
  plan: "",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
  actionUserModifiedAfterAI: false,
};

function response(
  content: string,
  frameRevision = 1,
  contentRevision = 1,
): SaveFrameResponse {
  return {
    cycleId: cycle.id,
    frame: "plan",
    content,
    frameRevision,
    contentRevision,
    savedAt: "2026-08-16T00:00:01Z",
  };
}

describe("useAutoSave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.saveFrame.mockReset();
    mocks.putDraft.mockClear();
    mocks.deleteDraft.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces continuous input until 800ms after the last change", async () => {
    mocks.saveFrame.mockResolvedValue(response("second"));
    const { result } = renderHook(() =>
      useAutoSave({
        userId: "user",
        cycle,
        csrfToken: "csrf",
        initialDrafts: [],
        onSaved: vi.fn(),
      }),
    );

    act(() => result.current.change("plan", "first"));
    await act(() => vi.advanceTimersByTimeAsync(400));
    act(() => result.current.change("plan", "second"));
    await act(() => vi.advanceTimersByTimeAsync(799));
    expect(mocks.saveFrame).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(mocks.saveFrame).toHaveBeenCalledTimes(1);
    expect(mocks.saveFrame).toHaveBeenCalledWith(
      cycle.id,
      "plan",
      "second",
      0,
      "csrf",
    );
  });

  it("serializes input that arrives while a save is in flight and rebases the revision", async () => {
    let resolveFirst: ((value: SaveFrameResponse) => void) | undefined;
    mocks.saveFrame
      .mockImplementationOnce(
        () =>
          new Promise<SaveFrameResponse>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValueOnce(response("latest", 2, 2));
    const { result } = renderHook(() =>
      useAutoSave({
        userId: "user",
        cycle,
        csrfToken: "csrf",
        initialDrafts: [],
        onSaved: vi.fn(),
      }),
    );

    act(() => result.current.change("plan", "snapshot"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(mocks.saveFrame).toHaveBeenCalledTimes(1);
    act(() => result.current.change("plan", "latest"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(mocks.saveFrame).toHaveBeenCalledTimes(1);
    await act(async () => resolveFirst?.(response("snapshot", 1, 1)));
    expect(mocks.saveFrame).toHaveBeenCalledTimes(2);
    expect(mocks.saveFrame).toHaveBeenLastCalledWith(
      cycle.id,
      "plan",
      "latest",
      1,
      "csrf",
    );
  });

  it("keeps the draft and exposes a failed state after a non-retryable conflict", async () => {
    mocks.saveFrame.mockRejectedValue(
      Object.assign(new Error("conflict"), {
        status: 409,
        code: "CYCLE_REVISION_CONFLICT",
      }),
    );
    const { result } = renderHook(() =>
      useAutoSave({
        userId: "user",
        cycle,
        csrfToken: "csrf",
        initialDrafts: [],
        onSaved: vi.fn(),
      }),
    );

    act(() => result.current.change("plan", "draft"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(result.current.saveState.kind).toBe("failed");
    expect(mocks.putDraft).toHaveBeenCalled();
  });

  it("restores a matching revision draft and saves it", async () => {
    mocks.saveFrame.mockResolvedValue(response("recovered"));
    renderHook(() =>
      useAutoSave({
        userId: "user",
        cycle,
        csrfToken: "csrf",
        initialDrafts: [
          {
            userId: "user",
            cycleId: cycle.id,
            frame: "plan",
            content: "recovered",
            baseFrameRevision: 0,
            updatedAt: "2026-08-16T00:00:00Z",
          },
        ],
        onSaved: vi.fn(),
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(mocks.saveFrame).toHaveBeenCalledWith(
      cycle.id,
      "plan",
      "recovered",
      0,
      "csrf",
    );
  });
});
