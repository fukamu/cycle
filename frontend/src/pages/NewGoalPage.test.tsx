import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import type {
  Cycle,
  Goal,
  GoalDraft,
  Home,
  Session,
} from "../shared/api/schemas";
import {
  adoptGoalDraft,
  getHome,
  refineGoalDraft,
  saveGoalDraft,
  startGoal,
} from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import { NewGoalPage } from "./NewGoalPage";

vi.mock("../shared/api/workspace", () => ({
  adoptGoalDraft: vi.fn(),
  createGoalDraft: vi.fn(),
  discardGoalDraft: vi.fn(),
  getHome: vi.fn(),
  refineGoalDraft: vi.fn(),
  saveGoalDraft: vi.fn(),
  startGoal: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
}));

const draft: GoalDraft = {
  id: "20000000-0000-7000-8000-000000000001",
  draftType: "creation",
  body: "元の目標",
  revision: 0,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const home: Home = {
  progressingGoals: [],
  creationDraft: draft,
  canCreateGoalDraft: false,
  progressingGoalLimit: 2,
  canStartProgressingGoal: true,
};

const session: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

const startedCycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: "50000000-0000-7000-8000-000000000001",
  sequenceNumber: 1,
  status: "active",
  goalVersion: {
    id: "30000000-0000-7000-8000-000000000002",
    versionNumber: 1,
    body: draft.body,
    createdAt: "2026-08-20T00:02:00.000Z",
  },
  startedAt: "2026-08-20T00:02:00.000Z",
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  plan: "",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};

const replayedCurrentCycleId = "40000000-0000-7000-8000-000000000002";
const startedGoal: Goal = {
  id: startedCycle.goalId ?? "",
  status: "active_cycle",
  revision: 1,
  currentVersion: startedCycle.goalVersion,
  currentWork: {
    kind: "active_cycle",
    cycleId: replayedCurrentCycleId,
    cycleSequenceNumber: 2,
  },
  nextCycleSequenceNumber: 3,
  cycleCount: 2,
  createdAt: "2026-08-20T00:02:00.000Z",
  terminalAt: null,
};

describe("NewGoalPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHome).mockResolvedValue(home);
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(refineGoalDraft).mockResolvedValue({
      generationId: "30000000-0000-7000-8000-000000000001",
      sourceDraftRevision: draft.revision,
      suggestion: "整理された目標",
      contextChanged: false,
    });
    vi.mocked(adoptGoalDraft).mockResolvedValue({
      draft: {
        ...draft,
        body: "整理された目標",
        revision: 1,
        updatedAt: "2026-08-20T00:01:00.000Z",
      },
    });
    vi.mocked(startGoal).mockResolvedValue({
      goal: startedGoal,
      cycle: startedCycle,
      replayed: true,
    });
  });

  it("keeps refinement separate until the user explicitly adopts it", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));

    expect(await screen.findByText("整理された目標")).toBeInTheDocument();
    expect(editor).toHaveValue("元の目標");
    expect(adoptGoalDraft).not.toHaveBeenCalled();
    expect(saveGoalDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));

    await waitFor(() =>
      expect(adoptGoalDraft).toHaveBeenCalledWith(
        draft.id,
        "30000000-0000-7000-8000-000000000001",
        draft.revision,
        session.csrfToken,
      ),
    );
    await waitFor(() => expect(editor).toHaveValue("整理された目標"));
  });

  it("retries an ambiguous Start response with the same operation and resolves the canonical workspace", async () => {
    vi.mocked(startGoal)
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({
        goal: startedGoal,
        cycle: startedCycle,
        replayed: true,
      });
    renderPage();
    const startButton = await screen.findByRole("button", {
      name: "この目標で始める",
    });

    fireEvent.click(startButton);

    expect(
      await screen.findByText(
        "目標を開始できませんでした。保存状態と進行中の目標を確認してください。",
      ),
    ).toBeInTheDocument();

    fireEvent.click(startButton);

    expect(await screen.findByText("現在のワークスペース")).toBeInTheDocument();
    expect(startGoal).toHaveBeenCalledTimes(2);
    const firstOptions = vi.mocked(startGoal).mock.calls[0]?.[2];
    const secondOptions = vi.mocked(startGoal).mock.calls[1]?.[2];
    expect(firstOptions).toEqual({
      operationId: expect.any(String),
      csrfToken: session.csrfToken,
    });
    expect(secondOptions?.operationId).toBe(firstOptions?.operationId);
    expect(startGoal).toHaveBeenLastCalledWith(
      draft.id,
      draft.revision,
      secondOptions,
    );
  });
});

function renderPage() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={cache}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={["/goals/new"]}>
          <Routes>
            <Route path="/goals/new" element={<NewGoalPage />} />
            <Route
              path="/goals/:goalId"
              element={<p>現在のワークスペース</p>}
            />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}
