import {
  act,
  renderHook as testingLibraryRenderHook,
} from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";

import { APIError } from "../api/client";
import { AutoSaveScopeProvider } from "../autosave/AutoSaveScopeProvider";
import {
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
} from "../drafts/browserDraftCache";
import { useDraftAutoSave } from "./useDraftAutoSave";

vi.mock("../drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn(),
  deleteBrowserDraftIfUnchanged: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
}));

function ScopeWrapper({ children }: PropsWithChildren) {
  return createElement(AutoSaveScopeProvider, null, children);
}

function renderHook<TResult>(render: () => TResult) {
  return testingLibraryRenderHook(render, { wrapper: ScopeWrapper });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function input(
  save: (
    body: string,
    revision: number,
    signal: AbortSignal,
  ) => Promise<{ body: string; revision: number }>,
  loadLatest: (
    signal: AbortSignal,
  ) => Promise<{ body: string; revision: number }> = vi
    .fn()
    .mockResolvedValue({ body: "", revision: 0 }),
) {
  return {
    userId: "user-1",
    goalId: "goal-1",
    subjectKey: "goal-review:goal-1",
    initialBody: "",
    initialSuccessSignal: null,
    initialRevision: 0,
    save: async (
      content: { readonly body: string; readonly successSignal: string },
      revision: number,
      signal: AbortSignal,
    ) => ({
      ...(await save(content.body, revision, signal)),
      successSignal: null,
    }),
    revisionConflictCode: "GOAL_REVIEW_DRAFT_REVISION_CONFLICT" as const,
    loadLatest: async (signal: AbortSignal) => ({
      ...(await loadLatest(signal)),
      successSignal: null,
    }),
  };
}

describe("useDraftAutoSave", () => {
  beforeEach(() => {
    vi.mocked(getBrowserDraft).mockReset().mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraftIfUnchanged)
      .mockReset()
      .mockResolvedValue(undefined);
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
    expect(save).toHaveBeenCalledWith("second", 0, expect.any(AbortSignal));
  });

  it("saves a success-signal-only edit in the same revisioned tuple", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockImplementation(
        async (content: {
          readonly body: string;
          readonly successSignal: string;
        }) => ({ ...content, revision: 1 }),
      );
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(vi.fn().mockResolvedValue({ body: "goal", revision: 1 })),
        initialBody: "goal",
        initialSuccessSignal: "old signal",
        save,
      }),
    );
    await act(async () => undefined);

    act(() => result.current.setSuccessSignal("new\nsignal"));
    await act(() => vi.advanceTimersByTimeAsync(800));

    expect(save).toHaveBeenCalledWith(
      { body: "goal", successSignal: "new\nsignal" },
      0,
      expect.any(AbortSignal),
    );
    expect(result.current.body).toBe("goal");
    expect(result.current.successSignal).toBe("new\nsignal");
    expect(result.current.revision).toBe(1);
  });

  it("preserves the server signal when hydrating a legacy browser record without the optional field", async () => {
    vi.useFakeTimers();
    vi.mocked(getBrowserDraft).mockResolvedValue({
      userId: "user-1",
      goalId: "goal-1",
      subjectKey: "goal-review:goal-1",
      body: "server body",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });
    const save = vi.fn().mockResolvedValue({
      body: "server body",
      successSignal: "server signal",
      revision: 1,
    });
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(
          vi.fn().mockResolvedValue({ body: "server body", revision: 1 }),
        ),
        initialBody: "server body",
        initialSuccessSignal: "server signal",
        save,
      }),
    );

    await act(async () => undefined);
    await act(() => vi.advanceTimersByTimeAsync(800));

    expect(result.current.successSignal).toBe("server signal");
    expect(save).not.toHaveBeenCalled();
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "server body",
        successSignal: "server signal",
        baseRevision: 0,
      }),
    );
  });

  it("keeps the whole local tuple behind a success-signal revision conflict until restore", async () => {
    vi.useFakeTimers();
    const conflict = new APIError(
      409,
      "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
      "conflict",
      "request-success-signal",
    );
    const save = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (content) => ({
        ...content,
        revision: 8,
      }));
    const loadLatest = vi.fn().mockResolvedValue({
      body: "server body",
      successSignal: "other device",
      revision: 7,
    });
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(
          vi.fn().mockResolvedValue({ body: "server body", revision: 1 }),
        ),
        initialBody: "server body",
        initialSuccessSignal: "original",
        save,
        loadLatest,
      }),
    );
    await act(async () => undefined);

    act(() => result.current.setSuccessSignal("local signal"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(result.current.recoveryConflict).toMatchObject({
      body: "server body",
      successSignal: "local signal",
      baseRevision: 0,
    });
    expect(result.current.revision).toBe(7);
    expect(save).toHaveBeenCalledOnce();

    act(() => result.current.restoreRecovery());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(save).toHaveBeenNthCalledWith(
      2,
      { body: "server body", successSignal: "local signal" },
      7,
      expect.any(AbortSignal),
    );
    expect(result.current.state.kind).toBe("saved");
  });

  it("does not report saved or send edits before browser recovery hydration finishes", async () => {
    vi.useFakeTimers();
    const browserRead = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    vi.mocked(getBrowserDraft).mockReturnValueOnce(browserRead.promise);
    const save = vi
      .fn()
      .mockResolvedValue({ body: "typed during hydration", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));

    expect(result.current.state.kind).toBe("saving");
    act(() => result.current.setBody("typed during hydration"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).not.toHaveBeenCalled();

    await act(async () => browserRead.resolve(null));
    expect(result.current.state.kind).toBe("dirty");
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(save).toHaveBeenCalledWith(
      "typed during hydration",
      0,
      expect.any(AbortSignal),
    );
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
    expect(save).toHaveBeenNthCalledWith(
      1,
      "first",
      0,
      expect.any(AbortSignal),
    );

    act(() => result.current.setBody("second"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve({ body: "first", revision: 1 }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenNthCalledWith(
      2,
      "second",
      1,
      expect.any(AbortSignal),
    );

    await act(async () => second.resolve({ body: "second", revision: 2 }));
    expect(result.current.state.kind).toBe("saved");
    expect(result.current.body).toBe("second");
    expect(result.current.revision).toBe(2);
  });

  it("serializes a newer success signal behind an in-flight tuple save", async () => {
    vi.useFakeTimers();
    const first = deferred<{
      body: string;
      successSignal: string | null;
      revision: number;
    }>();
    const second = deferred<{
      body: string;
      successSignal: string | null;
      revision: number;
    }>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(vi.fn().mockResolvedValue({ body: "goal", revision: 1 })),
        initialBody: "goal",
        initialSuccessSignal: "original",
        save,
      }),
    );
    await act(async () => undefined);

    act(() => result.current.setSuccessSignal("first signal"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenNthCalledWith(
      1,
      { body: "goal", successSignal: "first signal" },
      0,
      expect.any(AbortSignal),
    );

    act(() => result.current.setSuccessSignal("latest signal"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledOnce();

    await act(async () =>
      first.resolve({
        body: "goal",
        successSignal: "first signal",
        revision: 1,
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenNthCalledWith(
      2,
      { body: "goal", successSignal: "latest signal" },
      1,
      expect.any(AbortSignal),
    );

    await act(async () =>
      second.resolve({
        body: "goal",
        successSignal: "latest signal",
        revision: 2,
      }),
    );
    expect(result.current.successSignal).toBe("latest signal");
    expect(result.current.revision).toBe(2);
    expect(result.current.state.kind).toBe("saved");
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

  it("persists a dirty recovery snapshot immediately when the document becomes hidden", async () => {
    vi.useFakeTimers();
    const visibilityState = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const save = vi
      .fn()
      .mockResolvedValue({ body: "hidden edit", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));
    await act(async () => undefined);

    act(() => result.current.setBody("hidden edit"));
    expect(putBrowserDraft).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    visibilityState.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(putBrowserDraft).toHaveBeenCalledOnce();
    expect(putBrowserDraft).toHaveBeenCalledWith({
      userId: "user-1",
      goalId: "goal-1",
      subjectKey: "goal-review:goal-1",
      body: "hidden edit",
      successSignal: "",
      baseRevision: 0,
      updatedAt: expect.any(String),
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("deletes a delayed lifecycle snapshot after the same value is saved by the API", async () => {
    vi.useFakeTimers();
    const visibilityState = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const browserWrite = deferred<void>();
    vi.mocked(putBrowserDraft).mockImplementationOnce(
      () => browserWrite.promise,
    );
    const save = vi.fn().mockResolvedValue({ body: "saved edit", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));
    await act(async () => undefined);

    act(() => result.current.setBody("saved edit"));
    visibilityState.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(putBrowserDraft).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledWith("saved edit", 0, expect.any(AbortSignal));
    expect(deleteBrowserDraftIfUnchanged).not.toHaveBeenCalled();

    await act(async () => {
      browserWrite.resolve();
      await browserWrite.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteBrowserDraftIfUnchanged).toHaveBeenCalledOnce();
    expect(deleteBrowserDraftIfUnchanged).toHaveBeenCalledWith(
      "user-1",
      "goal-review:goal-1",
      "saved edit",
      0,
      "",
    );
  });

  it("keeps a successful server save successful when IndexedDB cleanup fails", async () => {
    vi.useFakeTimers();
    vi.mocked(deleteBrowserDraftIfUnchanged).mockRejectedValue(
      new Error("indexeddb"),
    );
    const save = vi.fn().mockResolvedValue({ body: "saved", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));

    act(() => result.current.setBody("saved"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(result.current.state.kind).toBe("saved");
    expect(result.current.revision).toBe(1);
    expect(result.current.browserCacheFailed).toBe(true);
  });

  it("reports an unconditional browser cleanup failure to a cleanup-only caller", async () => {
    vi.mocked(deleteBrowserDraft).mockRejectedValueOnce(
      new Error("indexeddb delete failed"),
    );
    const save = vi.fn().mockResolvedValue({ body: "", revision: 0 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));
    await act(async () => undefined);

    let cleared: boolean | undefined;
    await act(async () => {
      cleared = await result.current.discard();
    });

    expect(cleared).toBe(false);
    expect(result.current.browserCacheFailed).toBe(true);
    expect(deleteBrowserDraft).toHaveBeenCalledWith(
      "user-1",
      "goal-review:goal-1",
    );
  });

  it("clears the last successful recovery snapshot after a newer IndexedDB write fails", async () => {
    vi.useFakeTimers();
    vi.mocked(getBrowserDraft).mockResolvedValueOnce({
      userId: "user-1",
      goalId: "goal-1",
      subjectKey: "goal-review:goal-1",
      body: "previous recovery",
      successSignal: "",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(putBrowserDraft).mockRejectedValueOnce(
      new Error("newer write failed"),
    );
    const save = vi.fn().mockResolvedValue({
      body: "newer local body",
      revision: 1,
    });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));
    await act(async () => undefined);

    act(() => result.current.setBody("newer local body"));
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(result.current.browserCacheFailed).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(650));
    await act(async () => undefined);

    expect(save).toHaveBeenCalledWith(
      "newer local body",
      0,
      expect.any(AbortSignal),
    );
    expect(deleteBrowserDraftIfUnchanged).toHaveBeenCalledWith(
      "user-1",
      "goal-review:goal-1",
      "previous recovery",
      0,
      "",
    );
    expect(deleteBrowserDraftIfUnchanged).not.toHaveBeenCalledWith(
      "user-1",
      "goal-review:goal-1",
      "newer local body",
      0,
      "",
    );
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
    expect(result.current.state.kind).toBe("failed");

    save.mockResolvedValueOnce({ body: "offline edit", revision: 1 });
    act(() => result.current.retry());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenCalledTimes(7);
    expect(result.current.state.kind).toBe("saved");
  });

  it("restores and autosaves a browser draft from the current revision", async () => {
    vi.useFakeTimers();
    vi.mocked(getBrowserDraft).mockResolvedValue({
      userId: "user-1",
      goalId: "goal-1",
      subjectKey: "goal-review:goal-1",
      body: "same revision recovery",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });
    const save = vi.fn().mockResolvedValue({
      body: "same revision recovery",
      revision: 1,
    });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));

    await act(async () => undefined);
    expect(result.current.body).toBe("same revision recovery");
    expect(result.current.state.kind).toBe("dirty");

    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledWith(
      "same revision recovery",
      0,
      expect.any(AbortSignal),
    );
    expect(result.current.state.kind).toBe("saved");
  });

  it("does not send a mismatched browser draft until the user restores it", async () => {
    vi.useFakeTimers();
    const recoveredBody = `${"😀".repeat(81)}\r\n末尾 \t`;
    const canonicalBody = `${"😀".repeat(81)}\n末尾 \t`;
    vi.mocked(getBrowserDraft).mockResolvedValue({
      userId: "user-1",
      goalId: "goal-1",
      subjectKey: "goal-review:goal-1",
      body: recoveredBody,
      baseRevision: 4,
      updatedAt: new Date().toISOString(),
    });
    const save = vi
      .fn()
      .mockResolvedValue({ body: canonicalBody, revision: 6 });
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(save),
        initialBody: "server body",
        initialRevision: 5,
      }),
    );

    await act(async () => undefined);
    expect(result.current.body).toBe(canonicalBody);
    expect(result.current.recoveryConflict?.body).toBe(canonicalBody);
    expect(result.current.recoveryConflict?.baseRevision).toBe(4);
    expect(result.current.state.kind).toBe("failed");

    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: canonicalBody,
        baseRevision: 4,
      }),
    );
    expect(Array.from(result.current.body).length).toBeGreaterThan(80);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).not.toHaveBeenCalled();

    act(() => result.current.restoreRecovery());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenCalledWith(
      canonicalBody,
      5,
      expect.any(AbortSignal),
    );
  });

  it("converges to the latest revision without overwriting when a conflicted snapshot is already on the server", async () => {
    vi.useFakeTimers();
    const conflict = new APIError(
      409,
      "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
      "conflict",
      "request-1",
    );
    const save = vi.fn().mockRejectedValue(conflict);
    const loadLatest = vi
      .fn()
      .mockResolvedValue({ body: "already saved", revision: 7 });
    const { result } = renderHook(() =>
      useDraftAutoSave(input(save, loadLatest)),
    );

    act(() => result.current.setBody("already saved"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(loadLatest).toHaveBeenCalledOnce();
    expect(result.current.body).toBe("already saved");
    expect(result.current.revision).toBe(7);
    expect(result.current.state.kind).toBe("saved");
    expect(result.current.recoveryConflict).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).toHaveBeenCalledOnce();
  });

  it("stops stale retries and preserves the local body when the draft scope moves", async () => {
    vi.useFakeTimers();
    const conflict = new APIError(
      409,
      "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
      "conflict",
      "request-moved",
    );
    const save = vi.fn().mockRejectedValue(conflict);
    const loadLatest = vi.fn().mockResolvedValue({
      body: "replacement scope",
      revision: 1,
    });
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(save, loadLatest),
        acceptLatest: () => ({
          kind: "scope-moved" as const,
          href: "/goals/goal-1",
        }),
      }),
    );
    await act(async () => undefined);

    act(() => result.current.setBody("local body to copy"));
    act(() => result.current.setSuccessSignal("local signal to copy"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(result.current.scopeMovedHref).toBe("/goals/goal-1");
    expect(result.current.body).toBe("local body to copy");
    expect(result.current.state).toEqual({
      kind: "failed",
      errorCode: "AUTOSAVE_SCOPE_MOVED",
    });
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "local body to copy",
        successSignal: "local signal to copy",
      }),
    );

    act(() => result.current.retry());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).toHaveBeenCalledOnce();
    expect(loadLatest).toHaveBeenCalledOnce();
    expect(deleteBrowserDraftIfUnchanged).not.toHaveBeenCalled();
  });

  it("moves scope on an exact direct save error without fetching or retrying the stale PATCH", async () => {
    vi.useFakeTimers();
    const moved = new APIError(
      404,
      "GOAL_DRAFT_NOT_FOUND",
      "draft ended",
      "request-direct-moved",
    );
    const save = vi.fn().mockRejectedValue(moved);
    const loadLatest = vi
      .fn()
      .mockResolvedValue({ body: "other", revision: 2 });
    const { result } = renderHook(() =>
      useDraftAutoSave({
        ...input(save, loadLatest),
        scopeMovedOnError: (error: unknown) => (error === moved ? "/" : null),
      }),
    );
    await act(async () => undefined);

    act(() => result.current.setBody("local body from ended scope"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(result.current.scopeMovedHref).toBe("/");
    expect(result.current.body).toBe("local body from ended scope");
    expect(result.current.state).toEqual({
      kind: "failed",
      errorCode: "AUTOSAVE_SCOPE_MOVED",
    });
    expect(loadLatest).not.toHaveBeenCalled();
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({ body: "local body from ended scope" }),
    );

    act(() => result.current.retry());
    act(() => window.dispatchEvent(new Event("online")));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).toHaveBeenCalledOnce();
    expect(deleteBrowserDraftIfUnchanged).not.toHaveBeenCalled();
  });

  it("does not enter revision recovery for an unrelated 409 code", async () => {
    vi.useFakeTimers();
    const unrelatedConflict = new APIError(
      409,
      "GOAL_DRAFT_REVISION_CONFLICT",
      "different resource conflict",
      "request-unrelated",
    );
    const save = vi.fn().mockRejectedValue(unrelatedConflict);
    const loadLatest = vi.fn().mockResolvedValue({
      body: "other device",
      revision: 7,
    });
    const { result } = renderHook(() =>
      useDraftAutoSave(input(save, loadLatest)),
    );

    act(() => result.current.setBody("local edit"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(result.current.state.kind).toBe("failed");
    expect(result.current.revisionConflictActive).toBe(false);
    expect(result.current.recoveryConflict).toBeNull();
    expect(loadLatest).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).toHaveBeenCalledOnce();
    expect(loadLatest).not.toHaveBeenCalled();
  });

  it("keeps a newer edit and saves it from the refreshed revision after same-snapshot convergence", async () => {
    vi.useFakeTimers();
    const first = deferred<{ body: string; revision: number }>();
    const conflict = new APIError(
      409,
      "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
      "conflict",
      "request-1",
    );
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ body: "newer edit", revision: 8 });
    const loadLatest = vi
      .fn()
      .mockResolvedValue({ body: "submitted snapshot", revision: 7 });
    const { result } = renderHook(() =>
      useDraftAutoSave(input(save, loadLatest)),
    );

    act(() => result.current.setBody("submitted snapshot"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    act(() => result.current.setBody("newer edit"));
    await act(async () => first.reject(conflict));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(loadLatest).toHaveBeenCalledOnce();
    expect(save).toHaveBeenNthCalledWith(
      2,
      "newer edit",
      7,
      expect.any(AbortSignal),
    );
    expect(result.current.body).toBe("newer edit");
    expect(result.current.revision).toBe(8);
    expect(result.current.state.kind).toBe("saved");
  });

  it("resumes the latest fetch on online without resending a stale save", async () => {
    vi.useFakeTimers();
    const conflict = new APIError(
      409,
      "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
      "conflict",
      "request-1",
    );
    const save = vi.fn().mockRejectedValue(conflict);
    const loadLatest = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ body: "other device", revision: 7 });
    const { result } = renderHook(() =>
      useDraftAutoSave(input(save, loadLatest)),
    );

    act(() => result.current.setBody("local edit"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(result.current.revisionConflictActive).toBe(true);
    expect(result.current.resolvingConflict).toBe(false);
    expect(result.current.recoveryConflict).toBeNull();
    expect(save).toHaveBeenCalledOnce();

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(loadLatest).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledOnce();
    expect(result.current.recoveryConflict?.body).toBe("local edit");
  });

  it("keeps a conflicted local edit and rebases it only after explicit recovery", async () => {
    vi.useFakeTimers();
    const conflict = new APIError(
      409,
      "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
      "conflict",
      "request-1",
    );
    const save = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ body: "local edit", revision: 8 });
    const loadLatest = vi
      .fn()
      .mockResolvedValue({ body: "other device", revision: 7 });
    const { result } = renderHook(() =>
      useDraftAutoSave(input(save, loadLatest)),
    );

    act(() => result.current.setBody("local edit"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(async () => undefined);

    expect(loadLatest).toHaveBeenCalledOnce();
    expect(result.current.body).toBe("local edit");
    expect(result.current.revision).toBe(7);
    expect(result.current.recoveryConflict?.body).toBe("local edit");
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({ body: "local edit", baseRevision: 0 }),
    );
    await act(async () => undefined);
    expect(deleteBrowserDraft).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).toHaveBeenCalledOnce();

    act(() => result.current.restoreRecovery());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenNthCalledWith(
      2,
      "local edit",
      7,
      expect.any(AbortSignal),
    );
    expect(result.current.state.kind).toBe("saved");
  });

  it("enqueues a dirty save immediately on blur", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ body: "blurred", revision: 1 });
    const { result } = renderHook(() => useDraftAutoSave(input(save)));
    await act(async () => undefined);

    act(() => result.current.setBody("blurred"));
    act(() => result.current.flush());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith("blurred", 0, expect.any(AbortSignal));
  });

  it.each([
    { status: 400, code: "VALIDATION_ERROR" },
    { status: 401, code: "SESSION_EXPIRED" },
    { status: 403, code: "CSRF_INVALID" },
    { status: 409, code: "GOAL_STATE_CONFLICT" },
  ] as const)(
    "does not resend a non-retryable $status failure on an online event",
    async ({ status, code }) => {
      vi.useFakeTimers();
      const save = vi
        .fn()
        .mockRejectedValue(new APIError(status, code, "blocked", "request-1"));
      const { result } = renderHook(() => useDraftAutoSave(input(save)));

      act(() => result.current.setBody("blocked edit"));
      await act(() => vi.advanceTimersByTimeAsync(800));
      expect(result.current.state.kind).toBe("failed");
      expect(save).toHaveBeenCalledOnce();

      act(() => window.dispatchEvent(new Event("online")));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(save).toHaveBeenCalledOnce();
    },
  );
});
