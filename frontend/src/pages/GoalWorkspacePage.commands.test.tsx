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
import type { Cycle, Goal } from "../shared/api/schemas";
import { cycleFrameTemplateCopy } from "../shared/copy/ja";
import {
  completeCycle,
  deleteGoal,
  generateAction,
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
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import {
  readSelectedCycleFrame,
  rememberSelectedCycleFrame,
} from "../shared/preferences/selectedFramePreference";
import {
  activeCycleReplay,
  completableCycle,
  confirmCycleCompletion,
  createGoalDeletionAdvisoryHarness,
  currentCycleId,
  cycle,
  cycleRevisionConflict,
  deferred,
  deletedGoalError,
  expandFrameTemplates,
  goal,
  goalReviewReplay,
  invokeCycleTerminalCommand,
  otherGoalId,
  otherUserId,
  registerGoalWorkspacePageTestLifecycle,
  renderPage,
  reviewDraftId,
  session,
  sessionLease,
  terminalReplay,
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

describe("GoalWorkspacePage: AI and terminal commands", () => {
  registerGoalWorkspacePageTestLifecycle();

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
    const view = renderPage(cache);

    fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
    const editor = screen.getByRole("textbox", { name: "A — Action" });
    const refineButton = screen.getByRole("button", { name: "AIで推敲" });
    expect(refineButton).toBeEnabled();

    fireEvent.click(refineButton);

    expect(
      await screen.findByRole("button", { name: "推敲しています…" }),
    ).toBeDisabled();
    const aiGuidance = screen.getByText(
      "アクションを推敲しています。完了するまでお待ちください。",
    );
    expect(aiGuidance).toHaveAttribute("role", "status");
    expect(aiGuidance).toHaveAttribute("aria-live", "polite");
    expect(
      screen.getByRole("button", { name: "推敲しています…" }),
    ).toHaveAttribute("aria-describedby", aiGuidance.id);
    await act(async () => rejectRefinement(new Error("provider failure")));

    expect(
      await screen.findByText(
        "AI処理を完了できませんでした。現在のAは保持されています。",
      ),
    ).toBeInTheDocument();
    expect(editor).toHaveValue("現在のA");
    for (const name of ["アクションを生成", "AIで推敲", "サイクルを完了"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeEnabled();
      expect(control).not.toHaveAttribute("aria-describedby");
    }
    expect(
      view.container.querySelector(".action-controls__guidance"),
    ).toBeEmptyDOMElement();
    expect(refineAction).toHaveBeenCalledWith(
      sessionLease,
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
    vi.mocked(getCycle).mockResolvedValue({
      cycle: completableCycle,
    });
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
    const complete = screen.getByRole("button", { name: "サイクルを完了" });
    expect(complete).toBeDisabled();
    const pendingGuidance = screen.getByText(
      "サイクルの操作を処理しています。完了するまでお待ちください。",
    );
    expect(
      screen.getByRole("button", { name: "アクションを生成" }),
    ).toHaveAttribute("aria-describedby", pendingGuidance.id);
    fireEvent.click(screen.getByRole("button", { name: "AIで推敲" }));
    fireEvent.click(complete);
    expect(refineAction).not.toHaveBeenCalled();
    expect(completeCycle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /P\s*Plan/ }));
    expandFrameTemplates();
    const insert = screen.getByRole("button", {
      name: cycleFrameTemplateCopy.insert(
        cycleFrameTemplateCopy.templates.plan[0].name,
      ),
    });
    expect(insert).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(cycleFrameTemplateCopy.disabled.commandPending),
    ).toBeVisible();
    fireEvent.click(insert);
    expect(screen.getByRole("textbox", { name: "P — Plan" })).toHaveValue(
      completableCycle.plan,
    );
  });

  it("ignores a Complete result that arrives after navigating to another Cycle", async () => {
    const completion = deferred<Awaited<ReturnType<typeof completeCycle>>>();
    const nextCycle: Cycle = {
      ...completableCycle,
      id: currentCycleId,
      sequenceNumber: 2,
      plan: "次のCycleの計画",
    };
    const nextGoal: Goal = {
      ...goal,
      revision: goal.revision + 1,
      currentWork: {
        kind: "active_cycle",
        cycleId: nextCycle.id,
        cycleSequenceNumber: nextCycle.sequenceNumber,
        reviewSchedule: {
          reviewDate: nextCycle.reviewDate,
          reviewScheduleRevision: nextCycle.reviewScheduleRevision,
        },
      },
      nextCycleSequenceNumber: 3,
      cycleCount: 2,
    };
    vi.mocked(getCycle).mockImplementation(
      async (_lease, _goalId, requestedCycleId) =>
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
    await act(async () => {
      cache.setQueryData(userQueryKeys.goal(session.user.id, goal.id), {
        goal: nextGoal,
      });
      fireEvent.click(screen.getByRole("link", { name: "別のCycleへ移動" }));
    });
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

  it("does not publish Complete cleanup success into a replacement route generation", async () => {
    const cleanupGate = deferred<void>();
    const nextCycle: Cycle = {
      ...completableCycle,
      id: currentCycleId,
      sequenceNumber: 2,
      plan: "次のCycleの計画",
    };
    const nextGoal: Goal = {
      ...goal,
      revision: goal.revision + 1,
      currentWork: {
        kind: "active_cycle",
        cycleId: nextCycle.id,
        cycleSequenceNumber: nextCycle.sequenceNumber,
        reviewSchedule: {
          reviewDate: nextCycle.reviewDate,
          reviewScheduleRevision: nextCycle.reviewScheduleRevision,
        },
      },
      nextCycleSequenceNumber: 3,
      cycleCount: 2,
    };
    vi.mocked(getCycle).mockImplementation(
      async (_lease, _goalId, requestedCycleId) =>
        requestedCycleId === nextCycle.id
          ? { cycle: nextCycle }
          : { cycle: completableCycle },
    );
    vi.mocked(completeCycle).mockResolvedValue(goalReviewReplay);
    vi.mocked(deleteBrowserDraftIfUnchanged).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft)
      .mockImplementationOnce(async () => cleanupGate.promise)
      .mockResolvedValue(undefined);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const invalidateQueries = vi.spyOn(cache, "invalidateQueries");
    const nextCycleQueryKey = userQueryKeys.cycle(
      session.user.id,
      goal.id,
      nextCycle.id,
    );
    cache.setQueryData(nextCycleQueryKey, { cycle: nextCycle });
    renderPage(cache, { cleanupSwitchCycleId: nextCycle.id });

    await confirmCycleCompletion();
    await waitFor(() => expect(completeCycle).toHaveBeenCalledOnce());
    await waitFor(() => expect(deleteBrowserDraft).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("この端末のサイクル下書きを削除しています…"),
    ).toBeInTheDocument();

    await act(async () => {
      cache.setQueryData(userQueryKeys.goal(session.user.id, goal.id), {
        goal: nextGoal,
      });
      fireEvent.click(
        screen.getByRole("link", {
          name: "クリーンアップ中に別のCycleへ移動",
        }),
      );
    });
    await act(async () => cleanupGate.resolve());

    expect(
      await screen.findByDisplayValue("次のCycleの計画"),
    ).toBeInTheDocument();
    expect(screen.queryByText("現在の目標レビュー")).not.toBeInTheDocument();
    expect(cache.getQueryState(nextCycleQueryKey)?.isInvalidated).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: userQueryKeys.root(session.user.id),
      refetchType: "none",
    });
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

  it("synchronously fences one exact Goal advisory without echoing or deleting again", async () => {
    rememberSelectedCycleFrame(cycle.id, "do");
    const cleanup = deferred<void>();
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValue(
      cleanup.promise,
    );
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { goalDeletionAdvisory: advisory });
    const editor = await screen.findByRole("textbox", { name: "D — Do" });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(advisory.subscribe).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
      expect.anything(),
    );
    expect(typeof advisory.subscribe.mock.calls[0]?.[2]).toBe("function");

    act(() => advisory.dispatch(otherUserId, goal.id));
    act(() => advisory.dispatch(session.user.id, otherGoalId));
    expect(editor).not.toHaveAttribute("readonly");
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();

    act(() => advisory.dispatch(session.user.id, goal.id));
    expect(editor).toHaveAttribute("readonly");
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("plan");
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
        session.user.id,
        goal.id,
      ),
    );

    act(() => advisory.dispatch(session.user.id, goal.id));
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(deleteGoal).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();

    await act(async () => cleanup.resolve());
    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(advisory.publish).not.toHaveBeenCalled();
  });

  it("retries Complete browser cleanup without resending Complete", async () => {
    rememberSelectedCycleFrame(cycle.id, "action");
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(completeCycle).mockResolvedValue(goalReviewReplay);
    vi.mocked(deleteBrowserDraft)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValue(undefined);
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { goalDeletionAdvisory: advisory });

    await confirmCycleCompletion();

    expect(
      await screen.findByText(
        "サイクルは完了しましたが、この端末の復旧用保存を削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(completeCycle).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).toHaveBeenCalledOnce();
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("plan");

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
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();
  });

  it("retries Delete browser cleanup without resending Delete", async () => {
    rememberSelectedCycleFrame(cycle.id, "check");
    vi.mocked(deleteGoal).mockResolvedValue(undefined);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValue(undefined);
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { goalDeletionAdvisory: advisory });

    await screen.findByRole("textbox", { name: "C — Check" });
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
        "削除済みGoalのブラウザ下書きを削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("plan");
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledWith(session.user.id, goal.id);
    expect(advisory.publish.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(tombstoneDeletedGoalAndClearDrafts).mock
        .invocationCallOrder[0]!,
    );
    const cycleReadsBeforeRetry = vi.mocked(getCycle).mock.calls.length;

    fireEvent.click(
      screen.getByRole("button", { name: "ブラウザデータの削除を再試行" }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(screen.getByText("Goal cache削除済み")).toBeInTheDocument();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
    expect(advisory.publish).toHaveBeenNthCalledWith(
      2,
      session.user.id,
      goal.id,
    );
    expect(advisory.publish.mock.invocationCallOrder[1]).toBeGreaterThan(
      vi.mocked(tombstoneDeletedGoalAndClearDrafts).mock
        .invocationCallOrder[1]!,
    );
    expect(getCycle).toHaveBeenCalledTimes(cycleReadsBeforeRetry);
  });

  it("retries Terminate browser cleanup without resending Terminate", async () => {
    rememberSelectedCycleFrame(cycle.id, "do");
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
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { goalDeletionAdvisory: advisory });

    await screen.findByRole("textbox", { name: "D — Do" });
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
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("plan");
    expect(clearGoalDrafts).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "端末データの削除を再試行" }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(terminateGoal).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).toHaveBeenCalledTimes(2);
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();
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
        sessionLease,
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
    const firstOptions = vi.mocked(completeCycle).mock.calls[0]?.[5];
    const secondOptions = vi.mocked(completeCycle).mock.calls[1]?.[5];
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
  it.each([
    { command: "complete", code: "GOAL_STATE_CONFLICT" },
    { command: "complete", code: "GOAL_VERSION_CONFLICT" },
    { command: "complete", code: "CYCLE_NOT_ACTIVE" },
    { command: "terminate", code: "GOAL_STATE_CONFLICT" },
    { command: "terminate", code: "GOAL_ALREADY_TERMINAL" },
    { command: "delete", code: "GOAL_DELETE_CONFLICT" },
  ] as const)(
    "fences a stale $command command on exact $code and converges with GET only",
    async ({ command, code }) => {
      const canonicalGoal: Goal =
        command === "delete"
          ? { ...goal, revision: goal.revision + 1 }
          : {
              ...goal,
              status: command === "complete" ? "goal_review" : "ended",
              revision: goal.revision + 1,
              currentWork:
                command === "complete"
                  ? {
                      kind: "goal_review",
                      reviewDraftId,
                      triggerCycleId: cycle.id,
                      triggerCycleSequenceNumber: cycle.sequenceNumber,
                    }
                  : null,
              terminalAt:
                command === "terminate" ? "2026-08-20T00:06:00.000Z" : null,
            };
      vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
      vi.mocked(getGoal)
        .mockResolvedValueOnce({ goal })
        .mockResolvedValueOnce({ goal: canonicalGoal });
      const conflict = new APIError(
        409,
        code,
        "stale workspace",
        `request-${command}-${code}`,
      );
      if (command === "complete")
        vi.mocked(completeCycle).mockRejectedValueOnce(conflict);
      else if (command === "terminate")
        vi.mocked(terminateGoal).mockRejectedValueOnce(conflict);
      else vi.mocked(deleteGoal).mockRejectedValueOnce(conflict);

      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache);
      const editor = await screen.findByRole("textbox", { name: "P — Plan" });
      await invokeCycleTerminalCommand(command);

      expect(
        await screen.findByText("現在の作業状態が更新されました"),
      ).toBeInTheDocument();
      expect(editor).toHaveAttribute("readonly");
      const expectedHref =
        command === "complete"
          ? `/goals/${goal.id}/review`
          : command === "terminate"
            ? `/history/goals/${goal.id}`
            : `/goals/${goal.id}`;
      expect(
        screen.getByRole("link", { name: "現在の作業へ移動" }),
      ).toHaveAttribute("href", expectedHref);
      expect(getGoal).toHaveBeenCalledTimes(2);
      if (command === "complete") expect(completeCycle).toHaveBeenCalledOnce();
      else if (command === "terminate")
        expect(terminateGoal).toHaveBeenCalledOnce();
      else expect(deleteGoal).toHaveBeenCalledOnce();
      await act(async () => undefined);
      expect(putBrowserDraft).not.toHaveBeenCalled();

      fireEvent.blur(editor);
      window.dispatchEvent(new Event("online"));
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));
      if (command === "complete") expect(completeCycle).toHaveBeenCalledOnce();
      else if (command === "terminate")
        expect(terminateGoal).toHaveBeenCalledOnce();
      else expect(deleteGoal).toHaveBeenCalledOnce();
    },
  );

  it("reconstructs the same active Cycle after a stale Delete conflict", async () => {
    const canonicalGoal: Goal = {
      ...goal,
      revision: goal.revision + 1,
    };
    const canonicalCycle: Cycle = {
      ...cycle,
      plan: "別の端末で更新された計画",
      contentRevision: cycle.contentRevision + 1,
      frameRevisions: { ...cycle.frameRevisions, plan: 1 },
    };
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal })
      .mockResolvedValue({ goal: canonicalGoal });
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValue({ cycle: canonicalCycle });
    vi.mocked(deleteGoal).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_DELETE_CONFLICT",
        "stale workspace",
        "request-delete-same-cycle",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { canonicalWorkspaceRoute: true });

    await invokeCycleTerminalCommand("delete");
    const movedLink = await screen.findByRole("link", {
      name: "現在の作業へ移動",
    });
    expect(movedLink).toHaveAttribute("href", `/goals/${goal.id}`);

    fireEvent.click(movedLink);

    await waitFor(() =>
      expect(
        screen.queryByText("現在の作業状態が更新されました"),
      ).not.toBeInTheDocument(),
    );
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    expect(editor).toHaveValue(canonicalCycle.plan);
    expect(editor).not.toHaveAttribute("readonly");
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(getCycle).toHaveBeenCalledTimes(2);
    expect(deleteGoal).toHaveBeenCalledOnce();
  });

  it("retries only canonical GET after a Complete conflict refresh fails", async () => {
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
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal })
      .mockRejectedValueOnce(new TypeError("GET failed"))
      .mockResolvedValueOnce({ goal: reviewGoal });
    vi.mocked(completeCycle).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_STATE_CONFLICT",
        "stale workspace",
        "request-complete-refresh",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await invokeCycleTerminalCommand("complete");
    fireEvent.click(
      await screen.findByRole("button", { name: "現在の作業を再取得" }),
    );

    expect(
      await screen.findByRole("link", { name: "現在の作業へ移動" }),
    ).toHaveAttribute("href", `/goals/${goal.id}/review`);
    expect(getGoal).toHaveBeenCalledTimes(3);
    expect(completeCycle).toHaveBeenCalledOnce();
  });

  it("moves a stale Complete command directly to the canonical active Cycle", async () => {
    const canonicalGoal: Goal = {
      ...goal,
      revision: goal.revision + 1,
      currentWork: {
        kind: "active_cycle",
        cycleId: currentCycleId,
        cycleSequenceNumber: 2,
        reviewSchedule: {
          reviewDate: "2026-08-22",
          reviewScheduleRevision: 1,
        },
      },
      nextCycleSequenceNumber: 3,
      cycleCount: 2,
    };
    const canonicalCycle: Cycle = {
      ...cycle,
      id: currentCycleId,
      sequenceNumber: 2,
      reviewDate: "2026-08-22",
      reviewScheduleRevision: 1,
      plan: "別の端末で開始したCycle",
    };
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal })
      .mockResolvedValue({ goal: canonicalGoal });
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle: completableCycle })
      .mockResolvedValue({ cycle: canonicalCycle });
    vi.mocked(completeCycle).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_STATE_CONFLICT",
        "stale workspace",
        "request-complete-moved-cycle",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { canonicalWorkspaceRoute: true });

    await invokeCycleTerminalCommand("complete");
    const movedLink = await screen.findByRole("link", {
      name: "現在の作業へ移動",
    });
    expect(movedLink).toHaveAttribute(
      "href",
      `/goals/${goal.id}/cycles/${currentCycleId}`,
    );

    fireEvent.click(movedLink);

    expect(await screen.findByText("Goal v1 · Cycle 2")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "P — Plan" })).toHaveValue(
      canonicalCycle.plan,
    );
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(getCycle).toHaveBeenCalledTimes(2);
    expect(completeCycle).toHaveBeenCalledOnce();
  });

  it("does not treat an unrelated Complete 409 as workspace movement", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(completeCycle).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_NOT_ACTIVE",
        "different command conflict",
        "request-unrelated-complete",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await invokeCycleTerminalCommand("complete");

    expect(
      await screen.findByText(
        "サイクルを完了できませんでした。入力内容を確認してください。",
      ),
    ).toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("現在の作業状態が更新されました"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "A — Action" }),
    ).not.toHaveAttribute("readonly");
  });

  it("preserves the latest reversion when a Delete conflict fences an in-flight save", async () => {
    const inFlightSave = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    const inFlightBody = "競合前に送信中だった計画";
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockReturnValueOnce(inFlightSave.promise);
    vi.mocked(deleteGoal).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_DELETE_CONFLICT",
        "stale delete",
        "request-delete-in-flight-reversion",
      ),
    );
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal })
      .mockResolvedValueOnce({
        goal: { ...goal, revision: goal.revision + 1 },
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });

    fireEvent.change(editor, { target: { value: inFlightBody } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    fireEvent.change(editor, { target: { value: cycle.plan } });

    await invokeCycleTerminalCommand("delete");

    await screen.findByRole("link", { name: "現在の作業へ移動" });
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectKey: `cycle:${cycle.id}:plan`,
          body: cycle.plan,
          baseRevision: cycle.frameRevisions.plan,
        }),
      ),
    );
    expect(editor).toHaveValue(cycle.plan);
    expect(editor).toHaveAttribute("readonly");
    expect(deleteGoal).toHaveBeenCalledOnce();

    await act(async () =>
      inFlightSave.resolve({
        cycleId: cycle.id,
        frame: "plan",
        content: inFlightBody,
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-08-20T00:08:00.000Z",
      }),
    );
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(editor).toHaveValue(cycle.plan);
  });

  it.each(["complete", "terminate", "delete"] as const)(
    "cleans a deleted Goal when a pending $command receives GOAL_NOT_FOUND after route leave",
    async (command) => {
      const commandFailure = deferred<never>();
      vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
      if (command === "complete")
        vi.mocked(completeCycle).mockReturnValueOnce(commandFailure.promise);
      else if (command === "terminate")
        vi.mocked(terminateGoal).mockReturnValueOnce(commandFailure.promise);
      else vi.mocked(deleteGoal).mockReturnValueOnce(commandFailure.promise);
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const advisory = createGoalDeletionAdvisoryHarness();
      const removeQueries = vi.spyOn(cache, "removeQueries");
      renderPage(cache, {
        commandRouteSwitch: true,
        goalDeletionAdvisory: advisory,
      });
      await screen.findByRole("textbox", { name: "P — Plan" });

      await invokeCycleTerminalCommand(command);
      if (command === "complete")
        await waitFor(() => expect(completeCycle).toHaveBeenCalledOnce());
      else if (command === "terminate")
        await waitFor(() => expect(terminateGoal).toHaveBeenCalledOnce());
      else await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());
      const goalReadsBeforeFailure = vi.mocked(getGoal).mock.calls.length;

      fireEvent.click(
        screen.getByRole("link", { name: "コマンド中に外部routeへ移動" }),
      );
      expect(await screen.findByText("外部route")).toBeInTheDocument();
      await act(async () =>
        commandFailure.reject(
          new APIError(
            404,
            "GOAL_NOT_FOUND",
            "deleted",
            `request-late-${command}-deleted-goal`,
          ),
        ),
      );

      await waitFor(() =>
        expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
      );
      await waitFor(() => expect(removeQueries).toHaveBeenCalled());
      expect(screen.getByText("外部route")).toBeInTheDocument();
      expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
      expect(
        cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
      ).toBeUndefined();
      expect(
        cache.getQueryData(
          userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
        ),
      ).toBeUndefined();
      expect(getGoal).toHaveBeenCalledTimes(goalReadsBeforeFailure);
      if (command === "complete") expect(completeCycle).toHaveBeenCalledOnce();
      else if (command === "terminate")
        expect(terminateGoal).toHaveBeenCalledOnce();
      else expect(deleteGoal).toHaveBeenCalledOnce();
      expect(clearGoalDrafts).not.toHaveBeenCalled();
      expect(advisory.publish).toHaveBeenCalledTimes(2);
      expect(advisory.publish).toHaveBeenNthCalledWith(
        1,
        session.user.id,
        goal.id,
      );
      expect(advisory.publish).toHaveBeenNthCalledWith(
        2,
        session.user.id,
        goal.id,
      );
    },
  );

  it("cleans a deleted Goal when Delete succeeds after route leave", async () => {
    const deletion = deferred<Awaited<ReturnType<typeof deleteGoal>>>();
    vi.mocked(deleteGoal).mockReturnValueOnce(deletion.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const advisory = createGoalDeletionAdvisoryHarness();
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache, {
      commandRouteSwitch: true,
      goalDeletionAdvisory: advisory,
    });
    await screen.findByRole("textbox", { name: "P — Plan" });
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
    ).toBeDefined();
    expect(
      cache.getQueryData(
        userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
      ),
    ).toBeDefined();

    await invokeCycleTerminalCommand("delete");
    await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", { name: "コマンド中に外部routeへ移動" }),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();

    await act(async () => deletion.resolve(undefined));

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
        session.user.id,
        goal.id,
      ),
    );
    await waitFor(() => expect(removeQueries).toHaveBeenCalled());
    expect(screen.getByText("外部route")).toBeInTheDocument();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(
        userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
      ),
    ).toBeUndefined();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
  });

  it("cleans a deleted Goal when a canonical GET receives GOAL_NOT_FOUND after route leave", async () => {
    const canonicalFailure = deferred<never>();
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(getGoal)
      .mockResolvedValueOnce({ goal })
      .mockReturnValueOnce(canonicalFailure.promise);
    vi.mocked(completeCycle).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_STATE_CONFLICT",
        "stale workspace",
        "request-late-canonical-cycle",
      ),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const advisory = createGoalDeletionAdvisoryHarness();
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache, {
      commandRouteSwitch: true,
      goalDeletionAdvisory: advisory,
    });

    await invokeCycleTerminalCommand("complete");
    await waitFor(() => expect(getGoal).toHaveBeenCalledTimes(2));
    fireEvent.click(
      screen.getByRole("link", { name: "コマンド中に外部routeへ移動" }),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();
    await act(async () =>
      canonicalFailure.reject(
        new APIError(
          404,
          "GOAL_NOT_FOUND",
          "deleted",
          "request-late-canonical-cycle-deleted-goal",
        ),
      ),
    );

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(removeQueries).toHaveBeenCalled());
    expect(screen.getByText("外部route")).toBeInTheDocument();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(
        userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
      ),
    ).toBeUndefined();
    expect(completeCycle).toHaveBeenCalledOnce();
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
  });

  it("retries only local cleanup after GOAL_NOT_FOUND and ignores late hydration", async () => {
    const hydration = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    vi.mocked(getBrowserDraft).mockReturnValue(hydration.promise);
    vi.mocked(deleteGoal).mockRejectedValueOnce(
      new APIError(404, "GOAL_NOT_FOUND", "deleted", "request-deleted-goal"),
    );
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValueOnce(undefined);
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache, { goalDeletionAdvisory: advisory });
    await screen.findByRole("textbox", { name: "P — Plan" });

    await invokeCycleTerminalCommand("delete");
    expect(
      await screen.findByText("削除済みGoalのブラウザ下書きを削除しています…"),
    ).toBeInTheDocument();
    await act(async () =>
      hydration.resolve({
        userId: session.user.id,
        goalId: goal.id,
        subjectKey: `cycle:${cycle.id}:plan`,
        body: "削除後に到着した端末下書き",
        baseRevision: 0,
        updatedAt: "2026-08-20T00:07:00.000Z",
      }),
    );
    expect(
      await screen.findByText(
        "削除済みGoalのブラウザ下書きを削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
    );
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).toHaveBeenCalledOnce();
    expect(putBrowserDraft).not.toHaveBeenCalled();
    expect(deleteGoal).toHaveBeenCalledOnce();
    const goalReadsBeforeRetry = vi.mocked(getGoal).mock.calls.length;
    const cycleReadsBeforeRetry = vi.mocked(getCycle).mock.calls.length;

    fireEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(screen.getByText("Goal cache削除済み")).toBeInTheDocument();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(removeQueries).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
      ).toBeUndefined();
      expect(
        cache.getQueryData(
          userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
        ),
      ).toBeUndefined();
    });
    expect(getGoal).toHaveBeenCalledTimes(goalReadsBeforeRetry);
    expect(getCycle).toHaveBeenCalledTimes(cycleReadsBeforeRetry);
  });

  it("fences a frame PATCH deletion once and retries only local cleanup", async () => {
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockRejectedValueOnce(deletedGoalError("request-frame-deleted-goal"));
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValueOnce(undefined);
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { goalDeletionAdvisory: advisory });
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "削除確認に失敗する計画" } });
    fireEvent.blur(editor);

    expect(
      await screen.findByText(
        "削除済みGoalのブラウザ下書きを削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(editor).toHaveAttribute("readonly");
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledOnce();

    act(() => advisory.dispatch(session.user.id, goal.id));
    fireEvent.blur(editor);
    window.dispatchEvent(new Event("online"));
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(clearGoalDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
  });

  it.each(["goal", "cycle", "confirmation"] as const)(
    "fences GOAL_NOT_FOUND from the revision-conflict $stage GET",
    async (stage) => {
      const cleanup = deferred<void>();
      const terminalCycle: Cycle = {
        ...cycle,
        status: "completed",
        completedAt: "2026-08-20T00:09:00.000Z",
      };
      vi.mocked(getGoal).mockReset().mockResolvedValueOnce({ goal });
      vi.mocked(getCycle).mockReset().mockResolvedValueOnce({ cycle });
      if (stage === "goal") {
        vi.mocked(getGoal).mockRejectedValueOnce(
          deletedGoalError("request-refresh-goal-deleted"),
        );
      } else {
        vi.mocked(getGoal).mockResolvedValueOnce({ goal });
        if (stage === "cycle") {
          vi.mocked(getCycle).mockRejectedValueOnce(
            deletedGoalError("request-refresh-cycle-deleted"),
          );
        } else {
          vi.mocked(getCycle).mockResolvedValueOnce({ cycle: terminalCycle });
          vi.mocked(getGoal).mockRejectedValueOnce(
            deletedGoalError("request-refresh-confirmation-deleted"),
          );
        }
      }
      vi.mocked(saveCycleFrame)
        .mockReset()
        .mockRejectedValueOnce(cycleRevisionConflict());
      vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValueOnce(
        cleanup.promise,
      );
      const advisory = createGoalDeletionAdvisoryHarness();
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache, { goalDeletionAdvisory: advisory });
      const editor = await screen.findByRole("textbox", { name: "P — Plan" });
      expect(await screen.findByText("保存済み")).toBeInTheDocument();

      fireEvent.change(editor, { target: { value: `削除された${stage}` } });
      fireEvent.blur(editor);

      await waitFor(() =>
        expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
      );
      expect(
        screen.getByText("削除済みGoalのブラウザ下書きを削除しています…"),
      ).toBeInTheDocument();
      expect(editor).not.toBeInTheDocument();
      expect(saveCycleFrame).toHaveBeenCalledOnce();
      expect(getGoal).toHaveBeenCalledTimes(
        stage === "goal" ? 2 : stage === "cycle" ? 2 : 3,
      );
      expect(getCycle).toHaveBeenCalledTimes(stage === "goal" ? 1 : 2);
      expect(advisory.publish).toHaveBeenCalledOnce();

      await act(async () => cleanup.resolve());

      expect(await screen.findByText("ホーム")).toBeInTheDocument();
      expect(saveCycleFrame).toHaveBeenCalledOnce();
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
      expect(advisory.publish).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["generate", "refine"] as const)(
    "fences an Action $kind GOAL_NOT_FOUND and retries no AI transport",
    async (kind) => {
      const readyCycle: Cycle = {
        ...completableCycle,
        action: kind === "generate" ? "" : completableCycle.action,
      };
      vi.mocked(getCycle).mockResolvedValue({ cycle: readyCycle });
      if (kind === "generate") {
        vi.mocked(generateAction)
          .mockReset()
          .mockRejectedValueOnce(
            deletedGoalError("request-generate-deleted-goal"),
          );
      } else {
        vi.mocked(refineAction)
          .mockReset()
          .mockRejectedValueOnce(
            deletedGoalError("request-refine-deleted-goal"),
          );
      }
      vi.mocked(tombstoneDeletedGoalAndClearDrafts)
        .mockRejectedValueOnce(new Error("indexedDB unavailable"))
        .mockResolvedValueOnce(undefined);
      const advisory = createGoalDeletionAdvisoryHarness();
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache, { goalDeletionAdvisory: advisory });
      fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
      const editor = screen.getByRole("textbox", { name: "A — Action" });
      const label = kind === "generate" ? "アクションを生成" : "AIで推敲";

      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(
        await screen.findByText(
          "削除済みGoalのブラウザ下書きを削除できませんでした。",
        ),
      ).toBeInTheDocument();
      expect(editor).toHaveAttribute("readonly");
      const transport =
        kind === "generate"
          ? vi.mocked(generateAction)
          : vi.mocked(refineAction);
      expect(transport).toHaveBeenCalledOnce();
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
      expect(advisory.publish).toHaveBeenCalledOnce();

      fireEvent.click(
        screen.getByRole("button", {
          name: "ブラウザデータの削除を再試行",
        }),
      );

      expect(await screen.findByText("ホーム")).toBeInTheDocument();
      expect(transport).toHaveBeenCalledOnce();
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
      expect(advisory.publish).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {
      label: "CYCLE_NOT_FOUND",
      error: () =>
        new APIError(
          404,
          "CYCLE_NOT_FOUND",
          "cycle missing",
          "request-missing-cycle",
        ),
    },
    {
      label: "generic 404",
      error: () =>
        new APIError(
          404,
          "GOAL_DRAFT_NOT_FOUND",
          "missing",
          "request-generic-missing",
        ),
    },
    {
      label: "409 GOAL_NOT_FOUND",
      error: () =>
        new APIError(
          409,
          "GOAL_NOT_FOUND",
          "wrong status",
          "request-wrong-status",
        ),
    },
    { label: "network failure", error: () => new TypeError("network") },
  ])(
    "keeps the existing Action failure behavior for $label",
    async ({ error }) => {
      vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
      vi.mocked(refineAction).mockReset().mockRejectedValueOnce(error());
      const advisory = createGoalDeletionAdvisoryHarness();
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache, { goalDeletionAdvisory: advisory });
      fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
      const editor = screen.getByRole("textbox", { name: "A — Action" });

      fireEvent.click(screen.getByRole("button", { name: "AIで推敲" }));

      expect(
        await screen.findByText(
          "AI処理を完了できませんでした。現在のAは保持されています。",
        ),
      ).toBeInTheDocument();
      expect(editor).toHaveValue(completableCycle.action);
      expect(editor).not.toHaveAttribute("readonly");
      expect(refineAction).toHaveBeenCalledOnce();
      expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
      expect(advisory.publish).not.toHaveBeenCalled();
    },
  );

  it("does not publish a late AI result after a deleted-Goal fence", async () => {
    const refinement = deferred<Awaited<ReturnType<typeof refineAction>>>();
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(refineAction).mockReturnValue(refinement.promise);
    vi.mocked(deleteGoal).mockRejectedValueOnce(
      new APIError(404, "GOAL_NOT_FOUND", "deleted", "request-ai-deleted-goal"),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
    const editor = screen.getByRole("textbox", { name: "A — Action" });
    fireEvent.click(screen.getByRole("button", { name: "AIで推敲" }));
    await waitFor(() => expect(refineAction).toHaveBeenCalledOnce());

    await invokeCycleTerminalCommand("delete");
    await screen.findByText("このGoalはすでに削除されています");
    await act(async () =>
      refinement.resolve({
        generationId: "50000000-0000-7000-8000-000000000009",
        action: "削除後に到着したAI本文",
        actionRevision: 2,
        contentRevision: 5,
        contextChanged: false,
        replayed: false,
      }),
    );

    expect(editor).toHaveValue(completableCycle.action);
    expect(editor).toHaveAttribute("readonly");
  });
});
