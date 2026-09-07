import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { GoalDeletionAdvisoryContext } from "../features/goal-deletion";
import type {
  GoalDeletionAdvisoryChannelLike,
  GoalDeletionAdvisoryRegistry,
  GoalDeletionCleanupOutcome,
} from "../features/goal-deletion";
import {
  SessionIdentityBoundary,
  SessionProvider,
} from "../features/auth/SessionProvider";
import { useRunPostCommitSessionOperation } from "../features/auth/sessionContext";
import { AuthenticatedSessionTestProvider } from "../test/AuthenticatedSessionTestProvider";
import { createCurrentAuthenticatedRequestLease } from "../test/authenticatedRequestLease";
import { APIError } from "../shared/api/client";
import type {
  CycleSummary,
  Goal,
  GoalVersion,
  Session,
} from "../shared/api/schemas";
import { AutoSaveScopeProvider } from "../shared/autosave/AutoSaveScopeProvider";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import {
  cleanupExpiredBrowserDrafts,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import { userQueryKeys } from "../features/goal-collection";
import { getGoal, listCycles } from "../shared/api/workspace";
import { GoalTimelinePage } from "./GoalTimelinePage";

vi.mock("../shared/api/workspace", () => ({
  getGoal: vi.fn(),
  listCycles: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  cleanupExpiredBrowserDrafts: vi.fn(),
  tombstoneDeletedGoalAndClearDrafts: vi.fn(),
}));

const goalId = "10000000-0000-7000-8000-000000000001";
const otherGoalId = "10000000-0000-7000-8000-000000000002";
const otherUserId = "00000000-0000-7000-8000-000000000002";
const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "A".repeat(43),
};

const sessionLease = createCurrentAuthenticatedRequestLease(session.user.id);

let notifyIntersection: IntersectionObserverCallback;

describe("GoalTimelinePage", () => {
  beforeEach(() => {
    vi.mocked(getGoal).mockReset();
    vi.mocked(listCycles).mockReset();
    vi.mocked(cleanupExpiredBrowserDrafts).mockReset();
    vi.mocked(cleanupExpiredBrowserDrafts).mockResolvedValue(undefined);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReset();
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockResolvedValue(undefined);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        readonly root = null;
        readonly rootMargin = "240px";
        readonly thresholds = [0];

        constructor(callback: IntersectionObserverCallback) {
          notifyIntersection = callback;
        }

        disconnect() {}
        observe() {}
        takeRecords() {
          return [];
        }
        unobserve() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["Goal", "Cycles"] as const)(
    "converges an initial %s strict 404 on the durable deletion fence",
    async (source) => {
      const cleanup = deferred<void>();
      vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValue(
        cleanup.promise,
      );
      vi.mocked(getGoal).mockImplementation(() =>
        source === "Goal"
          ? Promise.reject(deletedGoalError("request-initial-goal-deleted"))
          : Promise.resolve({ goal: makeGoal(1) }),
      );
      vi.mocked(listCycles).mockImplementation(() =>
        source === "Cycles"
          ? Promise.reject(deletedGoalError("request-initial-cycles-deleted"))
          : Promise.resolve({
              items: [makeCycle(1, 1)],
              nextCursor: null,
            }),
      );

      const { advisory } = renderTimeline();

      await waitFor(() =>
        expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
          session.user.id,
          goalId,
        ),
      );
      expect(
        screen.getByText("削除済みGoalのブラウザ下書きを削除しています…"),
      ).toBeVisible();
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
      expect(getGoal).toHaveBeenCalledOnce();
      expect(listCycles).toHaveBeenCalledOnce();
      expect(advisory.beginCleanup).toHaveBeenCalledOnce();
      expect(advisory.publish).toHaveBeenCalledOnce();
      await act(async () => cleanup.resolve());

      expect(await screen.findByText("ホーム")).toBeVisible();
      expect(screen.getByText("Goal cache削除済み")).toBeVisible();
      expect(advisory.publish).toHaveBeenCalledTimes(2);
    },
  );

  it("hands a failed subscriber-free cleanup to a late Timeline without exposing fresh cache", async () => {
    const privateGoalBody = "fallback中のprivate Timeline Goal本文";
    const privateCycleBody = "fallback中のprivate Timeline Cycle本文";
    const fallbackCleanup = deferred<void>();
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockReturnValueOnce(fallbackCleanup.promise)
      .mockRejectedValueOnce(new Error("private IndexedDB failure"))
      .mockResolvedValueOnce(undefined);
    const advisory = createGoalDeletionChannelHarness();
    const cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
      },
    });
    cache.setQueryData(userQueryKeys.goal(session.user.id, goalId), {
      goal: makeGoalWithBody(1, privateGoalBody),
    });
    cache.setQueryData(userQueryKeys.goalCycles(session.user.id, goalId), {
      pages: [
        {
          items: [makeCycleWithPreview(1, 1, privateCycleBody)],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          return Response.json(session, {
            headers: {
              "X-Fukamu-Authenticated-User-ID": session.user.id,
            },
          });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderLateTimelineWithSessionProvider({ advisory, cache });
    await screen.findByRole("link", { name: "削除済みGoal履歴を開く" });
    act(() => {
      advisory.dispatch({
        version: 1,
        deletedUserId: session.user.id,
        deletedGoalId: goalId,
      });
    });
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );

    const exposedPrivateContent = vi.fn();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const text = node.textContent ?? "";
          if (
            text.includes(privateGoalBody) ||
            text.includes(privateCycleBody)
          ) {
            exposedPrivateContent();
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    fireEvent.click(
      screen.getByRole("link", { name: "削除済みGoal履歴を開く" }),
    );
    await Promise.resolve();

    expect(exposedPrivateContent).not.toHaveBeenCalled();
    expect(screen.queryByText(privateGoalBody)).not.toBeInTheDocument();
    expect(screen.queryByText(privateCycleBody)).not.toBeInTheDocument();
    expect(getGoal).not.toHaveBeenCalled();
    expect(listCycles).not.toHaveBeenCalled();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();

    act(() => fallbackCleanup.reject(new Error("private fallback failure")));
    expect(
      await screen.findByText(
        "削除済みGoalのブラウザ下書きを削除できませんでした。",
      ),
    ).toBeVisible();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(exposedPrivateContent).not.toHaveBeenCalled();
    expect(advisory.postMessage).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    expect(
      await screen.findByRole("link", { name: "削除済みGoal履歴を開く" }),
    ).toBeVisible();
    observer.disconnect();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(3);
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goalId)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(userQueryKeys.goalCycles(session.user.id, goalId)),
    ).toBeUndefined();
    expect(getGoal).not.toHaveBeenCalled();
    expect(listCycles).not.toHaveBeenCalled();
    expect(advisory.postMessage).not.toHaveBeenCalled();
  });

  it.each(["goal-refetch", "cycles-refetch", "pagination"] as const)(
    "converges a strict 404 from %s without a second transport",
    async (stage) => {
      vi.mocked(getGoal)
        .mockResolvedValueOnce({ goal: makeGoal(2) })
        .mockRejectedValueOnce(
          deletedGoalError("request-goal-refetch-deleted"),
        );
      vi.mocked(listCycles)
        .mockResolvedValueOnce({
          items: [makeCycle(4, 2)],
          nextCursor: stage === "pagination" ? "older" : null,
        })
        .mockRejectedValueOnce(
          deletedGoalError(
            stage === "pagination"
              ? "request-pagination-deleted"
              : "request-cycles-refetch-deleted",
          ),
        );
      const { advisory, cache } = renderTimeline();
      await screen.findByText("GOAL V2");

      if (stage === "goal-refetch") {
        void cache.refetchQueries({
          queryKey: userQueryKeys.goal(session.user.id, goalId),
          exact: true,
        });
      } else if (stage === "cycles-refetch") {
        void cache.refetchQueries({
          queryKey: userQueryKeys.goalCycles(session.user.id, goalId),
          exact: true,
        });
      } else {
        triggerIntersection();
      }

      expect(await screen.findByText("ホーム")).toBeVisible();
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
      expect(advisory.beginCleanup).toHaveBeenCalledOnce();
      expect(advisory.publish).toHaveBeenCalledTimes(2);
      expect(getGoal).toHaveBeenCalledTimes(stage === "goal-refetch" ? 2 : 1);
      expect(listCycles).toHaveBeenCalledTimes(
        stage === "goal-refetch" ? 1 : 2,
      );
      if (stage === "pagination") {
        expect(listCycles).toHaveBeenLastCalledWith(
          sessionLease,
          goalId,
          "older",
          expect.any(AbortSignal),
        );
      }
    },
  );

  it("coalesces parallel strict witnesses into one tuple cleanup", async () => {
    const goalRequest = deferred<Awaited<ReturnType<typeof getGoal>>>();
    const cyclesRequest = deferred<Awaited<ReturnType<typeof listCycles>>>();
    const cleanup = deferred<void>();
    vi.mocked(getGoal).mockReturnValue(goalRequest.promise);
    vi.mocked(listCycles).mockReturnValue(cyclesRequest.promise);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValue(
      cleanup.promise,
    );
    const { advisory } = renderTimeline();
    await waitFor(() => {
      expect(getGoal).toHaveBeenCalledOnce();
      expect(listCycles).toHaveBeenCalledOnce();
    });

    await act(async () => {
      goalRequest.reject(deletedGoalError("request-parallel-goal-deleted"));
      cyclesRequest.reject(deletedGoalError("request-parallel-cycles-deleted"));
    });

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(advisory.beginCleanup).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledOnce();

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeVisible();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
  });

  it("synchronously hides and cancels Timeline work for an exact advisory without touching another tuple", async () => {
    const goalRefetch = deferred<Awaited<ReturnType<typeof getGoal>>>();
    const nextPage = deferred<Awaited<ReturnType<typeof listCycles>>>();
    const cleanup = deferred<void>();
    let goalRefetchSignal: AbortSignal | undefined;
    let nextPageSignal: AbortSignal | undefined;
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal: makeGoal(2) })
      .mockImplementationOnce((_lease, _goalId, signal) => {
        goalRefetchSignal = signal;
        return goalRefetch.promise;
      });
    vi.mocked(listCycles)
      .mockResolvedValueOnce({
        items: [makeCycle(4, 2)],
        nextCursor: "older",
      })
      .mockImplementationOnce((_lease, _goalId, _cursor, signal) => {
        nextPageSignal = signal;
        return nextPage.promise;
      });
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValue(
      cleanup.promise,
    );
    const { advisory, cache } = renderTimeline();
    await screen.findByText("GOAL V2");

    void cache.refetchQueries({
      queryKey: userQueryKeys.goal(session.user.id, goalId),
      exact: true,
    });
    triggerIntersection();
    await waitFor(() => {
      expect(getGoal).toHaveBeenCalledTimes(2);
      expect(listCycles).toHaveBeenCalledTimes(2);
    });
    expect(goalRefetchSignal?.aborted).toBe(false);
    expect(nextPageSignal?.aborted).toBe(false);

    act(() => {
      advisory.dispatch(session.user.id, otherGoalId);
      advisory.dispatch(otherUserId, goalId);
    });
    expect(screen.getByText("GOAL V2")).toBeVisible();
    expect(goalRefetchSignal?.aborted).toBe(false);
    expect(nextPageSignal?.aborted).toBe(false);
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();

    act(() => {
      advisory.dispatch(session.user.id, goalId);
      expect(screen.queryAllByText("GOAL V2")).toHaveLength(0);
      expect(goalRefetchSignal?.aborted).toBe(true);
      expect(nextPageSignal?.aborted).toBe(true);
    });

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
        session.user.id,
        goalId,
      ),
    );
    expect(advisory.beginCleanup).toHaveBeenCalledOnce();
    expect(advisory.publish).not.toHaveBeenCalled();
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goalId)),
    ).toBeDefined();
    expect(
      cache.getQueryData(userQueryKeys.goalCycles(session.user.id, goalId)),
    ).toBeDefined();

    await act(async () => {
      goalRefetch.resolve({ goal: makeGoalWithBody(2, "late Goal secret") });
      nextPage.resolve({
        items: [makeCycleWithPreview(2, 1, "late Cycle secret")],
        nextCursor: null,
      });
      await Promise.all([goalRefetch.promise, nextPage.promise]);
    });
    expect(
      JSON.stringify(
        cache.getQueryData(userQueryKeys.goal(session.user.id, goalId)),
      ),
    ).not.toContain("late Goal secret");
    expect(
      JSON.stringify(
        cache.getQueryData(userQueryKeys.goalCycles(session.user.id, goalId)),
      ),
    ).not.toContain("late Cycle secret");

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeVisible();
    expect(screen.getByText("Goal cache削除済み")).toBeVisible();
    expect(advisory.publish).not.toHaveBeenCalled();
  });

  it("retries only failed local cleanup after a strict witness", async () => {
    vi.mocked(getGoal).mockRejectedValue(
      deletedGoalError("request-cleanup-retry-deleted"),
    );
    vi.mocked(listCycles).mockResolvedValue({
      items: [makeCycle(1, 1)],
      nextCursor: null,
    });
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
      .mockResolvedValueOnce(undefined);
    const { advisory } = renderTimeline();

    expect(
      await screen.findByText(
        "削除済みGoalのブラウザ下書きを削除できませんでした。",
      ),
    ).toBeVisible();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(listCycles).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    expect(await screen.findByText("ホーム")).toBeVisible();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(listCycles).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(advisory.beginCleanup).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
  });

  it("cleans a late strict witness without taking over a newer route", async () => {
    const lateGoal = deferred<Awaited<ReturnType<typeof getGoal>>>();
    let lateSignal: AbortSignal | undefined;
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal: makeGoal(1) })
      .mockImplementationOnce((_lease, _goalId, signal) => {
        lateSignal = signal;
        return lateGoal.promise;
      });
    vi.mocked(listCycles).mockResolvedValue({
      items: [makeCycle(1, 1)],
      nextCursor: null,
    });
    const { advisory, cache } = renderTimeline({ routeSwitch: true });
    await screen.findByRole("heading", {
      level: 2,
      name: "Version 1の目標",
    });

    void cache.refetchQueries({
      queryKey: userQueryKeys.goal(session.user.id, goalId),
      exact: true,
    });
    await waitFor(() => expect(getGoal).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("link", { name: "別routeへ移動" }));
    expect(await screen.findByText("外部route")).toBeVisible();
    expect(lateSignal?.aborted).toBe(true);

    await act(async () => {
      lateGoal.reject(deletedGoalError("request-late-route-deleted"));
    });

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(screen.getByText("外部route")).toBeVisible());
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goalId)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(userQueryKeys.goalCycles(session.user.id, goalId)),
    ).toBeUndefined();
  });

  it("keeps a generic 404 on the ordinary initial error and retry path", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(1) });
    vi.mocked(listCycles)
      .mockRejectedValueOnce(
        new APIError(
          404,
          "CYCLE_NOT_FOUND",
          "not the deleted Goal contract",
          "request-generic-404",
        ),
      )
      .mockResolvedValueOnce({
        items: [makeCycle(1, 1)],
        nextCursor: null,
      });
    const { advisory } = renderTimeline();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "再試行",
      }),
    );

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Version 1の目標",
      }),
    ).toBeVisible();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(listCycles).toHaveBeenCalledTimes(2);
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
    expect(advisory.beginCleanup).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();
  });

  it("marks V2 as a revision when it is the first loaded segment", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(2) });
    vi.mocked(listCycles).mockResolvedValue({
      items: [makeCycle(4, 2)],
      nextCursor: null,
    });

    const { container } = renderTimeline();

    await screen.findByText("GOAL V2");
    const version = getVersion(container, 2);
    const event = getEvent(container, 2);
    expect(version).toHaveAttribute("data-version-kind", "revision");
    expect(version).toHaveAttribute("data-version-state", "current");
    expect(
      within(version).queryByText("目標を変更しました"),
    ).not.toBeInTheDocument();
    expect(within(event).getByText("目標を変更しました")).toBeVisible();
    expect(event).toHaveAttribute("data-timeline-event", "change");
    expect(event).toHaveAttribute("data-version-state", "current");
    expect(version.nextElementSibling).toBe(event);
    expect(event.querySelector(".timeline-event__marker")).toBeInTheDocument();
    expect(version.querySelector(".timeline-period__rail")).toBeInTheDocument();
    expect(screen.queryByText("GOAL V1")).not.toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledWith(
      sessionLease,
      goalId,
      expect.any(AbortSignal),
    );
    expect(listCycles).toHaveBeenCalledWith(
      sessionLease,
      goalId,
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("retries only the failed initial cycles query", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(1) });
    vi.mocked(listCycles)
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({
        items: [makeCycle(1, 1)],
        nextCursor: null,
      });

    const { advisory } = renderTimeline();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "再試行",
      }),
    );

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Version 1の目標",
      }),
    ).toBeVisible();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(listCycles).toHaveBeenCalledTimes(2);
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
    expect(advisory.beginCleanup).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();
  });

  it("marks the V1 period and creation event as current before any revision", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(1) });
    vi.mocked(listCycles).mockResolvedValue({
      items: [makeCycle(1, 1)],
      nextCursor: null,
    });

    const { container } = renderTimeline();

    await screen.findByRole("heading", {
      level: 2,
      name: "Version 1の目標",
    });
    expect(getVersion(container, 1)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    expect(getEvent(container, 1)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    expect(getEvent(container, 1)).toHaveAttribute(
      "data-timeline-event",
      "created",
    );
  });

  it.each([
    {
      label: "network failure",
      error: new TypeError("network"),
    },
    {
      label: "INVALID_CURSOR",
      error: new APIError(
        400,
        "INVALID_CURSOR",
        "invalid cursor",
        "request-invalid-cursor",
      ),
    },
  ])(
    "keeps loaded groups and coalesces duplicate retry clicks for a failed next page: $label",
    async ({ error }) => {
      vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(2) });
      vi.mocked(listCycles)
        .mockResolvedValueOnce({
          items: [makeCycle(4, 2)],
          nextCursor: "older",
        })
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({
          items: [makeCycle(2, 1)],
          nextCursor: null,
        });

      const { advisory } = renderTimeline();

      expect(await screen.findByText("GOAL V2")).toBeVisible();
      triggerIntersection();

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "続きを読み込めませんでした。",
      );
      expect(screen.getByText("GOAL V2")).toBeVisible();
      const retry = screen.getByRole("button", { name: "もう一度読み込む" });
      act(() => {
        fireEvent.click(retry);
        fireEvent.click(retry);
      });

      expect(
        await screen.findByRole("heading", {
          level: 2,
          name: "Version 1の目標",
        }),
      ).toBeVisible();
      expect(screen.getByText("GOAL V2")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(listCycles).toHaveBeenCalledTimes(3);
      expect(listCycles).toHaveBeenNthCalledWith(
        3,
        sessionLease,
        goalId,
        "older",
        expect.any(AbortSignal),
      );
      expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
      expect(advisory.beginCleanup).not.toHaveBeenCalled();
      expect(advisory.publish).not.toHaveBeenCalled();
    },
  );

  it("keeps V3 marked and merges version groups across older pages", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(3) });
    vi.mocked(listCycles)
      .mockResolvedValueOnce({
        items: [makeCycle(6, 3)],
        nextCursor: "older-1",
      })
      .mockResolvedValueOnce({
        items: [makeCycle(5, 3), makeCycle(4, 2)],
        nextCursor: "older-2",
      })
      .mockResolvedValueOnce({
        items: [makeCycle(3, 2), makeCycle(2, 1), makeCycle(1, 1)],
        nextCursor: null,
      });

    const { container } = renderTimeline();

    await screen.findByText("GOAL V3");
    expect(getVersion(container, 3)).toHaveAttribute(
      "data-version-kind",
      "revision",
    );
    expect(
      container.querySelectorAll('[data-version-number="3"]'),
    ).toHaveLength(1);

    triggerIntersection();
    await screen.findByText("GOAL V2");
    await waitFor(() => expect(listCycles).toHaveBeenCalledTimes(2));
    expect(listCycles).toHaveBeenNthCalledWith(
      2,
      sessionLease,
      goalId,
      "older-1",
      expect.any(AbortSignal),
    );
    expect(
      container.querySelectorAll('[data-version-number="3"]'),
    ).toHaveLength(1);
    const v3 = getVersion(container, 3);
    expect(within(v3).getByRole("link", { name: /Cycle 5/ })).toBeVisible();
    expect(within(v3).getByRole("link", { name: /Cycle 6/ })).toBeVisible();

    triggerIntersection();
    await screen.findByRole("heading", { name: "Version 1の目標" });
    await waitFor(() => expect(listCycles).toHaveBeenCalledTimes(3));
    expect(listCycles).toHaveBeenNthCalledWith(
      3,
      sessionLease,
      goalId,
      "older-2",
      expect.any(AbortSignal),
    );

    const versions = [
      ...container.querySelectorAll<HTMLElement>("[data-version-number]"),
    ];
    expect(versions.map((version) => version.dataset.versionNumber)).toEqual([
      "3",
      "2",
      "1",
    ]);
    expect(versions.map((version) => version.dataset.versionKind)).toEqual([
      "revision",
      "revision",
      "baseline",
    ]);
    const entries = [
      ...container.querySelectorAll<HTMLElement>(".timeline > li"),
    ].map((entry) =>
      entry.dataset.timelineEntry === "period"
        ? `period-${entry.dataset.versionNumber}`
        : `${entry.dataset.timelineEvent}-${entry.dataset.eventVersion}`,
    );
    expect(entries).toEqual([
      "period-3",
      "change-3",
      "period-2",
      "change-2",
      "period-1",
      "created-1",
    ]);
    expect(screen.getAllByText("目標を変更しました")).toHaveLength(2);
    expect(
      within(getEvent(container, 3)).getByText("Cycle 4の終了後"),
    ).toBeVisible();
    expect(
      within(getEvent(container, 2)).getByText("Cycle 2の終了後"),
    ).toBeVisible();
    expect(
      within(getEvent(container, 1)).getByText("目標を設定しました"),
    ).toBeVisible();
    expect(getVersion(container, 3)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    expect(getEvent(container, 3)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    for (const versionNumber of [1, 2]) {
      expect(getVersion(container, versionNumber)).toHaveAttribute(
        "data-version-state",
        "past",
      );
      expect(getEvent(container, versionNumber)).toHaveAttribute(
        "data-version-state",
        "past",
      );
    }
    for (const version of versions)
      expect(
        within(version).queryByText("目標を変更しました"),
      ).not.toBeInTheDocument();
    expect(
      within(getVersion(container, 2)).getByRole("link", { name: /Cycle 3/ }),
    ).toBeVisible();
    expect(
      within(getVersion(container, 2)).getByRole("link", { name: /Cycle 4/ }),
    ).toBeVisible();
  });
});

function CacheInspectingHome() {
  const cache = useQueryClient();
  const hasDeletedGoalCache =
    cache.getQueryData(userQueryKeys.goal(session.user.id, goalId)) !==
      undefined ||
    cache.getQueryData(userQueryKeys.goalCycles(session.user.id, goalId)) !==
      undefined;
  return (
    <>
      <p>ホーム</p>
      <p>{hasDeletedGoalCache ? "Goal cache残存" : "Goal cache削除済み"}</p>
    </>
  );
}

type GoalDeletionChannelHarness = {
  readonly channel: GoalDeletionAdvisoryChannelLike;
  readonly postMessage: ReturnType<
    typeof vi.fn<GoalDeletionAdvisoryChannelLike["postMessage"]>
  >;
  readonly dispatch: (message: {
    readonly version: 1;
    readonly deletedUserId: string;
    readonly deletedGoalId: string;
  }) => void;
};

function createGoalDeletionChannelHarness(): GoalDeletionChannelHarness {
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const postMessage = vi.fn<GoalDeletionAdvisoryChannelLike["postMessage"]>();
  return {
    channel: {
      postMessage,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: vi.fn(),
    },
    postMessage,
    dispatch: (message) => {
      for (const listener of [...listeners]) listener({ data: message });
    },
  };
}

function renderLateTimelineWithSessionProvider({
  advisory,
  cache,
}: {
  readonly advisory: GoalDeletionChannelHarness;
  readonly cache: QueryClient;
}) {
  render(
    <QueryClientProvider client={cache}>
      <SessionProvider goalDeletionAdvisoryFactory={() => advisory.channel}>
        <SessionIdentityBoundary>
          <LateTimelineRoutes />
        </SessionIdentityBoundary>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function LateTimelineRoutes() {
  const runPostCommitSessionOperation = useRunPostCommitSessionOperation();
  return (
    <MemoryRouter initialEntries={["/"]}>
      <PostCommitCleanupBoundary
        runSessionOperation={runPostCommitSessionOperation}
      >
        <Routes>
          <Route
            path="/"
            element={
              <Link to={`/history/goals/${goalId}`}>
                削除済みGoal履歴を開く
              </Link>
            }
          />
          <Route path="/history/goals/:goalId" element={<GoalTimelinePage />} />
        </Routes>
      </PostCommitCleanupBoundary>
    </MemoryRouter>
  );
}

function renderTimeline(
  options: {
    readonly advisory?: GoalDeletionAdvisoryHarness;
    readonly cache?: QueryClient;
    readonly routeSwitch?: boolean;
  } = {},
) {
  const cache =
    options.cache ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  const advisory = options.advisory ?? createGoalDeletionAdvisoryHarness();
  const view = render(
    <QueryClientProvider client={cache}>
      <AutoSaveScopeProvider>
        <AuthenticatedSessionTestProvider
          lease={sessionLease}
          session={session}
        >
          <GoalDeletionAdvisoryContext.Provider value={advisory.registry}>
            <MemoryRouter initialEntries={[`/history/goals/${goalId}`]}>
              {options.routeSwitch ? (
                <Link to="/external">別routeへ移動</Link>
              ) : null}
              <PostCommitCleanupBoundary
                runSessionOperation={async (_expectedUserId, operation) =>
                  operation(() => true)
                }
              >
                <Routes>
                  <Route
                    path="/history/goals/:goalId"
                    element={<GoalTimelinePage />}
                  />
                  <Route path="/" element={<CacheInspectingHome />} />
                  <Route path="/external" element={<p>外部route</p>} />
                </Routes>
              </PostCommitCleanupBoundary>
            </MemoryRouter>
          </GoalDeletionAdvisoryContext.Provider>
        </AuthenticatedSessionTestProvider>
      </AutoSaveScopeProvider>
    </QueryClientProvider>,
  );
  return { ...view, advisory, cache };
}

type GoalDeletionAdvisoryHarness = {
  readonly registry: GoalDeletionAdvisoryRegistry;
  readonly beginCleanup: ReturnType<
    typeof vi.fn<GoalDeletionAdvisoryRegistry["beginCleanup"]>
  >;
  readonly publish: ReturnType<
    typeof vi.fn<GoalDeletionAdvisoryRegistry["publish"]>
  >;
  readonly dispatch: (userId: string, goalId: string) => void;
};

function createGoalDeletionAdvisoryHarness(): GoalDeletionAdvisoryHarness {
  const listeners = new Map<string, Set<() => void>>();
  const known = new Set<string>();
  const cleanups = new Map<
    string,
    {
      readonly completion: Promise<GoalDeletionCleanupOutcome>;
      readonly resolve: (outcome: GoalDeletionCleanupOutcome) => void;
    }
  >();
  const keyOf = (candidateUserId: string, candidateGoalId: string) =>
    JSON.stringify([candidateUserId, candidateGoalId]);
  const publish = vi.fn<GoalDeletionAdvisoryRegistry["publish"]>();
  const subscribe = vi.fn<GoalDeletionAdvisoryRegistry["subscribe"]>(
    (candidateUserId, candidateGoalId, listener) => {
      const key = keyOf(candidateUserId, candidateGoalId);
      const matching = listeners.get(key) ?? new Set<() => void>();
      matching.add(listener);
      listeners.set(key, matching);
      if (known.has(key)) listener();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        matching.delete(listener);
        if (matching.size === 0) listeners.delete(key);
      };
    },
  );
  const beginCleanup = vi.fn<GoalDeletionAdvisoryRegistry["beginCleanup"]>(
    (candidateUserId, candidateGoalId) => {
      const key = keyOf(candidateUserId, candidateGoalId);
      const current = cleanups.get(key);
      if (current !== undefined) {
        return { kind: "joined", completion: current.completion };
      }
      let resolve: (outcome: GoalDeletionCleanupOutcome) => void = () =>
        undefined;
      const completion = new Promise<GoalDeletionCleanupOutcome>((done) => {
        resolve = done;
      });
      const cleanup = { completion, resolve };
      cleanups.set(key, cleanup);
      return {
        kind: "owner",
        completion,
        complete: () => {
          if (cleanups.get(key) !== cleanup) return;
          cleanups.delete(key);
          resolve("completed");
        },
        fail: () => {
          if (cleanups.get(key) !== cleanup) return;
          cleanups.delete(key);
          resolve("failed");
        },
      };
    },
  );
  return {
    registry: {
      beginCleanup,
      publish,
      subscribe,
      isKnown: (candidateUserId, candidateGoalId) =>
        known.has(keyOf(candidateUserId, candidateGoalId)),
    },
    beginCleanup,
    publish,
    dispatch: (candidateUserId, candidateGoalId) => {
      known.add(keyOf(candidateUserId, candidateGoalId));
      for (const listener of [
        ...(listeners.get(keyOf(candidateUserId, candidateGoalId)) ?? []),
      ]) {
        listener();
      }
    },
  };
}

function triggerIntersection() {
  act(() => {
    notifyIntersection(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function getVersion(container: HTMLElement, versionNumber: number) {
  const version = container.querySelector<HTMLElement>(
    `[data-version-number="${versionNumber}"]`,
  );
  expect(version).not.toBeNull();
  return version!;
}

function getEvent(container: HTMLElement, versionNumber: number) {
  const event = container.querySelector<HTMLElement>(
    `[data-event-version="${versionNumber}"]`,
  );
  expect(event).not.toBeNull();
  return event!;
}

function makeGoal(versionNumber: number): Goal {
  return {
    id: goalId,
    status: "active_cycle",
    revision: versionNumber - 1,
    currentVersion: makeVersion(versionNumber),
    currentWork: {
      kind: "active_cycle",
      cycleId: cycleId(versionNumber * 2),
      cycleSequenceNumber: versionNumber * 2,
    },
    nextCycleSequenceNumber: versionNumber * 2 + 1,
    cycleCount: versionNumber * 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    terminalAt: null,
  };
}

function makeGoalWithBody(versionNumber: number, body: string): Goal {
  return {
    ...makeGoal(versionNumber),
    currentVersion: { ...makeVersion(versionNumber), body },
  };
}

function makeVersion(versionNumber: number): GoalVersion {
  return {
    id: versionId(versionNumber),
    versionNumber,
    body: `Version ${versionNumber}の目標`,
    createdAt: `2026-08-${String(versionNumber).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function makeCycle(
  sequenceNumber: number,
  versionNumber: number,
): CycleSummary {
  return {
    id: cycleId(sequenceNumber),
    sequenceNumber,
    status: "completed",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-02T00:00:00.000Z",
    canceledAt: null,
    goalVersion: makeVersion(versionNumber),
    planPreview: `Cycle ${sequenceNumber}の計画`,
  };
}

function makeCycleWithPreview(
  sequenceNumber: number,
  versionNumber: number,
  planPreview: string,
): CycleSummary {
  return { ...makeCycle(sequenceNumber, versionNumber), planPreview };
}

function deletedGoalError(requestId: string) {
  return new APIError(404, "GOAL_NOT_FOUND", "deleted", requestId);
}

function versionId(versionNumber: number) {
  return `20000000-0000-7000-8000-${String(versionNumber).padStart(12, "0")}`;
}

function cycleId(sequenceNumber: number) {
  return `30000000-0000-7000-8000-${String(sequenceNumber).padStart(12, "0")}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
