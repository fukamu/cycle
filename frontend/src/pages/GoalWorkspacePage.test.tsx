import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import type { Cycle, Goal, Session } from "../shared/api/schemas";
import {
  completeCycle,
  getCycle,
  getGoal,
  refineAction,
  saveCycleFrame,
} from "../shared/api/workspace";
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

const completableCycle: Cycle = {
  ...cycle,
  plan: "計画",
  do: "実行",
  check: "評価",
  action: "改善",
  contentRevision: 4,
  frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
};

const currentCycleId = "40000000-0000-7000-8000-000000000002";
const reviewDraftId = "50000000-0000-7000-8000-000000000001";
const activeCycleReplay = {
  replayed: true,
  operation: "complete_cycle",
  resourceIds: { goalId: goal.id, cycleId: cycle.id },
  currentGoalState: "active_cycle",
  currentWorkspace: {
    kind: "active_cycle",
    cycleId: currentCycleId,
    cycleSequenceNumber: 2,
  },
} as const;
const goalReviewReplay = {
  replayed: true,
  operation: "complete_cycle",
  resourceIds: { goalId: goal.id, cycleId: cycle.id },
  currentGoalState: "goal_review",
  currentWorkspace: {
    kind: "goal_review",
    reviewDraftId,
    triggerCycleId: cycle.id,
    triggerCycleSequenceNumber: 1,
  },
} as const;
const terminalReplay = {
  replayed: true,
  operation: "complete_cycle",
  resourceIds: { goalId: goal.id, cycleId: cycle.id },
  currentGoalState: "ended",
  currentWorkspace: null,
} as const;

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
        cache.getQueryData<{ cycle: Cycle }>(
          userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
        )?.cycle.plan,
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

  it("moves between frame tabs with the WAI-ARIA keyboard controls", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const planTab = await screen.findByRole("tab", { name: /P\s*Plan/ });
    planTab.focus();

    fireEvent.keyDown(planTab, { key: "ArrowRight" });

    const doTab = screen.getByRole("tab", { name: /D\s*Do/ });
    expect(doTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(doTab).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "D — Do" })).toBeInTheDocument();
  });

  it("preserves Action and re-enables refinement after AI failure", async () => {
    const readyCycle: Cycle = {
      ...cycle,
      plan: "計画",
      do: "実行",
      check: "評価",
      action: "現在のA",
      contentRevision: 4,
      frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
    };
    let rejectRefinement: (reason?: unknown) => void = () => undefined;
    const pendingRefinement = new Promise<
      Awaited<ReturnType<typeof refineAction>>
    >((_resolve, reject) => {
      rejectRefinement = reject;
    });
    vi.mocked(getCycle).mockResolvedValue({ cycle: readyCycle });
    vi.mocked(refineAction).mockReturnValue(pendingRefinement);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
    const editor = screen.getByRole("textbox", { name: "A — Action" });
    const refineButton = screen.getByRole("button", { name: "AIで推敲" });
    expect(refineButton).toBeEnabled();

    fireEvent.click(refineButton);

    expect(
      await screen.findByRole("button", { name: "推敲しています…" }),
    ).toBeDisabled();
    await act(async () => rejectRefinement(new Error("provider failure")));

    expect(
      await screen.findByText(
        "AI処理を完了できませんでした。現在のAは保持されています。",
      ),
    ).toBeInTheDocument();
    expect(editor).toHaveValue("現在のA");
    expect(screen.getByRole("button", { name: "AIで推敲" })).toBeEnabled();
    expect(refineAction).toHaveBeenCalledWith(
      goal.id,
      readyCycle.id,
      readyCycle.contentRevision,
      {
        operationId: expect.any(String),
        csrfToken: session.csrfToken,
      },
    );
  });

  it.each([
    {
      label: "the current active cycle",
      response: activeCycleReplay,
      destination: "現在のサイクル",
    },
    {
      label: "the current goal review",
      response: goalReviewReplay,
      destination: "現在の目標レビュー",
    },
    {
      label: "terminal goal history",
      response: terminalReplay,
      destination: "現在の目標履歴",
    },
  ])(
    "routes a Complete replay to $label",
    async ({ response, destination }) => {
      vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
      vi.mocked(completeCycle).mockResolvedValue(response);
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache);

      await confirmCycleCompletion();

      expect(await screen.findByText(destination)).toBeInTheDocument();
      expect(completeCycle).toHaveBeenCalledWith(
        goal.id,
        cycle.id,
        goal.revision,
        completableCycle.contentRevision,
        {
          operationId: expect.any(String),
          csrfToken: session.csrfToken,
        },
      );
    },
  );

  it("reuses the Complete operation after response loss without clearing a later cycle draft", async () => {
    const nextCycleDraftKey = `cycle:${currentCycleId}:plan`;
    const browserDrafts = new Set([nextCycleDraftKey]);
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(clearGoalDrafts).mockImplementation(async () => {
      browserDrafts.clear();
    });
    vi.mocked(deleteBrowserDraft).mockImplementation(async (_userId, key) => {
      browserDrafts.delete(key);
    });
    vi.mocked(completeCycle)
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(activeCycleReplay);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await confirmCycleCompletion();

    expect(
      await screen.findByText(
        "サイクルを完了できませんでした。入力内容を確認してください。",
      ),
    ).toBeInTheDocument();

    await confirmCycleCompletion();

    expect(await screen.findByText("現在のサイクル")).toBeInTheDocument();
    expect(completeCycle).toHaveBeenCalledTimes(2);
    const firstOptions = vi.mocked(completeCycle).mock.calls[0]?.[4];
    const secondOptions = vi.mocked(completeCycle).mock.calls[1]?.[4];
    expect(secondOptions?.operationId).toBe(firstOptions?.operationId);
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(browserDrafts.has(nextCycleDraftKey)).toBe(true);
    expect(
      vi
        .mocked(deleteBrowserDraft)
        .mock.calls.every(
          ([, key]) => !key.startsWith(`cycle:${currentCycleId}:`),
        ),
    ).toBe(true);
  });
});

async function confirmCycleCompletion() {
  fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
  fireEvent.click(screen.getByRole("button", { name: "サイクルを完了" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "サイクルを完了" }),
  );
}

function renderPage(cache: QueryClient) {
  return render(
    <QueryClientProvider client={cache}>
      <SessionContext.Provider value={session}>
        <MemoryRouter
          initialEntries={[`/workspace/${goal.id}/cycles/${cycle.id}`]}
        >
          <Routes>
            <Route
              path="/workspace/:goalId/cycles/:cycleId"
              element={<GoalWorkspacePage />}
            />
            <Route
              path="/goals/:goalId/cycles/:cycleId"
              element={<p>現在のサイクル</p>}
            />
            <Route
              path="/goals/:goalId/review"
              element={<p>現在の目標レビュー</p>}
            />
            <Route
              path="/history/goals/:goalId"
              element={<p>現在の目標履歴</p>}
            />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}
