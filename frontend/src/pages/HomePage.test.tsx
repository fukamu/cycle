import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import type { Goal, Home, Session } from "../shared/api/schemas";
import { createGoalDraft, getHome } from "../shared/api/workspace";
import { HomePage } from "./HomePage";

vi.mock("../shared/api/workspace", () => ({
  createGoalDraft: vi.fn(),
  getHome: vi.fn(),
}));
vi.mock("../features/app-referral/AppReferralPromotion", () => ({
  AppReferralPromotion: () => null,
}));

const session: Session = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

const firstGoal = makeGoal({
  id: "10000000-0000-4000-8000-000000000001",
  body: "最初の目標",
  cycleId: "20000000-0000-4000-8000-000000000001",
});
const secondGoal: Goal = {
  ...makeGoal({
    id: "10000000-0000-4000-8000-000000000002",
    body: "二つ目の目標",
    cycleId: "20000000-0000-4000-8000-000000000002",
  }),
  status: "goal_review",
  currentWork: {
    kind: "goal_review",
    reviewDraftId: "30000000-0000-4000-8000-000000000002",
    triggerCycleId: "20000000-0000-4000-8000-000000000002",
    triggerCycleSequenceNumber: 1,
  },
};
const thirdGoal = makeGoal({
  id: "10000000-0000-4000-8000-000000000003",
  body: "三つ目の目標",
  cycleId: "20000000-0000-4000-8000-000000000003",
});

describe("HomePage progressing goal collection", () => {
  beforeEach(() => {
    vi.mocked(createGoalDraft).mockReset();
    vi.mocked(getHome).mockReset();
  });

  it("renders two independently routed goal cards at the free limit", async () => {
    const home: Home = {
      progressingGoals: [firstGoal, secondGoal],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: false,
    };
    vi.mocked(getHome).mockResolvedValue(home);

    renderHome();

    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /最初の目標/ })).toHaveAttribute(
      "href",
      `/goals/${firstGoal.id}/cycles/${firstGoal.currentWork?.cycleId}`,
    );
    expect(screen.getByRole("link", { name: /二つ目の目標/ })).toHaveAttribute(
      "href",
      `/goals/${secondGoal.id}/review`,
    );
  });

  it("keeps the collection contract usable at the paid boundary of three", async () => {
    vi.mocked(getHome).mockResolvedValue({
      progressingGoals: [firstGoal, secondGoal, thirdGoal],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 3,
      canStartProgressingGoal: false,
    });

    renderHome();

    expect(await screen.findByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /三つ目の目標/ })).toHaveAttribute(
      "href",
      `/goals/${thirdGoal.id}/cycles/${thirdGoal.currentWork?.cycleId}`,
    );
  });
});

function makeGoal({
  id,
  body,
  cycleId,
}: {
  readonly id: string;
  readonly body: string;
  readonly cycleId: string;
}): Goal {
  return {
    id,
    status: "active_cycle",
    revision: 0,
    currentVersion: {
      id: id.replace("10000000", "40000000"),
      versionNumber: 1,
      body,
      createdAt: "2026-08-20T00:00:00.000Z",
    },
    currentWork: {
      kind: "active_cycle",
      cycleId,
      cycleSequenceNumber: 1,
    },
    nextCycleSequenceNumber: 2,
    cycleCount: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    terminalAt: null,
  };
}

function renderHome() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <SessionContext.Provider value={session}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}
