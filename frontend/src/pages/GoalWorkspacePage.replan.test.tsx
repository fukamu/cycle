import { QueryClient } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { userQueryKeys } from "../features/goal-collection/goalCache";
import { APIError } from "../shared/api/client";
import type { Cycle } from "../shared/api/schemas";
import {
  getCycle,
  getGoal,
  refineAction,
  replanCycle,
  saveCycleFrame,
} from "../shared/api/workspace";
import {
  clearCycleDrafts,
  getBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import {
  completableCycle,
  createGoalDeletionAdvisoryHarness,
  cycle,
  deferred,
  goal,
  registerGoalWorkspacePageTestLifecycle,
  renderPage,
  replannedGoal,
  replannedSourceCycle,
  replannedSuccessorCycle,
  session,
  sessionLease,
} from "./GoalWorkspacePage.test-harness";

vi.mock("../shared/api/workspace", () => ({
  completeCycle: vi.fn(),
  deleteGoal: vi.fn(),
  generateAction: vi.fn(),
  getCycle: vi.fn(),
  getGoal: vi.fn(),
  replanCycle: vi.fn(),
  refineAction: vi.fn(),
  saveCycleFrame: vi.fn(),
  terminateGoal: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  clearCycleDrafts: vi.fn(),
  clearGoalDrafts: vi.fn(),
  deleteBrowserDraft: vi.fn(),
  deleteBrowserDraftIfUnchanged: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
  tombstoneDeletedGoalAndClearDrafts: vi.fn(),
}));

describe("GoalWorkspacePage: replan", () => {
  registerGoalWorkspacePageTestLifecycle();

  it("flushes every pending Frame before showing the Replan confirmation", async () => {
    const saving = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    vi.mocked(saveCycleFrame).mockReturnValue(saving.promise);
    vi.mocked(replanCycle).mockResolvedValue({
      canceledCycle: replannedSourceCycle,
      goal: replannedGoal,
      cycle: replannedSuccessorCycle,
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await screen.findByText("保存済み");
    fireEvent.change(editor, { target: { value: "再計画前に保存するP" } });
    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );

    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(replanCycle).not.toHaveBeenCalled();

    await act(async () =>
      saving.resolve({
        cycleId: cycle.id,
        frame: "plan",
        content: "再計画前に保存するP",
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-09-16T00:00:00.000Z",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "このCycleを中断して再計画しますか？",
    });
    expect(replanCycle).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "中断して再計画" }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    expect(replanCycle).toHaveBeenCalledWith(
      sessionLease,
      goal.id,
      cycle.id,
      0,
      1,
      0,
      expect.objectContaining({ csrfToken: session.csrfToken }),
    );
    expect(await screen.findByText("現在のサイクル")).toBeVisible();
    expect(clearCycleDrafts).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
      cycle.id,
    );
  });

  it("preserves a terminal successor snapshot after a late active Replan response", async () => {
    vi.mocked(replanCycle).mockResolvedValue({
      canceledCycle: replannedSourceCycle,
      goal: replannedGoal,
      cycle: replannedSuccessorCycle,
    });
    const laterSuccessor: Cycle = {
      ...replannedSuccessorCycle,
      status: "completed",
      completedAt: "2026-09-17T00:00:00.000Z",
      plan: "すでに完了した次Cycle",
      do: "実行済み",
      check: "確認済み",
      action: "改善済み",
      contentRevision: 4,
      frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
    };
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    await screen.findByText("保存済み");
    cache.setQueryData(
      userQueryKeys.cycle(session.user.id, goal.id, replannedSuccessorCycle.id),
      { cycle: laterSuccessor },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "このCycleを中断して再計画しますか？",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", {
        name: "中断して再計画",
      }),
    );

    expect(await screen.findByText("現在の目標")).toBeVisible();
    expect(
      cache.getQueryData<{ readonly cycle: Cycle }>(
        userQueryKeys.cycle(
          session.user.id,
          goal.id,
          replannedSuccessorCycle.id,
        ),
      )?.cycle,
    ).toEqual(laterSuccessor);
  });

  it("cleans the old Cycle draft without publishing after route leave", async () => {
    const replanning = deferred<Awaited<ReturnType<typeof replanCycle>>>();
    vi.mocked(replanCycle).mockReturnValue(replanning.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { commandRouteSwitch: true });
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", { name: "コマンド中に外部routeへ移動" }),
    );
    expect(await screen.findByText("外部route")).toBeVisible();

    await act(async () =>
      replanning.resolve({
        canceledCycle: replannedSourceCycle,
        goal: replannedGoal,
        cycle: replannedSuccessorCycle,
      }),
    );

    await waitFor(() => expect(clearCycleDrafts).toHaveBeenCalledOnce());
    expect(await screen.findByText("外部route")).toBeVisible();
    expect(
      cache.getQueryData(
        userQueryKeys.cycle(
          session.user.id,
          goal.id,
          replannedSuccessorCycle.id,
        ),
      ),
    ).toBeUndefined();
    expect(
      cache.getQueryData<{ readonly cycle: Cycle }>(
        userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
      )?.cycle.status,
    ).toBe("active");
  });

  it("keeps a newer route generation after a late Replan success", async () => {
    const replanning = deferred<Awaited<ReturnType<typeof replanCycle>>>();
    vi.mocked(replanCycle).mockReturnValue(replanning.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { sameRouteSwitch: true });
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("link", { name: "同じ画面を再表示" }));

    await act(async () =>
      replanning.resolve({
        canceledCycle: replannedSourceCycle,
        goal: replannedGoal,
        cycle: replannedSuccessorCycle,
      }),
    );

    await waitFor(() => expect(clearCycleDrafts).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("link", { name: "同じ画面を再表示" }),
    ).toBeVisible();
    expect(screen.queryByText("現在のサイクル")).not.toBeInTheDocument();
    expect(
      cache.getQueryData(
        userQueryKeys.cycle(
          session.user.id,
          goal.id,
          replannedSuccessorCycle.id,
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps the deleted-Goal fence after GOAL_NOT_FOUND arrives off-route", async () => {
    const replanning = deferred<never>();
    vi.mocked(replanCycle).mockReturnValue(replanning.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const advisory = createGoalDeletionAdvisoryHarness();
    renderPage(cache, {
      commandRouteSwitch: true,
      goalDeletionAdvisory: advisory,
    });
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", { name: "コマンド中に外部routeへ移動" }),
    );
    await screen.findByText("外部route");
    await act(async () =>
      replanning.reject(
        new APIError(
          404,
          "GOAL_NOT_FOUND",
          "deleted",
          "request-late-replan-deleted-goal",
        ),
      ),
    );

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(screen.getByText("外部route")).toBeVisible();
    expect(advisory.publish).toHaveBeenCalled();
    expect(getGoal).toHaveBeenCalledOnce();
  });

  it("does not refresh stale UI when a known Replan conflict arrives off-route", async () => {
    const replanning = deferred<never>();
    vi.mocked(replanCycle).mockReturnValue(replanning.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { commandRouteSwitch: true });
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", { name: "コマンド中に外部routeへ移動" }),
    );
    await screen.findByText("外部route");
    await act(async () =>
      replanning.reject(
        new APIError(
          409,
          "CYCLE_REVISION_CONFLICT",
          "stale",
          "request-late-replan-conflict",
        ),
      ),
    );

    expect(screen.getByText("外部route")).toBeVisible();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(getCycle).toHaveBeenCalledOnce();
    expect(clearCycleDrafts).not.toHaveBeenCalled();
  });

  it("releases Replan ownership after a known failure on a newer route generation", async () => {
    const replanning = deferred<never>();
    vi.mocked(replanCycle).mockReturnValue(replanning.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { sameRouteSwitch: true });
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("link", { name: "同じ画面を再表示" }));
    await act(async () =>
      replanning.reject(
        new APIError(
          409,
          "CYCLE_REVISION_CONFLICT",
          "stale",
          "request-newer-route-replan-conflict",
        ),
      ),
    );

    const replan = screen.getByRole("button", {
      name: "このCycleを中断して再計画",
    });
    await waitFor(() => expect(replan).toBeEnabled());
    expect(editor).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(getCycle).toHaveBeenCalledOnce();
  });

  it("checks canonical state after an ambiguous failure on a newer route generation", async () => {
    const replanning = deferred<never>();
    vi.mocked(replanCycle).mockReturnValue(replanning.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { sameRouteSwitch: true });
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("link", { name: "同じ画面を再表示" }));
    await act(async () => replanning.reject(new TypeError("response lost")));

    expect(
      await screen.findByRole("link", { name: "現在の作業へ移動" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(getCycle).toHaveBeenCalledTimes(2);
  });

  it("keeps Replan disabled until Browser Draft hydration is saved", async () => {
    const hydration = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    const draftBody = "起動時に見つかった同revisionの計画";
    vi.mocked(getBrowserDraft).mockImplementation((_userId, key) =>
      key.endsWith(":plan") ? hydration.promise : Promise.resolve(null),
    );
    vi.mocked(saveCycleFrame).mockImplementation(
      async (_lease, _goalId, _cycleId, frame, content) => ({
        cycleId: cycle.id,
        frame,
        content,
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-09-16T00:00:00.000Z",
      }),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const replan = await screen.findByRole("button", {
      name: "このCycleを中断して再計画",
    });

    expect(replan).toBeDisabled();
    expect(replan).toHaveAccessibleDescription(
      "この端末の入力を確認しています。完了後に再計画できます。",
    );
    fireEvent.click(replan);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await act(async () =>
      hydration.resolve({
        userId: session.user.id,
        goalId: goal.id,
        subjectKey: `cycle:${cycle.id}:plan`,
        body: draftBody,
        baseRevision: cycle.frameRevisions.plan,
        updatedAt: "2026-09-16T00:00:00.000Z",
      }),
    );

    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenCalledWith(
        sessionLease,
        goal.id,
        cycle.id,
        "plan",
        draftBody,
        0,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(replan).toBeEnabled());
    fireEvent.click(replan);
    expect(
      await screen.findByRole("dialog", {
        name: "このCycleを中断して再計画しますか？",
      }),
    ).toBeVisible();
  });

  it("offers only explicit discard when a Frame save failed before Replan", async () => {
    vi.mocked(saveCycleFrame).mockRejectedValue(
      new APIError(
        409,
        "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
        "save failed",
        "request-frame-save-failed",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await screen.findByText("保存済み");
    fireEvent.change(editor, { target: { value: "保存に失敗した計画" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalled());
    await screen.findByText("保存失敗");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );

    expect(
      await screen.findByRole("dialog", {
        name: "未保存の内容を破棄して再計画しますか？",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", {
        name: "このCycleを中断して再計画しますか？",
      }),
    ).not.toBeInTheDocument();
    expect(replanCycle).not.toHaveBeenCalled();
  });

  it("requires explicit discard for a Browser Draft conflict before Replan", async () => {
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key === `cycle:${cycle.id}:plan`
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "競合している端末下書き",
            baseRevision: 99,
            updatedAt: "2026-09-16T00:00:00.000Z",
          }
        : null,
    );
    vi.mocked(replanCycle).mockResolvedValue({
      canceledCycle: replannedSourceCycle,
      goal: replannedGoal,
      cycle: replannedSuccessorCycle,
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    await screen.findByText("別の更新が見つかりました");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "未保存の内容を破棄して再計画しますか？",
    });
    expect(replanCycle).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "未保存内容を破棄して再計画",
      }),
    );
    await waitFor(() => expect(replanCycle).toHaveBeenCalledOnce());
    expect(clearCycleDrafts).toHaveBeenCalledBefore(vi.mocked(replanCycle));
  });

  it("keeps the Browser Draft and sends nothing when discard is canceled", async () => {
    const draftBody = "破棄をキャンセルする端末下書き";
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key === `cycle:${cycle.id}:plan`
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: draftBody,
            baseRevision: 99,
            updatedAt: "2026-09-16T00:00:00.000Z",
          }
        : null,
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await screen.findByText("別の更新が見つかりました");
    const replan = screen.getByRole("button", {
      name: "このCycleを中断して再計画",
    });

    fireEvent.click(replan);
    const dialog = await screen.findByRole("dialog", {
      name: "未保存の内容を破棄して再計画しますか？",
    });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(replan).toHaveFocus());
    expect(editor).toHaveValue(draftBody);
    expect(clearCycleDrafts).not.toHaveBeenCalled();
    expect(replanCycle).not.toHaveBeenCalled();
  });

  it("does not send Replan when the local discard transaction fails", async () => {
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key === `cycle:${cycle.id}:plan`
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "削除できない端末下書き",
            baseRevision: 99,
            updatedAt: "2026-09-16T00:00:00.000Z",
          }
        : null,
    );
    vi.mocked(clearCycleDrafts).mockRejectedValue(new Error("indexeddb"));
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    await screen.findByText("別の更新が見つかりました");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "未保存内容を破棄して再計画",
      }),
    );

    expect(
      await screen.findByText(/下書きを削除できなかったため/),
    ).toBeVisible();
    expect(replanCycle).not.toHaveBeenCalled();
  });

  it("does not send Replan when the route changes during local discard", async () => {
    const cleanup = deferred<void>();
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key === `cycle:${cycle.id}:plan`
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "route移動前の端末下書き",
            baseRevision: 99,
            updatedAt: "2026-09-16T00:00:00.000Z",
          }
        : null,
    );
    vi.mocked(clearCycleDrafts).mockReturnValue(cleanup.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { commandRouteSwitch: true });
    await screen.findByText("別の更新が見つかりました");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "未保存内容を破棄して再計画",
      }),
    );
    await waitFor(() => expect(clearCycleDrafts).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", { name: "コマンド中に外部routeへ移動" }),
    );
    expect(await screen.findByText("外部route")).toBeVisible();
    await act(async () => cleanup.resolve());

    expect(replanCycle).not.toHaveBeenCalled();
  });

  it("explains discarded input loss and restores focus after a definite Replan failure", async () => {
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key === `cycle:${cycle.id}:plan`
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "破棄する端末下書き",
            baseRevision: 99,
            updatedAt: "2026-09-16T00:00:00.000Z",
          }
        : null,
    );
    vi.mocked(replanCycle).mockRejectedValue(
      new APIError(
        500,
        "CYCLE_REPLAN_FAILED",
        "failed",
        "request-replan-failed",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    await screen.findByText("別の更新が見つかりました");
    const replan = screen.getByRole("button", {
      name: "このCycleを中断して再計画",
    });

    fireEvent.click(replan);
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "未保存内容を破棄して再計画",
      }),
    );

    expect(
      await screen.findByText(/破棄した未保存内容は復元できません/),
    ).toBeVisible();
    await waitFor(() => expect(replan).toHaveFocus());
    expect(replan).toBeEnabled();
    expect(clearCycleDrafts).toHaveBeenCalledBefore(vi.mocked(replanCycle));
  });

  it("refreshes the canonical workspace after a known Replan conflict", async () => {
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal })
      .mockResolvedValueOnce({ goal: replannedGoal });
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValueOnce({ cycle: replannedSuccessorCycle });
    vi.mocked(replanCycle).mockRejectedValue(
      new APIError(
        409,
        "CYCLE_REVISION_CONFLICT",
        "stale cycle",
        "request-replan-conflict",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );

    const movedLink = await screen.findByRole("link", {
      name: "現在の作業へ移動",
    });
    expect(movedLink).toHaveAttribute(
      "href",
      `/goals/${goal.id}/cycles/${replannedSuccessorCycle.id}`,
    );
    expect(screen.getByRole("textbox", { name: "P — Plan" })).toHaveAttribute(
      "readonly",
    );
    expect(replanCycle).toHaveBeenCalledOnce();
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(getCycle).toHaveBeenCalledTimes(2);
  });

  it("keeps the workspace frozen and reuses the Replan operation after response loss", async () => {
    vi.mocked(replanCycle)
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({
        canceledCycle: replannedSourceCycle,
        goal: replannedGoal,
        cycle: replannedSuccessorCycle,
        replayed: true,
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    await screen.findByText("保存済み");

    fireEvent.click(
      screen.getByRole("button", { name: "このCycleを中断して再計画" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "中断して再計画",
      }),
    );

    const retryDialog = await screen.findByRole("dialog", {
      name: "再計画の結果を確認できません",
    });
    expect(
      within(retryDialog).getByRole("button", { name: "キャンセル" }),
    ).toBeDisabled();
    const retry = within(retryDialog).getByRole("button", {
      name: "同じ操作を再試行",
    });
    expect(retry).toHaveFocus();
    fireEvent(retryDialog, new Event("cancel", { cancelable: true }));
    expect(retryDialog).toBeVisible();
    expect(screen.getByRole("textbox", { name: "P — Plan" })).toHaveAttribute(
      "readonly",
    );
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
    expect(
      screen.getByRole("button", { name: "アクションを生成" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByText("目標の操作"));
    const goalActions = document.querySelector<HTMLElement>(".goal-actions");
    expect(goalActions).not.toBeNull();
    if (!goalActions) throw new Error("Goal actions are missing");
    for (const name of ["目標を達成として終了", "目標を終了", "目標を削除"])
      expect(within(goalActions).getByRole("button", { name })).toBeDisabled();
    const firstOperationId =
      vi.mocked(replanCycle).mock.calls[0]?.[6].operationId;

    fireEvent.click(retry);
    await waitFor(() => expect(replanCycle).toHaveBeenCalledTimes(2));
    expect(vi.mocked(replanCycle).mock.calls[1]).toEqual(
      vi.mocked(replanCycle).mock.calls[0],
    );
    expect(vi.mocked(replanCycle).mock.calls[1]?.[6].operationId).toBe(
      firstOperationId,
    );
    expect(await screen.findByText("現在のサイクル")).toBeVisible();
  });

  it("disables Replan while Action AI is running and explains why", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    const refinement = deferred<Awaited<ReturnType<typeof refineAction>>>();
    vi.mocked(refineAction).mockReturnValue(refinement.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
    fireEvent.click(screen.getByRole("button", { name: "AIで推敲" }));

    const replan = screen.getByRole("button", {
      name: "このCycleを中断して再計画",
    });
    expect(replan).toBeDisabled();
    expect(replan).toHaveAccessibleDescription(
      "AI処理の完了後に再計画できます。",
    );
  });
});
