import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AuthenticatedSessionTestProvider } from "../test/AuthenticatedSessionTestProvider";
import { createCurrentAuthenticatedRequestLease } from "../test/authenticatedRequestLease";
import type { Goal, Session } from "../shared/api/schemas";
import { listGoals } from "../shared/api/workspace";
import { GoalHistoryPage } from "./GoalHistoryPage";

vi.mock("../shared/api/workspace", () => ({
  listGoals: vi.fn(),
}));

const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

const sessionLease = createCurrentAuthenticatedRequestLease(session.user.id);

let notifyIntersection: IntersectionObserverCallback;

describe("GoalHistoryPage pagination recovery", () => {
  beforeEach(() => {
    vi.mocked(listGoals).mockReset();
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

  it("keeps loaded goals visible and retries only the failed next page", async () => {
    const user = userEvent.setup();
    const retryPage = deferred<Awaited<ReturnType<typeof listGoals>>>();
    vi.mocked(listGoals)
      .mockResolvedValueOnce({
        items: [makeGoal("最初の目標", 1)],
        nextCursor: "next",
      })
      .mockRejectedValueOnce(new TypeError("network"))
      .mockReturnValueOnce(retryPage.promise)
      .mockResolvedValue({
        items: [makeGoal("次の目標", 2)],
        nextCursor: null,
      });

    renderHistory();

    expect(await screen.findByText("最初の目標")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "続きを読み込む" }),
    ).toHaveAttribute("aria-controls", "goal-history-list");
    act(() => {
      notifyIntersection(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        undefined as unknown as IntersectionObserver,
      );
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "続きを読み込めませんでした。",
    );
    expect(screen.getByText("最初の目標")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "続きを読み込む" }),
    ).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "もう一度読み込む" });
    await user.click(retry);

    const loadingStatus = await screen.findByText("続きを読み込んでいます…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("最初の目標")).toBeVisible();
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-describedby", loadingStatus.id);
    await user.click(retry);
    act(() => {
      notifyIntersection(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        undefined as unknown as IntersectionObserver,
      );
    });
    expect(listGoals).toHaveBeenCalledTimes(3);

    await act(async () =>
      retryPage.resolve({
        items: [makeGoal("次の目標", 2)],
        nextCursor: null,
      }),
    );

    expect(await screen.findByText("次の目標")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("すべての目標を読み込みました。")).toBeVisible();
    expect(listGoals).toHaveBeenCalledTimes(3);
    expect(listGoals).toHaveBeenNthCalledWith(
      3,
      sessionLease,
      "all",
      "next",
      expect.any(AbortSignal),
    );
  });

  it("loads the next page from the keyboard and coalesces an intersection notice", async () => {
    const user = userEvent.setup();
    const nextPage = deferred<Awaited<ReturnType<typeof listGoals>>>();
    vi.mocked(listGoals)
      .mockResolvedValueOnce({
        items: [makeGoal("最初の目標", 1)],
        nextCursor: "next",
      })
      .mockReturnValue(nextPage.promise);

    renderHistory();

    expect(await screen.findByText("最初の目標")).toBeVisible();
    const firstGoal = screen.getByRole("link", { name: /最初の目標/ });
    const loadMore = screen.getByRole("button", { name: "続きを読み込む" });
    firstGoal.focus();
    await user.tab();
    expect(loadMore).toHaveFocus();
    await user.keyboard("{Enter}");

    const loadingStatus = await screen.findByText("続きを読み込んでいます…");
    expect(screen.getByText("最初の目標")).toBeVisible();
    expect(loadMore).toBeDisabled();
    expect(loadMore).toHaveAttribute("aria-describedby", loadingStatus.id);
    act(() => {
      const entries = [{ isIntersecting: true } as IntersectionObserverEntry];
      const observer = undefined as unknown as IntersectionObserver;
      notifyIntersection(entries, observer);
      notifyIntersection(entries, observer);
    });
    await waitFor(() =>
      expect(vi.mocked(listGoals).mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    await act(async () =>
      nextPage.resolve({
        items: [makeGoal("次の目標", 2)],
        nextCursor: null,
      }),
    );

    expect(await screen.findByText("次の目標")).toBeVisible();
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent?.trim()),
    ).toEqual(["最初の目標", "次の目標"]);
    expect(
      screen.queryByRole("button", { name: "続きを読み込む" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("すべての目標を読み込みました。")).toBeVisible();
    expect(listGoals).toHaveBeenCalledTimes(2);
    expect(listGoals).toHaveBeenLastCalledWith(
      sessionLease,
      "all",
      "next",
      expect.any(AbortSignal),
    );
  });

  it("does not add pagination controls to an empty history", async () => {
    vi.mocked(listGoals).mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    renderHistory();

    expect(await screen.findByText("まだ目標はありません。")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "続きを読み込む" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("すべての目標を読み込みました。"),
    ).not.toBeInTheDocument();
  });
});

function renderHistory() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <AuthenticatedSessionTestProvider lease={sessionLease} session={session}>
        <MemoryRouter>
          <GoalHistoryPage />
        </MemoryRouter>
      </AuthenticatedSessionTestProvider>
    </QueryClientProvider>,
  );
}

function makeGoal(body: string, sequence: number): Goal {
  const suffix = sequence.toString().padStart(12, "0");
  return {
    id: `10000000-0000-7000-8000-${suffix}`,
    status: "active_cycle",
    revision: 0,
    currentVersion: {
      id: `20000000-0000-7000-8000-${suffix}`,
      versionNumber: 1,
      body,
      createdAt: "2026-08-20T00:00:00.000Z",
    },
    currentWork: {
      kind: "active_cycle",
      cycleId: `30000000-0000-7000-8000-${suffix}`,
      cycleSequenceNumber: 1,
    },
    nextCycleSequenceNumber: 2,
    cycleCount: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    terminalAt: null,
  };
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve,
  };
}
