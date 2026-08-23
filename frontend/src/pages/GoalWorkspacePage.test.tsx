import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import { APIError } from "../shared/api/client";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
} from "../shared/autosave/AutoSaveScopeProvider";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import type { Cycle, Goal, Session } from "../shared/api/schemas";
import {
  completeCycle,
  deleteGoal,
  getCycle,
  getGoal,
  refineAction,
  saveCycleFrame,
  terminateGoal,
} from "../shared/api/workspace";
import {
  clearGoalDrafts,
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
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
  deleteBrowserDraftIfUnchanged: vi.fn(),
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
    vi.mocked(deleteBrowserDraftIfUnchanged).mockImplementation(
      async (userId, subjectKey) => deleteBrowserDraft(userId, subjectKey),
    );
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

  it("keeps related commands gated until the current StrictMode hydration finishes", async () => {
    const discardedHydration =
      deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    const currentHydration =
      deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    let readCount = 0;
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(getBrowserDraft).mockImplementation(() => {
      readCount += 1;
      return readCount <= 4
        ? discardedHydration.promise
        : currentHydration.promise;
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { strictMode: true });

    fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));

    expect(screen.getByText("保存中")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "アクションを生成" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "AIで推敲" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "サイクルを完了" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "目標を達成として終了",
        hidden: true,
      }),
    ).toBeDisabled();

    expect(
      screen.getByRole("button", { name: "目標を削除", hidden: true }),
    ).toBeEnabled();

    await act(async () => discardedHydration.resolve(null));

    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledTimes(5));
    expect(screen.getByText("保存中")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "サイクルを完了" }),
    ).toBeDisabled();

    await act(async () => currentHydration.resolve(null));

    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledTimes(8));
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "アクションを生成" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "AIで推敲" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "サイクルを完了" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "目標を達成として終了",
        hidden: true,
      }),
    ).toBeEnabled();
  });

  it("keeps hydration-time input and saves it only after every draft read completes", async () => {
    const hydration = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    const localBody = "読込中に編集した計画";
    vi.mocked(getBrowserDraft).mockReturnValue(hydration.promise);
    vi.mocked(saveCycleFrame).mockResolvedValue({
      cycleId: cycle.id,
      frame: "plan",
      content: localBody,
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-20T00:01:00.000Z",
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledOnce());

    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);
    await act(
      async () =>
        await new Promise<void>((resolve) => window.setTimeout(resolve, 25)),
    );

    expect(editor).toHaveValue(localBody);
    expect(saveCycleFrame).not.toHaveBeenCalled();

    await act(async () => hydration.resolve(null));

    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledTimes(4));
    await waitFor(
      () =>
        expect(saveCycleFrame).toHaveBeenCalledWith(
          goal.id,
          cycle.id,
          "plan",
          localBody,
          0,
          session.csrfToken,
          expect.any(AbortSignal),
        ),
      { timeout: 2_000 },
    );
    expect(editor).toHaveValue(localBody);
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
  });

  it("resumes a same-revision browser draft after a Delete failure during hydration", async () => {
    const hydration = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    const deletion = deferred<Awaited<ReturnType<typeof deleteGoal>>>();
    const localBody = "削除中に見つかった端末の計画";
    vi.mocked(getBrowserDraft).mockImplementation((_userId, key) =>
      key.endsWith(":plan") ? hydration.promise : Promise.resolve(null),
    );
    vi.mocked(deleteGoal).mockReturnValue(deletion.promise);
    vi.mocked(saveCycleFrame).mockResolvedValue({
      cycleId: cycle.id,
      frame: "plan",
      content: localBody,
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-20T00:01:00.000Z",
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByText("目標の操作"));
    fireEvent.click(screen.getByRole("button", { name: "目標を削除" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "目標を削除",
      }),
    );
    await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());

    await act(async () =>
      hydration.resolve({
        userId: session.user.id,
        goalId: goal.id,
        subjectKey: `cycle:${cycle.id}:plan`,
        body: localBody,
        baseRevision: cycle.frameRevisions.plan,
        updatedAt: "2026-08-20T00:00:30.000Z",
      }),
    );
    await waitFor(() => expect(editor).toHaveValue(localBody));
    expect(saveCycleFrame).not.toHaveBeenCalled();

    await act(async () => deletion.reject(new TypeError("delete failed")));

    expect(
      await screen.findByText("目標を削除できませんでした。"),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(saveCycleFrame).toHaveBeenCalledWith(
          goal.id,
          cycle.id,
          "plan",
          localBody,
          cycle.frameRevisions.plan,
          session.csrfToken,
          expect.any(AbortSignal),
        ),
      { timeout: 2_000 },
    );
    expect(editor).toHaveValue(localBody);
  });

  it("re-sends an aborted late-success frame after a Delete failure", async () => {
    const firstSave = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    const deletion = deferred<Awaited<ReturnType<typeof deleteGoal>>>();
    const localBody = "削除失敗後に再送する計画";
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "plan",
        content: localBody,
        frameRevision: 2,
        contentRevision: 2,
        savedAt: "2026-08-20T00:02:00.000Z",
      });
    vi.mocked(deleteGoal).mockReturnValue(deletion.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByText("目標の操作"));
    fireEvent.click(screen.getByRole("button", { name: "目標を削除" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "目標を削除",
      }),
    );
    await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());
    expect(vi.mocked(saveCycleFrame).mock.calls[0]?.[6]).toEqual(
      expect.objectContaining({ aborted: true }),
    );

    await act(async () =>
      firstSave.resolve({
        cycleId: cycle.id,
        frame: "plan",
        content: localBody,
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-08-20T00:01:00.000Z",
      }),
    );
    expect(saveCycleFrame).toHaveBeenCalledOnce();

    await act(async () => deletion.reject(new TypeError("delete failed")));

    expect(
      await screen.findByText("目標を削除できませんでした。"),
    ).toBeInTheDocument();
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledTimes(2));
    expect(saveCycleFrame).toHaveBeenLastCalledWith(
      goal.id,
      cycle.id,
      "plan",
      localBody,
      cycle.frameRevisions.plan,
      session.csrfToken,
      expect.any(AbortSignal),
    );
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
  });

  it("finishes only the detached old coordinator after a route-scope hydration completes late", async () => {
    const oldHydration =
      deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    const nextCycle: Cycle = {
      ...cycle,
      id: currentCycleId,
      sequenceNumber: 2,
      plan: "次のサイクルの計画",
    };
    vi.mocked(getCycle).mockImplementation(async (_goalId, requestedCycleId) =>
      requestedCycleId === nextCycle.id ? { cycle: nextCycle } : { cycle },
    );
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.startsWith("cycle:" + cycle.id + ":") ? oldHydration.promise : null,
    );
    vi.mocked(saveCycleFrame).mockImplementation(
      async (_goalId, cycleId, frame, content) => ({
        cycleId,
        frame,
        content,
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-08-20T00:01:00.000Z",
      }),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { switchCycleId: nextCycle.id });
    const oldEditor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledOnce());

    fireEvent.change(oldEditor, { target: { value: "切替前の未保存計画" } });
    fireEvent.blur(oldEditor);
    fireEvent.click(screen.getByRole("link", { name: "別のCycleへ移動" }));

    const nextEditor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(nextEditor).toHaveValue(nextCycle.plan));
    expect(saveCycleFrame).not.toHaveBeenCalled();

    await act(async () => oldHydration.resolve(null));

    await waitFor(
      () =>
        expect(saveCycleFrame).toHaveBeenCalledWith(
          goal.id,
          cycle.id,
          "plan",
          "切替前の未保存計画",
          0,
          session.csrfToken,
          expect.any(AbortSignal),
        ),
      { timeout: 2_000 },
    );
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(nextEditor).toHaveValue(nextCycle.plan);
  });

  it("restores and autosaves a browser draft from the current frame revision", async () => {
    const recoveredBody = "再読込後に復元した計画";
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":plan")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: recoveredBody,
            baseRevision: cycle.frameRevisions.plan,
            updatedAt: "2026-08-20T00:00:30.000Z",
          }
        : null,
    );
    vi.mocked(saveCycleFrame).mockResolvedValue({
      cycleId: cycle.id,
      frame: "plan",
      content: recoveredBody,
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-20T00:01:00.000Z",
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(editor).toHaveValue(recoveredBody));
    await waitFor(
      () =>
        expect(saveCycleFrame).toHaveBeenCalledWith(
          goal.id,
          cycle.id,
          "plan",
          recoveredBody,
          cycle.frameRevisions.plan,
          session.csrfToken,
          expect.any(AbortSignal),
        ),
      { timeout: 2_000 },
    );
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
  });

  it("accepts 200 non-BMP code points and rejects the 201st", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    const twoHundredCodePoints = "😀".repeat(200);

    expect(editor).not.toHaveAttribute("maxlength");
    fireEvent.change(editor, { target: { value: twoHundredCodePoints } });

    expect(editor).toHaveValue(twoHundredCodePoints);
    expect(screen.getByText("200 / 200")).toBeInTheDocument();

    fireEvent.change(editor, {
      target: { value: `${twoHundredCodePoints}😀` },
    });

    expect(editor).toHaveValue(twoHundredCodePoints);
    expect(screen.getByText("200 / 200")).toBeInTheDocument();
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
    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledTimes(8));
  });

  it("saves a reversion made while the previous value is in flight", async () => {
    const first = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    const second = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });

    fireEvent.change(editor, { target: { value: "in-flight value" } });
    fireEvent.blur(editor);
    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenNthCalledWith(
        1,
        goal.id,
        cycle.id,
        "plan",
        "in-flight value",
        0,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );

    fireEvent.change(editor, { target: { value: cycle.plan } });
    expect(editor).toHaveValue(cycle.plan);

    await act(async () => {
      first.resolve({
        cycleId: cycle.id,
        frame: "plan",
        content: "in-flight value",
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-08-20T00:01:00.000Z",
      });
    });

    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenNthCalledWith(
        2,
        goal.id,
        cycle.id,
        "plan",
        cycle.plan,
        1,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByText("保存済み")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve({
        cycleId: cycle.id,
        frame: "plan",
        content: cycle.plan,
        frameRevision: 2,
        contentRevision: 2,
        savedAt: "2026-08-20T00:02:00.000Z",
      });
    });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
  });

  it("continues with the latest reversion instead of the failed in-flight snapshot", async () => {
    const first = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "plan",
        content: cycle.plan,
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-08-20T00:02:00.000Z",
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });

    fireEvent.change(editor, { target: { value: "ambiguous value" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    fireEvent.change(editor, { target: { value: cycle.plan } });

    await act(async () => {
      first.reject(new Error("invalid save response"));
    });

    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenNthCalledWith(
        2,
        goal.id,
        cycle.id,
        "plan",
        cycle.plan,
        0,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    expect(editor).toHaveValue(cycle.plan);
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
  });

  it("serializes different frames and coalesces each key to its latest value", async () => {
    const first = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "do",
        content: "latest do",
        frameRevision: 1,
        contentRevision: 2,
        savedAt: "2026-08-20T00:02:00.000Z",
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const plan = await screen.findByRole("textbox", { name: "P — Plan" });

    fireEvent.change(plan, { target: { value: "pending plan" } });
    fireEvent.blur(plan);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const doing = screen.getByRole("textbox", { name: "D — Do" });
    fireEvent.change(doing, { target: { value: "first do" } });
    fireEvent.change(doing, { target: { value: "latest do" } });
    fireEvent.blur(doing);
    expect(saveCycleFrame).toHaveBeenCalledOnce();

    await act(async () => {
      first.resolve({
        cycleId: cycle.id,
        frame: "plan",
        content: "pending plan",
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-08-20T00:01:00.000Z",
      });
    });
    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenNthCalledWith(
        2,
        goal.id,
        cycle.id,
        "do",
        "latest do",
        0,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
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
    expect(deleteBrowserDraftIfUnchanged).toHaveBeenCalledWith(
      session.user.id,
      `cycle:${cycle.id}:plan`,
      "自動保存後",
      0,
    );
  });

  it("requires an explicit choice before sending a mismatched draft", async () => {
    const recoveredBody = `${"😀".repeat(201)}\r末尾 \t`;
    const canonicalBody = `${"😀".repeat(201)}\n末尾 \t`;
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":plan")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: recoveredBody,
            baseRevision: 9,
            updatedAt: new Date().toISOString(),
          }
        : null,
    );
    vi.mocked(saveCycleFrame).mockResolvedValue({
      cycleId: cycle.id,
      frame: "plan",
      content: canonicalBody,
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-20T00:01:00.000Z",
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(editor).toHaveValue(canonicalBody));
    expect(editor).toHaveAttribute("readonly");
    expect(saveCycleFrame).not.toHaveBeenCalled();

    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: canonicalBody,
        baseRevision: 9,
      }),
    );
    expect(Array.from(canonicalBody).length).toBeGreaterThan(200);

    fireEvent.click(
      screen.getByRole("button", { name: "この端末の入力を復元" }),
    );

    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenCalledWith(
        goal.id,
        cycle.id,
        "plan",
        canonicalBody,
        0,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
  });

  it("keeps the original mismatch revision across persistence and reload", async () => {
    const subjectKey = `cycle:${cycle.id}:plan`;
    const localBody = "選択を待つ端末の計画";
    const browserDrafts = new Map<
      string,
      Parameters<typeof putBrowserDraft>[0]
    >([
      [
        subjectKey,
        {
          userId: session.user.id,
          goalId: goal.id,
          subjectKey,
          body: localBody,
          baseRevision: 9,
          updatedAt: "2026-08-20T00:00:30.000Z",
        },
      ],
    ]);
    vi.mocked(getBrowserDraft).mockImplementation(
      async (_userId, key) => browserDrafts.get(key) ?? null,
    );
    vi.mocked(putBrowserDraft).mockImplementation(async (record) => {
      browserDrafts.set(record.subjectKey, record);
    });
    vi.mocked(deleteBrowserDraft).mockImplementation(async (_userId, key) => {
      browserDrafts.delete(key);
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const first = renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(editor).toHaveValue(localBody));
    expect(editor).toHaveAttribute("readonly");
    await act(
      async () =>
        await new Promise<void>((resolve) => window.setTimeout(resolve, 200)),
    );
    expect(browserDrafts.get(subjectKey)?.baseRevision).toBe(9);

    first.unmount();
    renderPage(cache);

    const restored = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(restored).toHaveValue(localBody));
    expect(restored).toHaveAttribute("readonly");
    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    expect(saveCycleFrame).not.toHaveBeenCalled();
    expect(browserDrafts.get(subjectKey)?.baseRevision).toBe(9);
  });

  it("rebases a runtime cycle conflict only after the user chooses the local frame", async () => {
    const latestCycle: Cycle = {
      ...cycle,
      plan: "別の端末で保存された計画",
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    };
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValueOnce({ cycle: latestCycle });
    vi.mocked(saveCycleFrame)
      .mockRejectedValueOnce(cycleRevisionConflict())
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "plan",
        content: "この端末の計画",
        frameRevision: 2,
        contentRevision: 2,
        savedAt: "2026-08-20T00:02:00.000Z",
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "この端末の計画" } });

    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    expect(editor).toHaveValue("この端末の計画");
    expect(editor).toHaveAttribute("readonly");
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(getCycle).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectKey: `cycle:${cycle.id}:plan`,
          body: "この端末の計画",
          baseRevision: 0,
        }),
      ),
    );

    window.dispatchEvent(new Event("online"));
    fireEvent.blur(editor);
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).not.toHaveBeenCalledWith(
      session.user.id,
      `cycle:${cycle.id}:plan`,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "この端末の入力を復元" }),
    );
    expect(editor).not.toHaveAttribute("readonly");

    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledTimes(2));
    expect(saveCycleFrame).toHaveBeenLastCalledWith(
      goal.id,
      cycle.id,
      "plan",
      "この端末の計画",
      1,
      session.csrfToken,
      expect.any(AbortSignal),
    );
  });

  it("adopts the refreshed server frame and preserves an unrelated dirty frame", async () => {
    const latestCycle: Cycle = {
      ...cycle,
      plan: "別の端末で保存された計画",
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    };
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValueOnce({ cycle: latestCycle });
    vi.mocked(saveCycleFrame)
      .mockRejectedValueOnce(cycleRevisionConflict())
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "do",
        content: "この端末の実行",
        frameRevision: 1,
        contentRevision: 2,
        savedAt: "2026-08-20T00:02:00.000Z",
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const planEditor = await screen.findByRole("textbox", {
      name: "P — Plan",
    });
    fireEvent.change(planEditor, { target: { value: "この端末の計画" } });
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const doEditor = screen.getByRole("textbox", { name: "D — Do" });
    fireEvent.change(doEditor, { target: { value: "この端末の実行" } });

    await screen.findByText("保存失敗");
    fireEvent.click(screen.getByRole("tab", { name: /P\s*Plan/ }));
    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "サーバーの内容を使用" }),
    );

    expect(planEditor).toHaveValue("別の端末で保存された計画");
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    expect(doEditor).toHaveValue("この端末の実行");
    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenCalledWith(
        goal.id,
        cycle.id,
        "do",
        "この端末の実行",
        0,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
  });

  it("auto-converges when the refreshed server frame matches the failed snapshot", async () => {
    const latestCycle: Cycle = {
      ...cycle,
      plan: "応答だけ失われた計画",
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    };
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValueOnce({ cycle: latestCycle });
    vi.mocked(saveCycleFrame).mockRejectedValueOnce(cycleRevisionConflict());
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "応答だけ失われた計画" } });

    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(editor).toHaveValue("応答だけ失われた計画");
    expect(
      screen.queryByText("別の更新が見つかりました"),
    ).not.toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(getCycle).toHaveBeenCalledTimes(2);
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(deleteBrowserDraft).toHaveBeenCalledWith(
        session.user.id,
        `cycle:${cycle.id}:plan`,
      ),
    );
  });

  it("saves a newer same-frame edit at the refreshed revision after response-loss convergence", async () => {
    let resolveRefresh!: (value: { cycle: Cycle }) => void;
    const refresh = new Promise<{ cycle: Cycle }>((resolve) => {
      resolveRefresh = resolve;
    });
    const failedSnapshot = "応答を失った計画";
    const newerBody = "refresh中に追加した計画";
    const latestCycle: Cycle = {
      ...cycle,
      plan: failedSnapshot,
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    };
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle })
      .mockImplementationOnce(() => refresh);
    vi.mocked(saveCycleFrame)
      .mockRejectedValueOnce(cycleRevisionConflict())
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "plan",
        content: newerBody,
        frameRevision: 2,
        contentRevision: 2,
        savedAt: "2026-08-20T00:03:00.000Z",
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: failedSnapshot } });
    fireEvent.blur(editor);
    await waitFor(() => expect(getCycle).toHaveBeenCalledTimes(2));

    fireEvent.change(editor, { target: { value: newerBody } });
    await act(async () => resolveRefresh({ cycle: latestCycle }));

    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledTimes(2));
    expect(saveCycleFrame).toHaveBeenNthCalledWith(
      2,
      goal.id,
      cycle.id,
      "plan",
      newerBody,
      latestCycle.frameRevisions.plan,
      session.csrfToken,
      expect.any(AbortSignal),
    );
    expect(editor).toHaveValue(newerBody);
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
  });

  it("does not run cycle refresh recovery for an unrelated 409 code", async () => {
    vi.mocked(saveCycleFrame).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
        "different resource conflict",
        "60000000-0000-7000-8000-000000000002",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "競合した計画" } });
    fireEvent.blur(editor);

    expect(await screen.findByText("保存失敗")).toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(getCycle).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("別の更新が見つかりました"),
    ).not.toBeInTheDocument();
  });

  it.each(["GOAL_STATE_CONFLICT", "CYCLE_NOT_ACTIVE"] as const)(
    "resolves direct %s scope movement without resending the stale frame",
    async (code) => {
      const movedToReview = code === "GOAL_STATE_CONFLICT";
      const canonicalGoal: Goal = movedToReview
        ? {
            ...goal,
            status: "goal_review",
            revision: goal.revision + 1,
            currentWork: {
              kind: "goal_review",
              reviewDraftId,
              triggerCycleId: cycle.id,
              triggerCycleSequenceNumber: cycle.sequenceNumber,
            },
          }
        : {
            ...goal,
            revision: goal.revision + 1,
            currentWork: {
              kind: "active_cycle",
              cycleId: currentCycleId,
              cycleSequenceNumber: 2,
            },
            nextCycleSequenceNumber: 3,
            cycleCount: 2,
          };
      const canonicalCycle: Cycle = movedToReview
        ? {
            ...cycle,
            status: "completed",
            completedAt: "2026-08-20T00:06:00.000Z",
          }
        : {
            ...cycle,
            id: currentCycleId,
            sequenceNumber: 2,
            plan: "現在のサイクルの計画",
          };
      vi.mocked(getGoal)
        .mockReset()
        .mockResolvedValueOnce({ goal })
        .mockResolvedValueOnce({ goal: canonicalGoal });
      vi.mocked(getCycle)
        .mockReset()
        .mockResolvedValueOnce({ cycle })
        .mockResolvedValueOnce({ cycle: canonicalCycle });
      vi.mocked(saveCycleFrame)
        .mockReset()
        .mockRejectedValueOnce(
          new APIError(409, code, "workspace moved", "request-moved"),
        );
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache);

      const editor = await screen.findByRole("textbox", { name: "P — Plan" });
      fireEvent.change(editor, { target: { value: "移動前の端末の計画" } });
      fireEvent.blur(editor);

      expect(
        await screen.findByText("現在の作業状態が更新されました"),
      ).toBeInTheDocument();
      expect(editor).toHaveValue("移動前の端末の計画");
      expect(editor).toHaveAttribute("readonly");
      expect(saveCycleFrame).toHaveBeenCalledOnce();
      expect(getGoal).toHaveBeenCalledTimes(2);
      expect(getCycle).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("button", { name: "再試行" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "現在の作業へ移動" }),
      ).toHaveAttribute(
        "href",
        movedToReview
          ? `/goals/${goal.id}/review`
          : `/goals/${goal.id}/cycles/${currentCycleId}`,
      );
    },
  );

  it("retries a failed refresh without resending the stale frame or losing local input after the workspace moves", async () => {
    const movedGoal: Goal = {
      ...goal,
      revision: goal.revision + 1,
      currentWork: {
        kind: "active_cycle",
        cycleId: currentCycleId,
        cycleSequenceNumber: 2,
      },
      nextCycleSequenceNumber: 3,
      cycleCount: 2,
    };
    const movedCycle: Cycle = {
      ...cycle,
      id: currentCycleId,
      sequenceNumber: 2,
      plan: "現在のサイクルの計画",
    };
    vi.mocked(getGoal)
      .mockReset()
      .mockResolvedValueOnce({ goal })
      .mockRejectedValueOnce(new TypeError("refresh failed"))
      .mockResolvedValueOnce({ goal: movedGoal });
    vi.mocked(getCycle)
      .mockReset()
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValueOnce({ cycle: movedCycle });
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockRejectedValueOnce(cycleRevisionConflict());
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "移動前のこの端末の計画" } });

    expect(
      await screen.findByText(
        "最新の内容を取得できませんでした。入力は保持されています。再試行してください。",
      ),
    ).toBeInTheDocument();
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(getGoal).toHaveBeenCalledTimes(2);
    await act(async () => undefined);
    vi.mocked(putBrowserDraft).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "再試行" }));

    expect(
      await screen.findByText("現在の作業状態が更新されました"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("この端末の入力は保持されています。"),
    ).toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledTimes(3);
    expect(getCycle).toHaveBeenLastCalledWith(
      goal.id,
      currentCycleId,
      expect.any(AbortSignal),
    );
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(editor).toHaveValue("移動前のこの端末の計画");
    const canonicalLink = screen.getByRole("link", {
      name: "現在の作業へ移動",
    });
    expect(canonicalLink).toHaveAttribute(
      "href",
      `/goals/${goal.id}/cycles/${currentCycleId}`,
    );
    expect(editor).toHaveAttribute("readonly");
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectKey: `cycle:${cycle.id}:plan`,
          body: "移動前のこの端末の計画",
          baseRevision: 0,
        }),
      ),
    );
    expect(saveCycleFrame).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("online"));
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 50)));
    expect(getGoal).toHaveBeenCalledTimes(3);
    expect(getCycle).toHaveBeenCalledTimes(2);
    expect(saveCycleFrame).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "completed cycle to goal review",
      terminalCycle: {
        ...cycle,
        status: "completed",
        completedAt: "2026-08-20T00:06:00.000Z",
      },
      canonicalGoal: {
        ...goal,
        status: "goal_review",
        revision: goal.revision + 1,
        currentWork: {
          kind: "goal_review",
          reviewDraftId,
          triggerCycleId: cycle.id,
          triggerCycleSequenceNumber: cycle.sequenceNumber,
        },
      },
      expectedHref: `/goals/${goal.id}/review`,
    },
    {
      label: "canceled cycle to terminal history",
      terminalCycle: {
        ...cycle,
        status: "canceled",
        canceledAt: "2026-08-20T00:06:00.000Z",
        cancellationReason: "goal_ended",
      },
      canonicalGoal: {
        ...goal,
        status: "ended",
        revision: goal.revision + 1,
        currentWork: null,
        terminalAt: "2026-08-20T00:06:00.000Z",
      },
      expectedHref: `/history/goals/${goal.id}`,
    },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly terminalCycle: Cycle;
    readonly canonicalGoal: Goal;
    readonly expectedHref: string;
  }>)(
    "rechecks canonical Goal after $label and never links back to the stale workspace",
    async ({ terminalCycle, canonicalGoal, expectedHref }) => {
      const localBody = "terminal確認中も保持する計画";
      vi.mocked(getGoal)
        .mockReset()
        .mockResolvedValueOnce({ goal })
        .mockResolvedValueOnce({ goal })
        .mockResolvedValueOnce({ goal: canonicalGoal });
      vi.mocked(getCycle)
        .mockReset()
        .mockResolvedValueOnce({ cycle })
        .mockResolvedValueOnce({ cycle: terminalCycle });
      vi.mocked(saveCycleFrame)
        .mockReset()
        .mockRejectedValueOnce(cycleRevisionConflict());
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache);

      const editor = await screen.findByRole("textbox", { name: "P — Plan" });
      fireEvent.change(editor, { target: { value: localBody } });
      fireEvent.blur(editor);

      expect(
        await screen.findByText("現在の作業状態が更新されました"),
      ).toBeInTheDocument();
      expect(getGoal).toHaveBeenCalledTimes(3);
      expect(getCycle).toHaveBeenCalledTimes(2);
      expect(editor).toHaveValue(localBody);
      expect(editor).toHaveAttribute("readonly");
      expect(
        screen.queryByRole("button", { name: "再試行" }),
      ).not.toBeInTheDocument();

      const canonicalLink = screen.getByRole("link", {
        name: "現在の作業へ移動",
      });
      expect(canonicalLink).toHaveAttribute("href", expectedHref);
      expect(canonicalLink).not.toHaveAttribute(
        "href",
        `/goals/${goal.id}/cycles/${cycle.id}`,
      );

      fireEvent.blur(editor);
      window.dispatchEvent(new Event("online"));
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 50)));
      expect(getGoal).toHaveBeenCalledTimes(3);
      expect(getCycle).toHaveBeenCalledTimes(2);
      expect(saveCycleFrame).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: "completed cache to goal review",
      cachedTerminalCycle: {
        ...cycle,
        status: "completed",
        completedAt: "2026-08-20T00:06:30.000Z",
      },
      confirmedGoal: {
        ...goal,
        status: "goal_review",
        revision: goal.revision + 1,
        currentWork: {
          kind: "goal_review",
          reviewDraftId,
          triggerCycleId: cycle.id,
          triggerCycleSequenceNumber: cycle.sequenceNumber,
        },
      },
      expectedHref: `/goals/${goal.id}/review`,
    },
    {
      label: "canceled cache to terminal history",
      cachedTerminalCycle: {
        ...cycle,
        status: "canceled",
        canceledAt: "2026-08-20T00:06:30.000Z",
        cancellationReason: "goal_ended",
      },
      confirmedGoal: {
        ...goal,
        status: "ended",
        revision: goal.revision + 1,
        currentWork: null,
        terminalAt: "2026-08-20T00:06:30.000Z",
      },
      expectedHref: `/history/goals/${goal.id}`,
    },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly cachedTerminalCycle: Cycle;
    readonly confirmedGoal: Goal;
    readonly expectedHref: string;
  }>)(
    "rechecks canonical Goal when raw active Cycle loses to a $label",
    async ({ cachedTerminalCycle, confirmedGoal, expectedHref }) => {
      let resolveRawCycle!: (value: { cycle: Cycle }) => void;
      const rawCycle = new Promise<{ cycle: Cycle }>((resolve) => {
        resolveRawCycle = resolve;
      });
      const localBody = "cache先行terminalでも保持する計画";
      vi.mocked(getGoal)
        .mockReset()
        .mockResolvedValueOnce({ goal })
        .mockResolvedValueOnce({ goal })
        .mockResolvedValueOnce({ goal: confirmedGoal });
      vi.mocked(getCycle)
        .mockReset()
        .mockResolvedValueOnce({ cycle })
        .mockImplementationOnce(() => rawCycle);
      vi.mocked(saveCycleFrame)
        .mockReset()
        .mockRejectedValueOnce(cycleRevisionConflict());
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache);

      const editor = await screen.findByRole("textbox", { name: "P — Plan" });
      fireEvent.change(editor, { target: { value: localBody } });
      fireEvent.blur(editor);
      await waitFor(() => expect(getCycle).toHaveBeenCalledTimes(2));

      act(() => {
        cache.setQueryData(
          userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
          { cycle: cachedTerminalCycle },
        );
      });
      await act(async () => resolveRawCycle({ cycle }));

      expect(
        await screen.findByText("現在の作業状態が更新されました"),
      ).toBeInTheDocument();
      expect(getGoal).toHaveBeenCalledTimes(3);
      expect(getCycle).toHaveBeenCalledTimes(2);
      expect(
        cache.getQueryData<{ cycle: Cycle }>(
          userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
        )?.cycle,
      ).toEqual(cachedTerminalCycle);
      expect(editor).toHaveValue(localBody);
      expect(editor).toHaveAttribute("readonly");

      const canonicalLink = screen.getByRole("link", {
        name: "現在の作業へ移動",
      });
      expect(canonicalLink).toHaveAttribute("href", expectedHref);
      expect(canonicalLink).not.toHaveAttribute(
        "href",
        `/goals/${goal.id}/cycles/${cycle.id}`,
      );
      expect(
        screen.queryByRole("button", { name: "再試行" }),
      ).not.toBeInTheDocument();

      window.dispatchEvent(new Event("online"));
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 50)));
      expect(getGoal).toHaveBeenCalledTimes(3);
      expect(getCycle).toHaveBeenCalledTimes(2);
      expect(saveCycleFrame).toHaveBeenCalledOnce();
    },
  );

  it("keeps the restored baseline in browser recovery after moved-link unmount", async () => {
    let rejectPatch!: (reason: unknown) => void;
    const inFlightPatch = new Promise<
      Awaited<ReturnType<typeof saveCycleFrame>>
    >((_resolve, reject) => {
      rejectPatch = reject;
    });
    const terminalCycle: Cycle = {
      ...cycle,
      status: "completed",
      completedAt: "2026-08-20T00:07:00.000Z",
      plan: "server Y",
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    };
    const reviewGoal: Goal = {
      ...goal,
      status: "goal_review",
      revision: goal.revision + 1,
      currentWork: {
        kind: "goal_review",
        reviewDraftId,
        triggerCycleId: cycle.id,
        triggerCycleSequenceNumber: cycle.sequenceNumber,
      },
    };
    const browserDrafts = new Map<
      string,
      Parameters<typeof putBrowserDraft>[0]
    >();
    vi.mocked(getBrowserDraft).mockImplementation(
      async (_userId, subjectKey) => browserDrafts.get(subjectKey) ?? null,
    );
    vi.mocked(putBrowserDraft).mockImplementation(async (record) => {
      browserDrafts.set(record.subjectKey, record);
    });
    vi.mocked(deleteBrowserDraft).mockImplementation(
      async (_userId, subjectKey) => {
        browserDrafts.delete(subjectKey);
      },
    );
    vi.mocked(getGoal)
      .mockReset()
      .mockResolvedValueOnce({ goal })
      .mockResolvedValueOnce({ goal })
      .mockResolvedValueOnce({ goal: reviewGoal });
    vi.mocked(getCycle)
      .mockReset()
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValueOnce({ cycle: terminalCycle });
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockImplementationOnce(() => inFlightPatch);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "in-flight X" } });
    fireEvent.blur(editor);
    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenCalledWith(
        goal.id,
        cycle.id,
        "plan",
        "in-flight X",
        0,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );

    fireEvent.change(editor, { target: { value: cycle.plan } });
    await act(async () => {
      rejectPatch(cycleRevisionConflict());
    });

    const movedLink = await screen.findByRole("link", {
      name: "現在の作業へ移動",
    });
    const planDraftKey = `cycle:${cycle.id}:plan`;
    await waitFor(() =>
      expect(browserDrafts.get(planDraftKey)).toEqual(
        expect.objectContaining({
          body: cycle.plan,
          baseRevision: 0,
        }),
      ),
    );

    fireEvent.click(movedLink);
    expect(await screen.findByText("現在の目標レビュー")).toBeInTheDocument();
    await act(async () => undefined);

    expect(browserDrafts.get(planDraftKey)).toEqual(
      expect.objectContaining({
        body: cycle.plan,
        baseRevision: 0,
      }),
    );
    expect(deleteBrowserDraft).not.toHaveBeenCalledWith(
      session.user.id,
      planDraftKey,
    );
    expect(saveCycleFrame).toHaveBeenCalledOnce();
  });

  it("resumes GET-only conflict recovery after a rejected delete command", async () => {
    let resolveStaleCycle!: (value: { cycle: Cycle }) => void;
    const staleCycle = new Promise<{ cycle: Cycle }>((resolve) => {
      resolveStaleCycle = resolve;
    });
    const localBody = "削除command中も保持する計画";
    const latestCycle: Cycle = {
      ...cycle,
      plan: "別端末の計画",
      contentRevision: 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    };
    const browserDrafts = new Map<
      string,
      Parameters<typeof putBrowserDraft>[0]
    >();
    vi.mocked(getBrowserDraft).mockImplementation(
      async (_userId, subjectKey) => browserDrafts.get(subjectKey) ?? null,
    );
    vi.mocked(putBrowserDraft).mockImplementation(async (record) => {
      browserDrafts.set(record.subjectKey, record);
    });
    vi.mocked(deleteBrowserDraft).mockImplementation(
      async (_userId, subjectKey) => {
        browserDrafts.delete(subjectKey);
      },
    );
    vi.mocked(getGoal).mockReset().mockResolvedValue({ goal });
    vi.mocked(getCycle)
      .mockReset()
      .mockResolvedValueOnce({ cycle })
      .mockImplementationOnce(() => staleCycle)
      .mockRejectedValueOnce(new TypeError("resume refresh failed"))
      .mockResolvedValueOnce({ cycle: latestCycle });
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockRejectedValueOnce(cycleRevisionConflict())
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "plan",
        content: localBody,
        frameRevision: 2,
        contentRevision: 2,
        savedAt: "2026-08-20T00:03:00.000Z",
      });
    vi.mocked(deleteGoal)
      .mockReset()
      .mockRejectedValueOnce(new Error("delete rejected"));
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);
    await waitFor(() => expect(getCycle).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText("目標の操作"));
    fireEvent.click(screen.getByRole("button", { name: "目標を削除" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "目標を削除" }));

    await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());
    await waitFor(() => expect(getCycle).toHaveBeenCalledTimes(3));
    expect(
      await screen.findByText(
        "最新の内容を取得できませんでした。入力は保持されています。再試行してください。",
      ),
    ).toBeInTheDocument();

    await act(async () => resolveStaleCycle({ cycle }));

    expect(editor).toHaveValue(localBody);
    expect(screen.getByText("保存失敗")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "再試行" });
    const planDraftKey = `cycle:${cycle.id}:plan`;
    await waitFor(() =>
      expect(browserDrafts.get(planDraftKey)).toEqual(
        expect.objectContaining({
          body: localBody,
          baseRevision: 0,
        }),
      ),
    );
    expect(saveCycleFrame).toHaveBeenCalledOnce();

    fireEvent.click(retry);

    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledTimes(4);
    expect(getCycle).toHaveBeenCalledTimes(4);
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    expect(browserDrafts.get(planDraftKey)).toEqual(
      expect.objectContaining({
        body: localBody,
        baseRevision: 0,
      }),
    );
    expect(deleteBrowserDraft).not.toHaveBeenCalledWith(
      session.user.id,
      planDraftKey,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "この端末の入力を復元" }),
    );
    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenLastCalledWith(
        goal.id,
        cycle.id,
        "plan",
        localBody,
        latestCycle.frameRevisions.plan,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    expect(saveCycleFrame).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");
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

  it("disables both AI commands while a terminal command is pending", async () => {
    const completion = deferred<Awaited<ReturnType<typeof completeCycle>>>();
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(completeCycle).mockReturnValue(completion.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await confirmCycleCompletion();
    await waitFor(() => expect(completeCycle).toHaveBeenCalledOnce());

    expect(
      screen.getByRole("button", { name: "アクションを生成" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "AIで推敲" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "AIで推敲" }));
    expect(refineAction).not.toHaveBeenCalled();
  });

  it("ignores a Complete result that arrives after navigating to another Cycle", async () => {
    const completion = deferred<Awaited<ReturnType<typeof completeCycle>>>();
    const nextCycle: Cycle = {
      ...completableCycle,
      id: currentCycleId,
      sequenceNumber: 2,
      plan: "次のCycleの計画",
    };
    vi.mocked(getCycle).mockImplementation(async (_goalId, requestedCycleId) =>
      requestedCycleId === nextCycle.id
        ? { cycle: nextCycle }
        : { cycle: completableCycle },
    );
    vi.mocked(completeCycle).mockReturnValue(completion.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { switchCycleId: nextCycle.id });

    await confirmCycleCompletion();
    await waitFor(() => expect(completeCycle).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("link", { name: "別のCycleへ移動" }));
    expect(
      await screen.findByDisplayValue("次のCycleの計画"),
    ).toBeInTheDocument();
    vi.mocked(deleteBrowserDraft).mockClear();
    vi.mocked(clearGoalDrafts).mockClear();

    await act(async () => completion.resolve(goalReviewReplay));
    await act(async () => undefined);

    expect(screen.getByDisplayValue("次のCycleの計画")).toBeInTheDocument();
    expect(screen.queryByText("現在の目標レビュー")).not.toBeInTheDocument();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(completeCycle).toHaveBeenCalledOnce();
  });

  it("ignores a late AI result after identity quiescence", async () => {
    const readyCycle: Cycle = {
      ...completableCycle,
      action: "切替前のA",
    };
    const refinement = deferred<Awaited<ReturnType<typeof refineAction>>>();
    vi.mocked(getCycle).mockResolvedValue({ cycle: readyCycle });
    vi.mocked(refineAction).mockReturnValue(refinement.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { identityQuiesceControl: true });

    fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
    const editor = screen.getByRole("textbox", { name: "A — Action" });
    fireEvent.click(screen.getByRole("button", { name: "AIで推敲" }));
    await waitFor(() => expect(refineAction).toHaveBeenCalledOnce());

    fireEvent.click(
      screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
    );
    expect(await screen.findByText("切替準備完了")).toBeInTheDocument();

    await act(async () =>
      refinement.resolve({
        generationId: "60000000-0000-7000-8000-000000000003",
        action: "切替後に届いたA",
        actionRevision: 2,
        contentRevision: 5,
        contextChanged: false,
      }),
    );
    await act(async () => undefined);

    expect(editor).toHaveValue("切替前のA");
    expect(
      cache.getQueryData<{ readonly cycle: Cycle }>(
        userQueryKeys.cycle(session.user.id, goal.id, readyCycle.id),
      )?.cycle.action,
    ).toBe("切替前のA");
    expect(screen.queryByText("現在の目標レビュー")).not.toBeInTheDocument();
  });

  it("retries Complete browser cleanup without resending Complete", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(completeCycle).mockResolvedValue(goalReviewReplay);
    vi.mocked(deleteBrowserDraft)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValue(undefined);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await confirmCycleCompletion();

    expect(
      await screen.findByText(
        "サイクルは完了しましたが、この端末の復旧用保存を削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(completeCycle).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "端末データの削除を再試行" }),
    );

    expect(await screen.findByText("現在の目標レビュー")).toBeInTheDocument();
    expect(completeCycle).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).toHaveBeenCalledTimes(5);
    for (const frame of ["plan", "do", "check", "action"])
      expect(deleteBrowserDraft).toHaveBeenCalledWith(
        session.user.id,
        "cycle:" + completableCycle.id + ":" + frame,
      );
  });

  it("retries Delete browser cleanup without resending Delete", async () => {
    vi.mocked(deleteGoal).mockResolvedValue(undefined);
    vi.mocked(clearGoalDrafts)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValue(undefined);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByRole("textbox", { name: "P — Plan" });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    fireEvent.click(screen.getByText("目標の操作"));
    fireEvent.click(screen.getByRole("button", { name: "目標を削除" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "目標を削除",
      }),
    );

    expect(
      await screen.findByText(
        "目標は削除されましたが、この端末の復旧用保存を削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "端末データの削除を再試行" }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).toHaveBeenCalledTimes(2);
  });

  it("retries Terminate browser cleanup without resending Terminate", async () => {
    vi.mocked(terminateGoal).mockResolvedValue({
      goal: {
        ...goal,
        status: "ended",
        revision: goal.revision + 1,
        currentWork: null,
        terminalAt: "2026-08-20T00:03:00.000Z",
      },
      canceledCycle: {
        ...cycle,
        status: "canceled",
        canceledAt: "2026-08-20T00:03:00.000Z",
        cancellationReason: "goal_ended",
      },
    });
    vi.mocked(clearGoalDrafts)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValue(undefined);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByRole("textbox", { name: "P — Plan" });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    fireEvent.click(screen.getByText("目標の操作"));
    fireEvent.click(screen.getByRole("button", { name: "目標を終了" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "目標を終了",
      }),
    );

    expect(
      await screen.findByText(
        "目標の終了は完了しましたが、この端末の復旧用保存を削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(terminateGoal).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "端末データの削除を再試行" }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(terminateGoal).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).toHaveBeenCalledTimes(2);
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

function renderPage(
  cache: QueryClient,
  options: {
    readonly identityQuiesceControl?: boolean;
    readonly strictMode?: boolean;
    readonly switchCycleId?: string;
  } = {},
) {
  const tree = (
    <QueryClientProvider client={cache}>
      <AutoSaveScopeProvider>
        <SessionContext.Provider value={session}>
          <MemoryRouter
            initialEntries={[`/workspace/${goal.id}/cycles/${cycle.id}`]}
          >
            {options.identityQuiesceControl ? <IdentityQuiesceControl /> : null}
            <PostCommitCleanupBoundary>
              {options.switchCycleId ? (
                <Link
                  to={`/workspace/${goal.id}/cycles/${options.switchCycleId}`}
                >
                  別のCycleへ移動
                </Link>
              ) : null}
              <Routes>
                <Route
                  path="/workspace/:goalId/cycles/:cycleId"
                  element={<GoalWorkspacePage />}
                />
                <Route path="/" element={<p>ホーム</p>} />
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
            </PostCommitCleanupBoundary>
          </MemoryRouter>
        </SessionContext.Provider>
      </AutoSaveScopeProvider>
    </QueryClientProvider>
  );
  return render(options.strictMode ? <StrictMode>{tree}</StrictMode> : tree);
}

function IdentityQuiesceControl() {
  const registry = useAutoSaveScopeRegistry();
  const [quiesced, setQuiesced] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void registry
            .quiesce({ preserveDrafts: true })
            .then(() => setQuiesced(true));
        }}
      >
        異なるUserへの切替を模擬
      </button>
      {quiesced ? <p>切替準備完了</p> : null}
    </>
  );
}

function cycleRevisionConflict() {
  return new APIError(
    409,
    "CYCLE_REVISION_CONFLICT",
    "cycle revision conflict",
    "60000000-0000-7000-8000-000000000001",
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
