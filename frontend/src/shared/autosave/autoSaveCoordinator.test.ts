import { act } from "@testing-library/react";

import { APIError } from "../api/client";
import {
  AutoSaveCoordinator,
  type AutoSaveCoordinatorOptions,
} from "./autoSaveCoordinator";

type Result = { readonly value: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function coordinator(
  save: (
    entry: { readonly key: string; readonly value: string },
    signal: AbortSignal,
  ) => Promise<Result>,
  overrides: Partial<AutoSaveCoordinatorOptions<string, string, Result>> = {},
) {
  return new AutoSaveCoordinator<string, string, Result>({
    initialValues: new Map([
      ["plan", "A"],
      ["do", "D0"],
    ]),
    save,
    savedValue: (result) => result.value,
    ...overrides,
  });
}

describe("AutoSaveCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reconciles a reversion against the successful in-flight snapshot", async () => {
    const first = deferred<Result>();
    const second = deferred<Result>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const core = coordinator(save);

    core.edit("plan", "B");
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenNthCalledWith(
      1,
      { key: "plan", value: "B" },
      expect.any(AbortSignal),
    );

    core.edit("plan", "A");
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledOnce();

    first.resolve({ value: "B" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenNthCalledWith(
      2,
      { key: "plan", value: "A" },
      expect.any(AbortSignal),
    );
    expect(core.getState().kind).toBe("saving");

    second.resolve({ value: "A" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(core.getState()).toEqual({ kind: "saved" });
  });

  it("keeps the latest reversion after an ambiguous failure", async () => {
    const first = deferred<Result>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ value: "A" });
    const core = coordinator(save);

    core.edit("plan", "B");
    await act(() => vi.advanceTimersByTimeAsync(800));
    core.edit("plan", "A");
    first.reject(new Error("invalid response"));
    await act(() => vi.advanceTimersByTimeAsync(800));

    expect(save).toHaveBeenNthCalledWith(
      2,
      { key: "plan", value: "A" },
      expect.any(AbortSignal),
    );
  });

  it("serializes different keys and coalesces each key to its latest value", async () => {
    const first = deferred<Result>();
    let active = 0;
    let maxActive = 0;
    const save = vi
      .fn()
      .mockImplementationOnce(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const result = await first.promise;
        active -= 1;
        return result;
      })
      .mockImplementationOnce(async (entry: { readonly value: string }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return { value: entry.value };
      });
    const core = coordinator(save);

    core.edit("plan", "P1");
    await act(() => vi.advanceTimersByTimeAsync(800));
    core.edit("do", "D1");
    core.edit("do", "D2");
    core.flush("do");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenCalledOnce();

    first.resolve({ value: "P1" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(save).toHaveBeenNthCalledWith(
      2,
      { key: "do", value: "D2" },
      expect.any(AbortSignal),
    );
    expect(maxActive).toBe(1);
  });

  it("does not reclassify a failed key when another key changes in flight", async () => {
    const first = deferred<Result>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (entry: { readonly value: string }) => ({
        value: entry.value,
      }));
    const core = coordinator(save);

    core.edit("plan", "invalid plan");
    await act(() => vi.advanceTimersByTimeAsync(800));
    core.edit("do", "new do");
    first.reject(
      new APIError(400, "VALIDATION_ERROR", "blocked", "request-other-key"),
    );
    await act(async () => undefined);
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(save).toHaveBeenCalledOnce();
    expect(core.getState()).toEqual({
      kind: "failed",
      errorCode: "VALIDATION_ERROR",
    });
  });

  it("preserves one key's retry backoff and limit while another key changes", async () => {
    const save = vi.fn().mockRejectedValue(new TypeError("network"));
    const core = coordinator(save, { random: () => 0.5 });

    core.edit("plan", "offline plan");
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledTimes(1);

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (const [index, delay] of delays.entries()) {
      await act(() => vi.advanceTimersByTimeAsync(delay / 2));
      core.edit("do", `other edit ${index + 1}`);
      await act(() => vi.advanceTimersByTimeAsync(delay / 2));
      expect(save).toHaveBeenNthCalledWith(
        index + 2,
        { key: "plan", value: "offline plan" },
        expect.any(AbortSignal),
      );
    }

    expect(save).toHaveBeenCalledTimes(6);
    expect(core.getState()).toEqual({
      kind: "failed",
      errorCode: "NETWORK_ERROR",
    });
  });

  it("continues retryable route-change saves after detach", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ value: "route edit" });
    const core = coordinator(save, { random: () => 0.5 });

    core.edit("plan", "route edit");
    core.detach();
    await act(async () => undefined);
    expect(save).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 400, code: "VALIDATION_ERROR" },
    { status: 401, code: "SESSION_EXPIRED" },
    { status: 403, code: "CSRF_INVALID" },
    { status: 409, code: "GOAL_STATE_CONFLICT" },
  ] as const)(
    "does not restart non-retryable $status failures when online",
    async ({ status, code }) => {
      const save = vi
        .fn()
        .mockRejectedValue(new APIError(status, code, "blocked", "request-1"));
      const core = coordinator(save);

      core.edit("plan", "B");
      await act(() => vi.advanceTimersByTimeAsync(800));
      expect(core.getState()).toEqual({ kind: "failed", errorCode: code });
      core.online();
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(save).toHaveBeenCalledOnce();
    },
  );

  it("keeps browser recovery for a reversion while another value is in flight", async () => {
    const first = deferred<Result>();
    const persist = vi.fn().mockResolvedValue(undefined);
    const clearPersisted = vi.fn().mockResolvedValue(undefined);
    const core = coordinator(() => first.promise, {
      persist,
      clearPersisted,
    });

    core.edit("plan", "B");
    await act(() => vi.advanceTimersByTimeAsync(800));
    core.edit("plan", "A");
    await act(() => vi.advanceTimersByTimeAsync(150));

    expect(persist).toHaveBeenLastCalledWith("plan", "A");
    expect(clearPersisted).not.toHaveBeenCalledWith("plan");
  });

  it("aborts an in-flight request and fences its late success", async () => {
    const request = deferred<Result>();
    let signal: AbortSignal | undefined;
    const onSaved = vi.fn();
    const core = coordinator(
      (_entry, requestSignal) => {
        signal = requestSignal;
        return request.promise;
      },
      { onSaved },
    );

    core.edit("plan", "B");
    core.flush();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(signal?.aborted).toBe(false);

    core.pause(true);
    expect(signal?.aborted).toBe(true);
    request.resolve({ value: "B" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("resends the latest value after a paused request resolves late", async () => {
    const first = deferred<Result>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ value: "latest after pause" });
    const onSaved = vi.fn();
    const core = coordinator(save, { onSaved });

    core.edit("plan", "in flight");
    core.flush("plan");
    await act(() => vi.advanceTimersByTimeAsync(0));
    core.edit("plan", "latest after pause");
    core.pause(true);
    core.resume();

    first.resolve({ value: "in flight" });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onSaved).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(
      { key: "plan", value: "latest after pause" },
      { value: "latest after pause" },
    );
    expect(save).toHaveBeenNthCalledWith(
      2,
      { key: "plan", value: "latest after pause" },
      expect.any(AbortSignal),
    );
  });

  it.each([
    {
      name: "discard",
      stop: (core: AutoSaveCoordinator<string, string, Result>) =>
        core.discard(),
    },
    {
      name: "quiesce",
      stop: (core: AutoSaveCoordinator<string, string, Result>) =>
        core.quiesce(true),
    },
  ])("does not requeue a late completion after $name", async ({ stop }) => {
    const request = deferred<Result>();
    const save = vi.fn().mockImplementationOnce(() => request.promise);
    const onSaved = vi.fn();
    const core = coordinator(save, { onSaved });

    core.edit("plan", "terminal stop");
    core.flush("plan");
    await act(() => vi.advanceTimersByTimeAsync(0));
    await stop(core);

    request.resolve({ value: "terminal stop" });
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(save).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(core.hasPending()).toBe(false);
  });

  it("deletes and does not resend when discard aborts an in-flight value", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const clearPersisted = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn(
      (
        _entry: { readonly key: string; readonly value: string },
        signal: AbortSignal,
      ) =>
        new Promise<Result>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const core = coordinator(save, { persist, clearPersisted });

    core.edit("plan", "discarded");
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledOnce();
    persist.mockClear();
    clearPersisted.mockClear();

    await core.discard();

    expect(persist).not.toHaveBeenCalled();
    expect(clearPersisted).toHaveBeenCalledWith("plan", "discarded");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(save).toHaveBeenCalledOnce();
    expect(core.hasPending()).toBe(false);
  });

  it("does not requeue a late completion after its identity signal aborts", async () => {
    const request = deferred<Result>();
    const parent = new AbortController();
    const save = vi.fn().mockImplementationOnce(() => request.promise);
    const core = coordinator(save, { signal: parent.signal });

    core.edit("plan", "old identity");
    core.flush("plan");
    await act(() => vi.advanceTimersByTimeAsync(0));
    parent.abort();

    request.resolve({ value: "old identity" });
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(save).toHaveBeenCalledOnce();
    expect(core.hasPending()).toBe(false);
  });

  it("keeps the entry queued when the error callback itself fails", async () => {
    const save = vi
      .fn()
      .mockRejectedValue(
        new APIError(
          409,
          "GOAL_DRAFT_REVISION_CONFLICT",
          "conflict",
          "request-handler",
        ),
      );
    const onError = vi.fn().mockRejectedValue(new TypeError("recovery fetch"));
    const core = coordinator(save, { onError, random: () => 0.5 });

    core.edit("plan", "B");
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(onError).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("starts a dirty route-change save before detach returns", () => {
    const save = vi.fn().mockResolvedValue({ value: "B" });
    const core = coordinator(save);

    core.edit("plan", "B");
    core.detach();

    expect(save).toHaveBeenCalledWith(
      { key: "plan", value: "B" },
      expect.any(AbortSignal),
    );
  });

  it("keeps the 800ms debounce after ordinary hydration recovery", async () => {
    const save = vi.fn().mockResolvedValue({ value: "hydrated recovery" });
    const core = coordinator(save, { initiallyHydrating: true });

    core.edit("plan", "hydrated recovery");
    core.finishHydration();
    await act(() => vi.advanceTimersByTimeAsync(799));
    expect(save).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(save).toHaveBeenCalledWith(
      { key: "plan", value: "hydrated recovery" },
      expect.any(AbortSignal),
    );
  });

  it.each([
    {
      name: "blur flush",
      requestImmediateSave: (
        core: AutoSaveCoordinator<string, string, Result>,
      ) => core.flush("plan"),
    },
    {
      name: "route detach",
      requestImmediateSave: (
        core: AutoSaveCoordinator<string, string, Result>,
      ) => core.detach(),
    },
  ])(
    "starts a hydrated dirty save at 0ms after a pending $name",
    async ({ requestImmediateSave }) => {
      const save = vi.fn().mockResolvedValue({ value: "hydrated edit" });
      const core = coordinator(save, { initiallyHydrating: true });

      core.edit("plan", "hydrated edit");
      requestImmediateSave(core);
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(save).not.toHaveBeenCalled();

      core.finishHydration();
      expect(save).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(save).toHaveBeenCalledWith(
        { key: "plan", value: "hydrated edit" },
        expect.any(AbortSignal),
      );
    },
  );
});
