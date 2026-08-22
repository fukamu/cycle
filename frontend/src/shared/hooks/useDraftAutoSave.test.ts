import { act, renderHook } from "@testing-library/react";

import {
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../drafts/browserDraftCache";
import { useDraftAutoSave } from "./useDraftAutoSave";

vi.mock("../drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function input(
  save: (
    body: string,
    revision: number,
  ) => Promise<{ body: string; revision: number }>,
) {
  return {
    userId: "user-1",
    goalId: "goal-1",
    subjectKey: "goal-review:goal-1",
    initialBody: "",
    initialRevision: 0,
    save,
  };
}

describe("useDraftAutoSave", () => {
  beforeEach(() => {
    vi.mocked(getBrowserDraft).mockReset().mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("debounces the API call until 800ms after the latest input", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ body: "second", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));
    await act(async () => undefined);

    act(() => result.current.setBody("first"));
    await act(() => vi.advanceTimersByTimeAsync(700));
    act(() => result.current.setBody("second"));
    await act(() => vi.advanceTimersByTimeAsync(799));
    expect(save).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("second", 0);
  });

  it("serializes the latest edit behind an in-flight save", async () => {
    vi.useFakeTimers();
    const first = deferred<{ body: string; revision: number }>();
    const second = deferred<{ body: string; revision: number }>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useDraftAutoSave(input(save)));

    act(() => result.current.setBody("first"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenNthCalledWith(1, "first", 0);

    act(() => result.current.setBody("second"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve({ body: "first", revision: 1 }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenNthCalledWith(2, "second", 1);

    await act(async () => second.resolve({ body: "second", revision: 2 }));
    expect(result.current.state).toBe("saved");
    expect(result.current.body).toBe("second");
    expect(result.current.revision).toBe(2);
  });

  it("coalesces browser recovery writes for a typing burst", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ body: "abc", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));
    await act(async () => undefined);

    act(() => result.current.setBody("a"));
    await act(() => vi.advanceTimersByTimeAsync(75));
    act(() => result.current.setBody("ab"));
    await act(() => vi.advanceTimersByTimeAsync(75));
    act(() => result.current.setBody("abc"));
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(putBrowserDraft).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(putBrowserDraft).toHaveBeenCalledOnce();
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        goalId: "goal-1",
        body: "abc",
        baseRevision: 0,
      }),
    );
  });

  it("keeps a successful server save successful when IndexedDB cleanup fails", async () => {
    vi.useFakeTimers();
    vi.mocked(deleteBrowserDraft).mockRejectedValue(new Error("indexeddb"));
    const save = vi.fn().mockResolvedValue({ body: "saved", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));

    act(() => result.current.setBody("saved"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(result.current.state).toBe("saved");
    expect(result.current.revision).toBe(1);
    expect(result.current.browserCacheFailed).toBe(true);
  });

  it("pauses after five automatic retries and allows a manual retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const save = vi.fn().mockRejectedValue(new TypeError("network"));
    const { result } = renderHook(() => useDraftAutoSave(input(save)));

    act(() => result.current.setBody("offline edit"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledTimes(1);

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await act(() => vi.advanceTimersByTimeAsync(delay));
    }
    expect(save).toHaveBeenCalledTimes(6);
    expect(result.current.state).toBe("failed");

    save.mockResolvedValueOnce({ body: "offline edit", revision: 1 });
    act(() => result.current.retry());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenCalledTimes(7);
    expect(result.current.state).toBe("saved");
  });

  it("does not send a mismatched browser draft until the user restores it", async () => {
    vi.useFakeTimers();
    vi.mocked(getBrowserDraft).mockResolvedValue({
      userId: "user-1",
      goalId: "goal-1",
      subjectKey: "goal-review:goal-1",
      body: "local recovery",
      baseRevision: 4,
      updatedAt: new Date().toISOString(),
    });
    const save = vi
      .fn()
      .mockResolvedValue({ body: "local recovery", revision: 6 });
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(save),
        initialBody: "server body",
        initialRevision: 5,
      }),
    );

    await act(async () => undefined);
    expect(result.current.body).toBe("local recovery");
    expect(result.current.recoveryConflict?.baseRevision).toBe(4);
    expect(result.current.state).toBe("failed");

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).not.toHaveBeenCalled();

    act(() => result.current.restoreRecovery());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenCalledWith("local recovery", 5);
  });

  it("enqueues a dirty save immediately on blur", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ body: "blurred", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));

    act(() => result.current.setBody("blurred"));
    act(() => result.current.flush());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("blurred", 0);
  });
});
