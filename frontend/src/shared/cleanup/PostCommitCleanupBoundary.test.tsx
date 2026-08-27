import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useLayoutEffect, useState } from "react";

import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
  type AutoSaveScopeLease,
} from "../autosave/AutoSaveScopeProvider";

import { PostCommitCleanupBoundary } from "./PostCommitCleanupBoundary";
import {
  usePostCommitCleanup,
  type PostCommitCleanupTask,
  type PostCommitSessionOperationRunner,
  type PostCommitSessionOwnershipToken,
} from "./postCommitCleanupContext";

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
          <PostCommitCleanupBoundary
            runSessionOperation={runCurrentSessionOperation}
          >
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
    expect(await screen.findByText("completed route")).toBeInTheDocument();
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
          <PostCommitCleanupBoundary
            runSessionOperation={runCurrentSessionOperation}
          >
            <QuiesceTrigger
              cleanup={cleanup}
              lateWrite={lateWrite.promise}
              events={events}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    const commitButton = screen.getByRole("button", { name: "commit" });
    await userEvent.click(commitButton);

    await waitFor(() => expect(events).toContain("write-start"));
    expect(commitButton.closest("div[hidden][inert]")).not.toBeNull();
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
          <PostCommitCleanupBoundary
            runSessionOperation={runCurrentSessionOperation}
          >
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
  it("holds the session queue through cleanup and awaited success before recovery", async () => {
    const cleanupGate = deferred<void>();
    const successGate = deferred<void>();
    const events: string[] = [];
    const queue = createSerialQueue();
    const runSessionOperation: PostCommitSessionOperationRunner = (
      _expectedUserId,
      operation,
    ) =>
      queue.enqueue(async () => {
        events.push("ownership-start");
        const result = await operation(() => true);
        events.push("ownership-end");
        return result;
      });

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
            <TaskTrigger
              label="committed task"
              task={{
                expectedUserId: "user-1",
                cleanup: async () => {
                  events.push("cleanup-start");
                  await cleanupGate.promise;
                  events.push("cleanup-finish");
                },
                onSuccess: async () => {
                  events.push("success-start");
                  await successGate.promise;
                  events.push("success-finish");
                },
                pendingMessage: "pending",
                failureMessage: "failed",
              }}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "committed task" }),
    );
    await waitFor(() =>
      expect(events).toEqual(["ownership-start", "cleanup-start"]),
    );

    const recovery = queue.enqueue(async () => {
      events.push("recovery");
    });
    cleanupGate.resolve();
    await waitFor(() => expect(events).toContain("success-start"));
    expect(events).not.toContain("recovery");

    await act(async () => {
      successGate.resolve();
      await recovery;
    });
    expect(events).toEqual([
      "ownership-start",
      "cleanup-start",
      "cleanup-finish",
      "success-start",
      "success-finish",
      "ownership-end",
      "recovery",
    ]);
  });

  it("keeps recovery queued while failed cleanup remains retryable", async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn(() => {
      events.push("success");
    });
    const runSessionOperation: PostCommitSessionOperationRunner = (
      _expectedUserId,
      operation,
    ) => queue.enqueue(() => operation(() => true));

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
            <TaskTrigger
              label="failed cleanup task"
              task={{
                expectedUserId: "user-1",
                cleanup,
                onSuccess,
                pendingMessage: "pending",
                failureMessage: "cleanup failed",
                retryLabel: "retry cleanup",
              }}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "failed cleanup task" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cleanup failed",
    );

    const recovery = queue.enqueue(async () => {
      events.push("recovery");
    });
    await Promise.resolve();
    expect(events).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "retry cleanup" }),
    );
    await recovery;
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(events).toEqual(["success", "recovery"]);
  });

  it("cleans the captured old-user data without quiescing or publishing old success after identity change", async () => {
    const events: string[] = [];
    const leaseBoxRef: { current?: AutoSaveScopeLease } = {};
    const runSessionOperation: PostCommitSessionOperationRunner = (
      _expectedUserId,
      operation,
    ) => operation(() => false);

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
            <IdentityMismatchTrigger
              events={events}
              leaseBoxRef={leaseBoxRef}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "old-user committed task" }),
    );

    await waitFor(() => expect(events).toEqual(["old-cleanup"]));
    expect(events).not.toContain("quiesce");
    expect(events).not.toContain("old-success");
    expect(leaseBoxRef.current?.isCurrent()).toBe(true);
  });

  it("rechecks session ownership after cleanup before publishing success", async () => {
    const cleanupGate = deferred<void>();
    let identityCurrent = true;
    const runSessionOperation: PostCommitSessionOperationRunner = (
      _expectedUserId,
      operation,
    ) => operation(() => identityCurrent);
    const cleanup = vi.fn(async () => {
      await cleanupGate.promise;
    });
    const onSuccess = vi.fn(async () => undefined);
    const completion = vi.fn();

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
            <TaskTrigger
              label="dynamic ownership task"
              task={{
                expectedUserId: "user-1",
                cleanup,
                onSuccess,
                pendingMessage: "dynamic pending",
                failureMessage: "dynamic failed",
              }}
              onCompletion={completion}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "dynamic ownership task" }),
    );
    await waitFor(() => expect(cleanup).toHaveBeenCalledOnce());

    identityCurrent = false;
    cleanupGate.resolve();

    await waitFor(() => expect(completion).toHaveBeenCalledOnce());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "dynamic ownership task" }),
    ).toBeVisible();
  });

  it("keeps the ownership predicate live throughout awaited success work", async () => {
    const successStarted = deferred<void>();
    const releaseSuccess = deferred<void>();
    let identityCurrent = true;
    const lateEffects: string[] = [];
    const runSessionOperation: PostCommitSessionOperationRunner = (
      _expectedUserId,
      operation,
    ) => operation(() => identityCurrent);
    const onSuccess = vi.fn(
      async (identityIsCurrent?: () => boolean): Promise<void> => {
        successStarted.resolve();
        await releaseSuccess.promise;
        if (identityIsCurrent?.() ?? true) lateEffects.push("late-success");
      },
    );
    const completion = vi.fn();

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
            <TaskTrigger
              label="awaited success task"
              task={{
                expectedUserId: "user-1",
                cleanup: async () => undefined,
                onSuccess,
                pendingMessage: "awaited success pending",
                failureMessage: "awaited success failed",
              }}
              onCompletion={completion}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "awaited success task" }),
    );
    await successStarted.promise;

    identityCurrent = false;
    releaseSuccess.resolve();

    await waitFor(() => expect(completion).toHaveBeenCalledOnce());
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(lateEffects).toEqual([]);
  });

  it("uses an existing terminal ownership token without entering the session queue again", async () => {
    const runSessionOperation =
      vi.fn() as unknown as PostCommitSessionOperationRunner;
    const cleanup = vi.fn(async () => undefined);
    const onSuccess = vi.fn(async () => undefined);
    const ownership = Object.freeze({
      isCurrent: () => true,
    }) as PostCommitSessionOwnershipToken;

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
            <TaskTrigger
              label="terminal task"
              task={{
                expectedUserId: "user-1",
                sessionOwnership: ownership,
                cleanup,
                onSuccess,
                pendingMessage: "terminal pending",
                failureMessage: "terminal failed",
                retainTerminalOnSuccess: true,
              }}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "terminal task" }),
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledOnce();
    expect(runSessionOperation).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("terminal pending");
  });

  it("releases retained terminal ownership when identity changes during cleanup", async () => {
    const cleanupGate = deferred<void>();
    let identityCurrent = true;
    const runSessionOperation =
      vi.fn() as unknown as PostCommitSessionOperationRunner;
    const cleanup = vi.fn(async () => {
      await cleanupGate.promise;
    });
    const onSuccess = vi.fn(async () => undefined);
    const terminalReleased = vi.fn();
    const ownership = Object.freeze({
      isCurrent: () => identityCurrent,
    }) as PostCommitSessionOwnershipToken;

    render(
      <AutoSaveScopeProvider>
        <MemoryRouter>
          <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
            <TaskTrigger
              label="identity-changing terminal task"
              task={{
                expectedUserId: "user-1",
                sessionOwnership: ownership,
                cleanup,
                onSuccess,
                pendingMessage: "identity-changing pending",
                failureMessage: "identity-changing failed",
                retainTerminalOnSuccess: true,
              }}
              onCompletion={terminalReleased}
            />
          </PostCommitCleanupBoundary>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "identity-changing terminal task" }),
    );
    await waitFor(() => expect(cleanup).toHaveBeenCalledOnce());

    identityCurrent = false;
    cleanupGate.resolve();

    await expect(
      screen.findByRole("button", { name: "identity-changing terminal task" }),
    ).resolves.toBeVisible();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(runSessionOperation).not.toHaveBeenCalled();
    expect(terminalReleased).toHaveBeenCalledOnce();
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
        void runPostCommitCleanup({
          expectedUserId: "user-1",
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
          void runPostCommitCleanup({
            expectedUserId: "user-1",
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
          void runPostCommitCleanup({
            expectedUserId: "user-1",
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
          void runPostCommitCleanup({
            expectedUserId: "user-1",
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

function TaskTrigger({
  label,
  task,
  onCompletion,
}: {
  readonly label: string;
  readonly task: PostCommitCleanupTask;
  readonly onCompletion?: () => void;
}) {
  const runPostCommitCleanup = usePostCommitCleanup();
  return (
    <button
      type="button"
      onClick={() => {
        void runPostCommitCleanup(task).then(onCompletion);
      }}
    >
      {label}
    </button>
  );
}

function IdentityMismatchTrigger({
  events,
  leaseBoxRef,
}: {
  readonly events: string[];
  readonly leaseBoxRef: { current?: AutoSaveScopeLease };
}) {
  const registry = useAutoSaveScopeRegistry();
  const [lease] = useState(() => registry.prepare("new-user-scope"));

  useLayoutEffect(() => {
    leaseBoxRef.current = lease;
    lease.activate();
    const unregister = lease.onQuiesce(() => {
      events.push("quiesce");
    });
    return () => {
      unregister();
      if (leaseBoxRef.current === lease) {
        delete leaseBoxRef.current;
      }
    };
  }, [events, lease, leaseBoxRef]);

  return (
    <TaskTrigger
      label="old-user committed task"
      task={{
        expectedUserId: "old-user",
        cleanup: async () => {
          events.push("old-cleanup");
        },
        onSuccess: async () => {
          events.push("old-success");
        },
        pendingMessage: "pending",
        failureMessage: "failed",
      }}
    />
  );
}

function createSerialQueue() {
  let tail = Promise.resolve();
  return {
    enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
      const pending = tail.then(operation);
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
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

const runCurrentSessionOperation: PostCommitSessionOperationRunner = async (
  _expectedUserId,
  operation,
) => operation(() => true);
