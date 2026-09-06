import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { APIError } from "../../shared/api/client";
import {
  PostCommitCleanupContext,
  PostCommitRouteOwnershipContext,
  type PostCommitCleanupTask,
  type PostCommitRouteOwnershipToken,
  type RunPostCommitCleanup,
} from "../../shared/cleanup/postCommitCleanupContext";
import { tombstoneDeletedGoalAndClearDrafts } from "../../shared/drafts/browserDraftCache";
import { userQueryKeys } from "../goal-collection";
import {
  GoalDeletionAdvisoryContext,
  type GoalDeletionAdvisoryRegistry,
  type GoalDeletionCleanupClaim,
} from "./goalDeletionContext";
import {
  GoalDeletionFenceBoundary,
  useGoalDeletionEditorFence,
  useRunGoalDeletionFencedRequest,
} from "./GoalDeletionFenceBoundary";

vi.mock("../../shared/drafts/browserDraftCache", () => ({
  tombstoneDeletedGoalAndClearDrafts: vi.fn(),
}));

const userId = "00000000-0000-7000-8000-000000000001";
const goalId = "00000000-0000-7000-8000-000000000002";

beforeEach(() => {
  vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReset();
  vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockResolvedValue(undefined);
});

describe("GoalDeletionFenceBoundary", () => {
  it("fences editors before coalescing an exact local 404 and completes durable cleanup in order", async () => {
    const sequence: string[] = [];
    const deleted = new APIError(
      404,
      "GOAL_NOT_FOUND",
      "deleted",
      "request-deleted-goal",
    );
    const request = vi.fn(async () => {
      sequence.push("request");
      throw deleted;
    });
    const onRejected = vi.fn();
    const fence = vi.fn(() => sequence.push("fence"));
    const cleanup = createCleanupRunner(sequence);
    const advisory = createAdvisoryHarness({ sequence });
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockImplementation(
      async () => {
        sequence.push("tombstone");
      },
    );
    const cache = createCache();
    cache.setQueryData(userQueryKeys.goal(userId, goalId), { secret: true });
    cache.setQueryData(userQueryKeys.goals(userId, "active"), {
      secret: true,
    });

    renderBoundary({
      advisory,
      cache,
      cleanup,
      children: (
        <RequestProbe fence={fence} onRejected={onRejected} request={request} />
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "request" }));

    await waitFor(() => expect(onRejected).toHaveBeenCalledWith(deleted));
    expect(sequence).toEqual([
      "request",
      "fence",
      "begin",
      "publish",
      "run-cleanup",
    ]);
    expect(advisory.beginCleanup).toHaveBeenCalledOnce();
    expect(cleanup.run).toHaveBeenCalledOnce();
    expect(cleanup.task).toMatchObject({
      expectedUserId: userId,
      pendingMessage: "削除済みGoalのブラウザ下書きを削除しています…",
      failureMessage: "削除済みGoalのブラウザ下書きを削除できませんでした。",
      retryLabel: "ブラウザデータの削除を再試行",
    });

    fireEvent.click(screen.getByRole("button", { name: "request" }));
    await waitFor(() => expect(onRejected).toHaveBeenCalledTimes(2));
    expect(fence).toHaveBeenCalledTimes(2);
    expect(advisory.beginCleanup).toHaveBeenCalledOnce();
    expect(cleanup.run).toHaveBeenCalledOnce();

    await act(async () => {
      await cleanup.task.cleanup();
    });
    expect(sequence).toEqual([
      "request",
      "fence",
      "begin",
      "publish",
      "run-cleanup",
      "request",
      "fence",
      "tombstone",
      "publish",
    ]);
    expect(
      cache.getQueryData(userQueryKeys.goal(userId, goalId)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(userQueryKeys.goals(userId, "active")),
    ).toBeUndefined();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
    expect(advisory.complete).not.toHaveBeenCalled();

    await act(async () => {
      await cleanup.task.onSuccess(() => true);
    });
    expect(await screen.findByText("Home")).toBeInTheDocument();
    expect(advisory.activeSubscriberCount()).toBe(0);

    await act(async () => {
      cleanup.completion.resolve();
      await cleanup.completion.promise;
    });
    await waitFor(() => expect(advisory.complete).toHaveBeenCalledOnce());
  });

  it.each([
    new APIError(
      404,
      "CYCLE_NOT_FOUND",
      "cycle missing",
      "request-cycle-missing",
    ),
    new APIError(
      404,
      "INVALID_ERROR_RESPONSE",
      "generic missing",
      "request-generic-missing",
    ),
    new APIError(409, "GOAL_NOT_FOUND", "wrong status", "request-wrong-status"),
    new Error("network unavailable"),
  ])("rethrows %s without treating it as a deleted Goal", async (error) => {
    const request = vi.fn().mockRejectedValue(error);
    const onRejected = vi.fn();
    const fence = vi.fn();
    const cleanup = createCleanupRunner();
    const advisory = createAdvisoryHarness();
    renderBoundary({
      advisory,
      cleanup,
      children: (
        <RequestProbe fence={fence} onRejected={onRejected} request={request} />
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "request" }));

    await waitFor(() => expect(onRejected).toHaveBeenCalledWith(error));
    expect(fence).not.toHaveBeenCalled();
    expect(advisory.beginCleanup).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();
    expect(cleanup.run).not.toHaveBeenCalled();
  });

  it("uses one active advisory subscriber, isolates editor errors, and never echoes advisory cleanup", async () => {
    const sequence: string[] = [];
    const healthyFence = vi.fn(() => sequence.push("healthy-fence"));
    const brokenFence = vi.fn(() => {
      sequence.push("broken-fence");
      throw new Error("broken editor fence");
    });
    const cleanup = createCleanupRunner(sequence);
    const advisory = createAdvisoryHarness({ sequence });
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockImplementation(
      async () => {
        sequence.push("tombstone");
      },
    );

    const view = renderBoundary({
      advisory,
      cleanup,
      children: <EditorFences broken={brokenFence} healthy={healthyFence} />,
    });
    view.rerender(view.tree());
    expect(advisory.activeSubscriberCount()).toBe(1);

    expect(() => advisory.dispatch()).not.toThrow();

    expect(sequence).toEqual([
      "broken-fence",
      "healthy-fence",
      "begin",
      "run-cleanup",
    ]);
    expect(brokenFence).toHaveBeenCalledOnce();
    expect(healthyFence).toHaveBeenCalledOnce();
    expect(cleanup.run).toHaveBeenCalledOnce();
    expect(advisory.publish).not.toHaveBeenCalled();

    await act(async () => {
      await cleanup.task.cleanup();
    });
    expect(sequence).toContain("tombstone");
    expect(advisory.publish).not.toHaveBeenCalled();
  });

  it("joins tuple cleanup and navigates only after the shared completion", async () => {
    const joined = deferred<void>();
    const advisory = createAdvisoryHarness({
      claim: { kind: "joined", completion: joined.promise },
    });
    const cleanup = createCleanupRunner();
    const deleted = new APIError(
      404,
      "GOAL_NOT_FOUND",
      "deleted",
      "request-joined-goal",
    );
    const onRejected = vi.fn();
    renderBoundary({
      advisory,
      cleanup,
      children: (
        <RequestProbe
          fence={vi.fn()}
          onRejected={onRejected}
          request={() => Promise.reject(deleted)}
        />
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "request" }));
    await waitFor(() => expect(onRejected).toHaveBeenCalledWith(deleted));
    expect(screen.getByText("Goal route")).toBeInTheDocument();
    expect(cleanup.run).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();

    await act(async () => {
      joined.resolve();
      await joined.promise;
    });
    expect(await screen.findByText("Home")).toBeInTheDocument();
  });

  it("keeps the request-start route token and cannot steal a newer route after a late 404", async () => {
    const transport = deferred<void>();
    const joined = deferred<void>();
    const route = createRouteOwnership();
    const advisory = createAdvisoryHarness({
      claim: { kind: "joined", completion: joined.promise },
    });
    const cleanup = createCleanupRunner();
    const deleted = new APIError(
      404,
      "GOAL_NOT_FOUND",
      "deleted",
      "request-late-deleted-goal",
    );
    const onRejected = vi.fn();
    renderBoundary({
      advisory,
      cleanup,
      route,
      children: (
        <RequestProbe
          fence={vi.fn()}
          onRejected={onRejected}
          request={() => transport.promise}
        />
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "request" }));
    expect(route.capture).toHaveBeenCalledOnce();
    route.makeStale();
    await act(async () => {
      transport.reject(deleted);
    });
    await waitFor(() => expect(onRejected).toHaveBeenCalledWith(deleted));
    expect(advisory.beginCleanup).toHaveBeenCalledOnce();

    await act(async () => {
      joined.resolve();
      await joined.promise;
    });
    expect(screen.getByText("Goal route")).toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
  });

  it("holds the owner claim across local cleanup retry without retrying the witnessing request", async () => {
    const deleted = new APIError(
      404,
      "GOAL_NOT_FOUND",
      "deleted",
      "request-cleanup-retry",
    );
    const request = vi.fn().mockRejectedValue(deleted);
    const onRejected = vi.fn();
    const cleanup = createCleanupRunner();
    const advisory = createAdvisoryHarness();
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
      .mockResolvedValueOnce(undefined);
    renderBoundary({
      advisory,
      cleanup,
      children: (
        <RequestProbe
          fence={vi.fn()}
          onRejected={onRejected}
          request={request}
        />
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "request" }));
    await waitFor(() => expect(onRejected).toHaveBeenCalledOnce());

    await expect(cleanup.task.cleanup()).rejects.toThrow(
      "IndexedDB unavailable",
    );
    expect(advisory.complete).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();

    await cleanup.task.cleanup();
    expect(request).toHaveBeenCalledOnce();
    expect(advisory.beginCleanup).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(advisory.complete).not.toHaveBeenCalled();

    await act(async () => {
      cleanup.completion.resolve();
      await cleanup.completion.promise;
    });
    await waitFor(() => expect(advisory.complete).toHaveBeenCalledOnce());
  });
});

function RequestProbe({
  fence,
  onRejected,
  request,
}: {
  readonly fence: () => void;
  readonly onRejected: (error: unknown) => void;
  readonly request: () => Promise<unknown>;
}) {
  const runFencedRequest = useRunGoalDeletionFencedRequest();
  useGoalDeletionEditorFence(fence);
  return (
    <button
      type="button"
      onClick={() => {
        void runFencedRequest(request).catch(onRejected);
      }}
    >
      request
    </button>
  );
}

function EditorFences({
  broken,
  healthy,
}: {
  readonly broken: () => void;
  readonly healthy: () => void;
}) {
  useGoalDeletionEditorFence(broken);
  useGoalDeletionEditorFence(healthy);
  return <p>editors</p>;
}

type CleanupHarness = {
  readonly run: ReturnType<typeof vi.fn<RunPostCommitCleanup>>;
  readonly completion: Deferred<void>;
  readonly task: PostCommitCleanupTask;
};

function createCleanupRunner(sequence: string[] = []): CleanupHarness {
  const completion = deferred<void>();
  let task: PostCommitCleanupTask | undefined;
  const run = vi.fn<RunPostCommitCleanup>((nextTask) => {
    sequence.push("run-cleanup");
    task = nextTask;
    return completion.promise;
  });
  return {
    run,
    completion,
    get task() {
      if (task === undefined) throw new Error("cleanup has not started");
      return task;
    },
  };
}

type AdvisoryHarness = {
  readonly registry: GoalDeletionAdvisoryRegistry;
  readonly beginCleanup: ReturnType<
    typeof vi.fn<GoalDeletionAdvisoryRegistry["beginCleanup"]>
  >;
  readonly complete: ReturnType<typeof vi.fn<() => void>>;
  readonly publish: ReturnType<
    typeof vi.fn<GoalDeletionAdvisoryRegistry["publish"]>
  >;
  readonly activeSubscriberCount: () => number;
  readonly dispatch: () => void;
};

function createAdvisoryHarness(
  options: {
    readonly claim?: GoalDeletionCleanupClaim;
    readonly sequence?: string[];
  } = {},
): AdvisoryHarness {
  const listeners = new Set<() => void>();
  const ownerCompletion = deferred<void>();
  const complete = vi.fn(() => ownerCompletion.resolve());
  const claim: GoalDeletionCleanupClaim = options.claim ?? {
    kind: "owner",
    completion: ownerCompletion.promise,
    complete,
  };
  const publish = vi.fn<GoalDeletionAdvisoryRegistry["publish"]>(() => {
    options.sequence?.push("publish");
  });
  const subscribe = vi.fn<GoalDeletionAdvisoryRegistry["subscribe"]>(
    (_userId, _goalId, listener) => {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  );
  const beginCleanup = vi.fn<GoalDeletionAdvisoryRegistry["beginCleanup"]>(
    () => {
      options.sequence?.push("begin");
      return claim;
    },
  );
  return {
    registry: { beginCleanup, publish, subscribe },
    beginCleanup,
    complete,
    publish,
    activeSubscriberCount: () => listeners.size,
    dispatch: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

type RouteOwnershipHarness = {
  readonly capture: () => PostCommitRouteOwnershipToken;
  readonly makeStale: () => void;
};

function createRouteOwnership(): RouteOwnershipHarness {
  let current = true;
  const token = Object.freeze({
    isCurrent: () => current,
    waitUntilStale: () => Promise.resolve(),
  }) as PostCommitRouteOwnershipToken;
  return {
    capture: vi.fn(() => token),
    makeStale: () => {
      current = false;
    },
  };
}

function createCache(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function renderBoundary({
  advisory,
  cache = createCache(),
  children,
  cleanup,
  route = createRouteOwnership(),
}: {
  readonly advisory: AdvisoryHarness;
  readonly cache?: QueryClient;
  readonly children: ReactNode;
  readonly cleanup: CleanupHarness;
  readonly route?: RouteOwnershipHarness;
}) {
  const tree = () => (
    <QueryClientProvider client={cache}>
      <GoalDeletionAdvisoryContext.Provider value={advisory.registry}>
        <PostCommitRouteOwnershipContext.Provider value={route.capture}>
          <PostCommitCleanupContext.Provider value={cleanup.run}>
            <MemoryRouter initialEntries={["/goal"]}>
              <Routes>
                <Route
                  path="/goal"
                  element={
                    <GoalDeletionFenceBoundary userId={userId} goalId={goalId}>
                      <p>Goal route</p>
                      {children}
                    </GoalDeletionFenceBoundary>
                  }
                />
                <Route path="/" element={<p>Home</p>} />
              </Routes>
            </MemoryRouter>
          </PostCommitCleanupContext.Provider>
        </PostCommitRouteOwnershipContext.Provider>
      </GoalDeletionAdvisoryContext.Provider>
    </QueryClientProvider>
  );
  return { ...render(tree()), tree };
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
