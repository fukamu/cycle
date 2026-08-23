import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
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
    vi.mocked(listGoals)
      .mockResolvedValueOnce({
        items: [makeGoal("最初の目標", 1)],
        nextCursor: "next",
      })
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({
        items: [makeGoal("次の目標", 2)],
        nextCursor: null,
      });

    renderHistory();

    expect(await screen.findByText("最初の目標")).toBeVisible();
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
    await user.click(screen.getByRole("button", { name: "もう一度読み込む" }));

    expect(await screen.findByText("次の目標")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(listGoals).toHaveBeenNthCalledWith(3, "all", "next");
  });
});

function renderHistory() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <SessionContext.Provider value={session}>
        <MemoryRouter>
          <GoalHistoryPage />
        </MemoryRouter>
      </SessionContext.Provider>
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
