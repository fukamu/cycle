import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import { cycleQueryKey } from "../features/goal-collection/goalCache";
import type { Cycle, Goal, Session } from "../shared/api/schemas";
import { getCycle, getGoal, saveCycleFrame } from "../shared/api/workspace";
import {
  clearGoalDrafts,
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import { GoalWorkspacePage } from "./GoalWorkspacePage";

vi.mock("../shared/api/workspace", () => ({
  completeCycle: vi.fn(),
  deleteGoal: vi.fn(),
  generateAction: vi.fn(),
  getCycle: vi.fn(),
  getGoal: vi.fn(),
  refineAction: vi.fn(),
  saveCycleFrame: vi.fn(),
  terminateGoal: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  clearGoalDrafts: vi.fn(),
  deleteBrowserDraft: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
}));

const goal: Goal = {
  id: "20000000-0000-7000-8000-000000000001",
  status: "active_cycle",
  revision: 0,
  currentVersion: {
    id: "30000000-0000-7000-8000-000000000001",
    versionNumber: 1,
    body: "目標",
    createdAt: "2026-08-20T00:00:00.000Z",
  },
  currentWork: {
    kind: "active_cycle",
    cycleId: "40000000-0000-7000-8000-000000000001",
    cycleSequenceNumber: 1,
  },
  nextCycleSequenceNumber: 2,
  cycleCount: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  terminalAt: null,
};

const cycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: goal.id,
  sequenceNumber: 1,
  status: "active",
  goalVersion: goal.currentVersion,
  startedAt: "2026-08-20T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  plan: "自動保存前",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};

const session: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

describe("GoalWorkspacePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoal).mockResolvedValue({ goal });
    vi.mocked(getCycle).mockResolvedValue({ cycle });
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(clearGoalDrafts).mockResolvedValue(undefined);
    vi.mocked(saveCycleFrame).mockResolvedValue({
      cycleId: cycle.id,
      frame: "plan",
      content: "自動保存後",
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-20T00:01:00.000Z",
    });
  });

  it("shows the saved frame after leaving and returning within cache stale time", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const first = renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });

    fireEvent.change(editor, { target: { value: "自動保存後" } });

    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    await waitFor(() =>
      expect(
        cache.getQueryData<{ cycle: Cycle }>(cycleQueryKey(goal.id, cycle.id))
          ?.cycle.plan,
      ).toBe("自動保存後"),
    );
    first.unmount();

    renderPage(cache);

    expect(
      await screen.findByRole("textbox", { name: "P — Plan" }),
    ).toHaveValue("自動保存後");
    expect(getCycle).toHaveBeenCalledOnce();
  });

  it("coalesces a typing burst into one browser recovery write", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });

    fireEvent.change(editor, { target: { value: "一" } });
    fireEvent.change(editor, { target: { value: "一二" } });
    fireEvent.change(editor, { target: { value: "一二三" } });

    await waitFor(() => expect(putBrowserDraft).toHaveBeenCalledOnce());
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: session.user.id,
        goalId: goal.id,
        body: "一二三",
        baseRevision: 0,
      }),
    );
  });

  it("keeps a successful server save successful when browser cleanup fails", async () => {
    vi.mocked(deleteBrowserDraft).mockRejectedValue(new Error("indexeddb"));
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });

    fireEvent.change(editor, { target: { value: "自動保存後" } });

    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(
      await screen.findByText(/この端末の復旧用保存を利用できません/),
    ).toBeInTheDocument();
  });

  it("requires an explicit choice before sending a mismatched draft", async () => {
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":plan")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "端末に残った入力",
            baseRevision: 9,
            updatedAt: new Date().toISOString(),
          }
        : null,
    );
    vi.mocked(saveCycleFrame).mockResolvedValue({
      cycleId: cycle.id,
      frame: "plan",
      content: "端末に残った入力",
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-20T00:01:00.000Z",
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(editor).toHaveValue("端末に残った入力"));
    expect(editor).toHaveAttribute("readonly");
    expect(saveCycleFrame).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "この端末の入力を復元" }),
    );

    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenCalledWith(
        goal.id,
        cycle.id,
        "plan",
        "端末に残った入力",
        0,
        session.csrfToken,
      ),
    );
  });
});

function renderPage(cache: QueryClient) {
  return render(
    <QueryClientProvider client={cache}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[`/goals/${goal.id}/cycles/${cycle.id}`]}>
          <Routes>
            <Route
              path="/goals/:goalId/cycles/:cycleId"
              element={<GoalWorkspacePage />}
            />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}
