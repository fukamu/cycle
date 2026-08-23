import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useLayoutEffect, useState } from "react";

import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
} from "../autosave/AutoSaveScopeProvider";

import { PostCommitCleanupBoundary } from "./PostCommitCleanupBoundary";
import { usePostCommitCleanup } from "./postCommitCleanupContext";

describe("PostCommitCleanupBoundary", () => {
  it("retries only the cleanup pipeline and restores the app after success", async () => {
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
      .mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn();

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter initialEntries={["/start"]}>
          <PostCommitCleanupBoundary>
            <Routes>
              <Route
                path="/start"
                element={
                  <CleanupTrigger cleanup={cleanup} onSuccess={onSuccess} />
                }
              />
              <Route path="/done" element={<p>completed route</p>} />
            </Routes>
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "server success" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ローカル完了処理に失敗しました",
    );
    expect(screen.queryByText("application route")).not.toBeInTheDocument();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "ローカル処理を再試行" }),
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(screen.getByText("completed route")).toBeInTheDocument();
    expect(screen.queryByText("application route")).not.toBeInTheDocument();
  });

  it("fences the active browser-operation tail before raw cleanup", async () => {
    const lateWrite = deferred<void>();
    const events: string[] = [];
    const cleanup = vi.fn(async () => {
      events.push("cleanup");
    });

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary>
            <QuiesceTrigger
              cleanup={cleanup}
              lateWrite={lateWrite.promise}
              events={events}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "commit" }));

    await waitFor(() => expect(events).toContain("write-start"));
    expect(cleanup).not.toHaveBeenCalled();

    lateWrite.resolve();

    await waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(events).toEqual(["write-start", "write-finish", "cleanup"]);
  });

  it("runs overlapping post-commit cleanups in a serial queue without dropping either task", async () => {
    const firstCleanupGate = deferred<void>();
    const events: string[] = [];

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary>
            <QueueTrigger gate={firstCleanupGate.promise} events={events} />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "two server successes" }),
    );

    await waitFor(() => expect(events).toEqual(["cleanup-1-start"]));
    firstCleanupGate.resolve();

    await waitFor(() =>
      expect(events).toEqual([
        "cleanup-1-start",
        "cleanup-1-finish",
        "success-1",
        "cleanup-2",
        "success-2",
      ]),
    );
    expect(screen.getByText("application route")).toBeInTheDocument();
  });
});

function QuiesceTrigger({
  cleanup,
  lateWrite,
  events,
}: {
  readonly cleanup: () => Promise<void>;
  readonly lateWrite: Promise<void>;
  readonly events: string[];
}) {
  const registry = useAutoSaveScopeRegistry();
  const runPostCommitCleanup = usePostCommitCleanup();
  const [lease] = useState(() => registry.prepare("test-scope"));

  useLayoutEffect(() => {
    lease.activate();
    return lease.onQuiesce(async ({ queueBrowserOperation }) => {
      await queueBrowserOperation(async () => {
        events.push("write-start");
        await lateWrite;
        events.push("write-finish");
      });
    });
  }, [events, lateWrite, lease]);

  return (
    <button
      type="button"
      onClick={() =>
        runPostCommitCleanup({
          cleanup,
          onSuccess: () => undefined,
          pendingMessage: "pending",
          failureMessage: "failed",
        })
      }
    >
      commit
    </button>
  );
}

function QueueTrigger({
  gate,
  events,
}: {
  readonly gate: Promise<void>;
  readonly events: string[];
}) {
  const runPostCommitCleanup = usePostCommitCleanup();
  return (
    <>
      <p>application route</p>
      <button
        type="button"
        onClick={() => {
          runPostCommitCleanup({
            cleanup: async () => {
              events.push("cleanup-1-start");
              await gate;
              events.push("cleanup-1-finish");
            },
            onSuccess: () => {
              events.push("success-1");
            },
            pendingMessage: "pending 1",
            failureMessage: "failed 1",
          });
          runPostCommitCleanup({
            cleanup: async () => {
              events.push("cleanup-2");
            },
            onSuccess: () => {
              events.push("success-2");
            },
            pendingMessage: "pending 2",
            failureMessage: "failed 2",
          });
        }}
      >
        two server successes
      </button>
    </>
  );
}

function CleanupTrigger({
  cleanup,
  onSuccess,
}: {
  readonly cleanup: () => Promise<void>;
  readonly onSuccess: () => void;
}) {
  const runPostCommitCleanup = usePostCommitCleanup();
  const navigate = useNavigate();
  return (
    <>
      <p>application route</p>
      <button
        type="button"
        onClick={() =>
          runPostCommitCleanup({
            cleanup,
            onSuccess: () => {
              onSuccess();
              navigate("/done");
            },
            pendingMessage: "ローカル完了処理中…",
            failureMessage: "ローカル完了処理に失敗しました",
            retryLabel: "ローカル処理を再試行",
          })
        }
      >
        server success
      </button>
    </>
  );
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
