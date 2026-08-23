import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";

import { AutoSaveCoordinator } from "./autoSaveCoordinator";
import {
  AutoSaveScopeProvider,
  type AutoSaveBrowserOperationQueue,
  type AutoSaveQuiesceCallback,
  type AutoSaveScopeRegistry,
  useAutoSaveScopeRegistry,
} from "./AutoSaveScopeProvider";

function wrapper({ children }: PropsWithChildren) {
  return <AutoSaveScopeProvider>{children}</AutoSaveScopeProvider>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function activateScope(registry: AutoSaveScopeRegistry, scopeKey: string) {
  const lease = registry.prepare(scopeKey);
  lease.activate();
  return lease;
}

describe("AutoSaveScopeProvider", () => {
  it("owns an isolated registry per provider", () => {
    const first = renderHook(() => useAutoSaveScopeRegistry(), { wrapper });
    const second = renderHook(() => useAutoSaveScopeRegistry(), { wrapper });

    expect(first.result.current).not.toBe(second.result.current);
  });

  it("aborts and invalidates the previous generation for one scope", () => {
    const { result } = renderHook(() => useAutoSaveScopeRegistry(), {
      wrapper,
    });
    const first = activateScope(result.current, "user-1:goal-draft-1");
    const otherScope = activateScope(result.current, "user-1:goal-draft-2");

    const second = result.current.prepare("user-1:goal-draft-1");

    expect(second.generation).toBe(0);
    expect(first.signal.aborted).toBe(false);
    expect(first.isCurrent()).toBe(true);

    second.activate();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(second.generation).toBe(first.generation + 1);
    expect(otherScope.signal.aborted).toBe(false);
    expect(otherScope.isCurrent()).toBe(true);
  });

  it("does not activate a prepared lease across identity quiescence", async () => {
    const { result } = renderHook(() => useAutoSaveScopeRegistry(), {
      wrapper,
    });
    const stale = result.current.prepare("user-1:goal-draft-1");

    await result.current.quiesce({ preserveDrafts: true });
    stale.activate();

    expect(stale.generation).toBe(0);
    expect(stale.signal.aborted).toBe(true);
    expect(stale.isCurrent()).toBe(false);

    const fresh = activateScope(result.current, "user-1:goal-draft-1");

    expect(fresh.generation).toBe(1);
    expect(fresh.signal.aborted).toBe(false);
    expect(fresh.isCurrent()).toBe(true);
  });

  it("finishes a scheduled browser write before a new generation read", async () => {
    const { result } = renderHook(() => useAutoSaveScopeRegistry(), {
      wrapper,
    });
    const releaseWrite = deferred<void>();
    const events: string[] = [];
    const first = activateScope(result.current, "user-1:goal-review-1");
    const write = first.queueBrowserOperation(async () => {
      events.push("write:start");
      await releaseWrite.promise;
      events.push("write:end");
      return "written";
    });
    await Promise.resolve();

    const second = activateScope(result.current, "user-1:goal-review-1");
    const staleOperation = vi.fn(async () => "stale");
    const staleResult = await first.queueBrowserOperation(staleOperation);
    const read = second.queueBrowserOperation(async () => {
      events.push("read");
      return "latest";
    });
    await Promise.resolve();

    expect(staleResult).toBeUndefined();
    expect(staleOperation).not.toHaveBeenCalled();
    expect(events).toEqual(["write:start"]);

    releaseWrite.resolve();

    await expect(write).resolves.toBe("written");
    await expect(read).resolves.toBe("latest");
    expect(events).toEqual(["write:start", "write:end", "read"]);
  });

  it("aborts completions but lets quiesce preservation finish before resolving", async () => {
    const { result } = renderHook(() => useAutoSaveScopeRegistry(), {
      wrapper,
    });
    const browserWriteStarted = deferred<void>();
    const releaseBrowserWrite = deferred<void>();
    const events: string[] = [];
    const lease = activateScope(result.current, "user-1:cycle-1");
    let lifecycleQueue: AutoSaveBrowserOperationQueue | undefined;
    lease.onQuiesce(async ({ preserveDrafts, queueBrowserOperation }) => {
      lifecycleQueue = queueBrowserOperation;
      events.push(String(preserveDrafts));
      await queueBrowserOperation(async () => {
        events.push("browser:start");
        browserWriteStarted.resolve();
        await releaseBrowserWrite.promise;
        events.push("browser:end");
      });
      events.push("lifecycle:end");
    });

    let quiesced = false;
    const quiesce = result.current
      .quiesce({ preserveDrafts: true })
      .then(() => {
        quiesced = true;
      });
    await browserWriteStarted.promise;
    const staleOperation = vi.fn(async () => "stale");

    const staleResult = await lease.queueBrowserOperation(staleOperation);

    expect(staleResult).toBeUndefined();
    expect(staleOperation).not.toHaveBeenCalled();
    expect(lease.signal.aborted).toBe(true);
    expect(lease.isCurrent()).toBe(false);
    expect(events).toEqual(["true", "browser:start"]);
    expect(quiesced).toBe(false);

    releaseBrowserWrite.resolve();
    await quiesce;

    expect(events).toEqual([
      "true",
      "browser:start",
      "browser:end",
      "lifecycle:end",
    ]);
    expect(quiesced).toBe(true);

    expect(lifecycleQueue).toBeTypeOf("function");
    if (!lifecycleQueue) throw new Error("lifecycle queue was not registered");
    const lateLifecycleOperation = vi.fn(async () => "late");

    const lateLifecycleResult = await lifecycleQueue(lateLifecycleOperation);

    expect(lateLifecycleResult).toBeUndefined();
    expect(lateLifecycleOperation).not.toHaveBeenCalled();
  });

  it.each(["reject", "resolve"] as const)(
    "preserves a dirty in-flight value when identity abort completion $completion precedes its lifecycle",
    async (completion) => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useAutoSaveScopeRegistry(), {
        wrapper,
      });
      const lease = activateScope(result.current, "user-1:goal-draft-1");
      const persist = vi.fn().mockResolvedValue(undefined);
      const clearPersisted = vi.fn().mockResolvedValue(undefined);
      const save = vi.fn(
        (
          _entry: { readonly key: string; readonly value: string },
          signal: AbortSignal,
        ) =>
          new Promise<{ readonly value: string }>((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                if (completion === "resolve") {
                  resolve({ value: "dirty" });
                  return;
                }
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      );
      const coordinator = new AutoSaveCoordinator({
        initialValues: new Map([["body", "saved"]]),
        save,
        savedValue: (saved) => saved.value,
        persist,
        clearPersisted,
        signal: lease.signal,
        isCurrent: lease.isCurrent,
      });
      lease.onQuiesce(({ preserveDrafts }) =>
        coordinator.quiesce(preserveDrafts),
      );

      coordinator.edit("body", "dirty");
      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenCalledOnce();
      persist.mockClear();
      clearPersisted.mockClear();

      await result.current.quiesce({ preserveDrafts: true });

      expect(persist).toHaveBeenCalledWith("body", "dirty");
      expect(clearPersisted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(save).toHaveBeenCalledOnce();
      vi.useRealTimers();
    },
  );

  it("deletes rather than resends an in-flight value when quiescence does not preserve drafts", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAutoSaveScopeRegistry(), {
      wrapper,
    });
    const lease = activateScope(result.current, "user-1:goal-draft-1");
    const persist = vi.fn().mockResolvedValue(undefined);
    const clearPersisted = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn(
      (
        _entry: { readonly key: string; readonly value: string },
        signal: AbortSignal,
      ) =>
        new Promise<{ readonly value: string }>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const coordinator = new AutoSaveCoordinator({
      initialValues: new Map([["body", "saved"]]),
      save,
      savedValue: (saved) => saved.value,
      persist,
      clearPersisted,
      signal: lease.signal,
      isCurrent: lease.isCurrent,
    });
    lease.onQuiesce(({ preserveDrafts }) =>
      coordinator.quiesce(preserveDrafts),
    );

    coordinator.edit("body", "dirty");
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledOnce();
    persist.mockClear();
    clearPersisted.mockClear();

    await result.current.quiesce({ preserveDrafts: false });

    expect(persist).not.toHaveBeenCalled();
    expect(clearPersisted).toHaveBeenCalledWith("body", "dirty");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("passes preserveDrafts=false to the registered lifecycle", async () => {
    const { result } = renderHook(() => useAutoSaveScopeRegistry(), {
      wrapper,
    });
    const lease = activateScope(result.current, "user-1:goal-draft-1");
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    lease.onQuiesce(lifecycle);

    await result.current.quiesce({ preserveDrafts: false });

    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        preserveDrafts: false,
        queueBrowserOperation: expect.any(Function),
      }),
    );
  });
});
