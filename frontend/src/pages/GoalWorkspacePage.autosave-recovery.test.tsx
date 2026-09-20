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
import {
  cycleFrameCopy,
  cycleFrameTemplateCopy,
  cyclePreviousActionReferenceCopy,
  frameCopy,
} from "../shared/copy/ja";
import {
  deleteGoal,
  getCycle,
  getGoal,
  saveCycleFrame,
} from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import {
  readSelectedCycleFrame,
  rememberSelectedCycleFrame,
} from "../shared/preferences/selectedFramePreference";
import {
  currentCycleId,
  cycle,
  cycleRevisionConflict,
  cycleWithPreviousAction,
  deferred,
  expandFrameTemplates,
  goal,
  goalWithPreviousAction,
  registerGoalWorkspacePageTestLifecycle,
  renderPage,
  reviewDraftId,
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

describe("GoalWorkspacePage: conflict recovery", () => {
  registerGoalWorkspacePageTestLifecycle();

  it("rebases a runtime cycle conflict only after the user chooses the local frame", async () => {
    const latestCycle: Cycle = {
      ...cycleWithPreviousAction,
      plan: "別の端末で保存された計画",
      contentRevision: 1,
      frameRevisions: { ...cycleWithPreviousAction.frameRevisions, plan: 1 },
    };
    vi.mocked(getGoal).mockResolvedValue({ goal: goalWithPreviousAction });
    vi.mocked(getCycle)
      .mockResolvedValueOnce({ cycle: cycleWithPreviousAction })
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
    expect(
      screen.getByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).toBeVisible();
    fireEvent.change(editor, { target: { value: "この端末の計画" } });

    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).not.toBeInTheDocument();
    expect(editor).toHaveValue("この端末の計画");
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "D — Doへ進む" }),
    ).not.toBeInTheDocument();
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
    expect(
      await screen.findByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "D — Doへ進む" })).toBeEnabled();

    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledTimes(2));
    expect(saveCycleFrame).toHaveBeenLastCalledWith(
      sessionLease,
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
        sessionLease,
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
      sessionLease,
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
              reviewSchedule: {
                reviewDate: null,
                reviewScheduleRevision: 0,
              },
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
        .mockResolvedValue({ goal: canonicalGoal });
      vi.mocked(getCycle)
        .mockReset()
        .mockResolvedValueOnce({ cycle })
        .mockResolvedValue({ cycle: canonicalCycle });
      vi.mocked(saveCycleFrame)
        .mockReset()
        .mockRejectedValueOnce(
          new APIError(409, code, "workspace moved", "request-moved"),
        );
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const view = renderPage(cache, {
        canonicalWorkspaceRoute: !movedToReview,
      });

      const editor = await screen.findByRole("textbox", { name: "P — Plan" });
      fireEvent.change(editor, { target: { value: "移動前の端末の計画" } });
      fireEvent.blur(editor);

      expect(
        await screen.findByText("現在の作業状態が更新されました"),
      ).toBeInTheDocument();
      expect(
        view.container.querySelector(".goal-actions"),
      ).not.toBeInTheDocument();
      expect(editor).toHaveValue("移動前の端末の計画");
      expect(editor).toHaveAttribute("readonly");
      expect(editor).toHaveAttribute("placeholder", frameCopy.plan.placeholder);
      expect(
        screen.queryByText(cycleFrameCopy.terminalEmpty, { exact: true }),
      ).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
      const movedDo = screen.getByRole("textbox", { name: "D — Do" });
      const quickEntry = screen.getByRole("button", {
        name: "今の実行を記録",
      });
      expect(quickEntry).toHaveAttribute("aria-disabled", "true");
      expect(movedDo).toHaveAttribute("readonly");
      expect(movedDo).toHaveAttribute("aria-readonly", "true");
      expect(movedDo).toHaveValue("");
      expect(movedDo).toHaveAttribute("placeholder", frameCopy.do.placeholder);
      expect(
        screen.queryByText(cycleFrameCopy.terminalEmpty, { exact: true }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("現在の作業を確認してから追加してください。"),
      ).toBeVisible();
      expandFrameTemplates();
      const templateInsert = screen.getByRole("button", {
        name: cycleFrameTemplateCopy.insert(
          cycleFrameTemplateCopy.templates.do[0].name,
        ),
      });
      expect(templateInsert).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByText(cycleFrameTemplateCopy.disabled.workspaceMoved),
      ).toBeVisible();
      fireEvent.click(templateInsert);
      expect(movedDo).toHaveValue("");
      fireEvent.click(quickEntry);
      expect(saveCycleFrame).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
      for (const name of ["アクションを生成", "AIで推敲", "サイクルを完了"]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }
      if (!movedToReview) {
        fireEvent.click(screen.getByRole("link", { name: "現在の作業へ移動" }));
        expect(
          cache.getQueryData<{ goal: Goal }>(
            userQueryKeys.goal(session.user.id, goal.id),
          )?.goal,
        ).toEqual(canonicalGoal);
        expect(
          cache.getQueryData<{ cycle: Cycle }>(
            userQueryKeys.cycle(session.user.id, goal.id, currentCycleId),
          )?.cycle,
        ).toEqual(canonicalCycle);
        expect(
          await screen.findByText("Goal v1 · Cycle 2"),
        ).toBeInTheDocument();
        expect(getGoal).toHaveBeenCalledTimes(2);
        expect(getCycle).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("preserves a newer terminal Cycle cache before moved-workspace navigation", async () => {
    const movedGoal: Goal = {
      ...goal,
      revision: goal.revision + 1,
      currentWork: {
        kind: "active_cycle",
        cycleId: currentCycleId,
        cycleSequenceNumber: 2,
        reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
      },
      nextCycleSequenceNumber: 3,
      cycleCount: 2,
    };
    const movedCycle: Cycle = {
      ...cycle,
      id: currentCycleId,
      sequenceNumber: 2,
      plan: "移動先の計画",
    };
    const terminalMovedCycle: Cycle = {
      ...movedCycle,
      status: "completed",
      completedAt: "2026-08-20T00:07:00.000Z",
    };
    const reviewGoal: Goal = {
      ...movedGoal,
      status: "goal_review",
      revision: movedGoal.revision + 1,
      currentWork: {
        kind: "goal_review",
        reviewDraftId,
        triggerCycleId: currentCycleId,
        triggerCycleSequenceNumber: 2,
      },
    };
    vi.mocked(getGoal)
      .mockReset()
      .mockResolvedValueOnce({ goal })
      .mockResolvedValueOnce({ goal: movedGoal })
      .mockResolvedValueOnce({ goal: movedGoal })
      .mockResolvedValue({ goal: reviewGoal });
    vi.mocked(getCycle)
      .mockReset()
      .mockResolvedValueOnce({ cycle })
      .mockResolvedValue({ cycle: movedCycle });
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockRejectedValueOnce(cycleRevisionConflict());
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { canonicalWorkspaceRoute: true });

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "移動前の端末の計画" } });
    fireEvent.blur(editor);
    const movedLink = await screen.findByRole("link", {
      name: "現在の作業へ移動",
    });
    expect(movedLink).toHaveAttribute(
      "href",
      `/goals/${goal.id}/cycles/${currentCycleId}`,
    );
    act(() => {
      cache.setQueryData(
        userQueryKeys.cycle(session.user.id, goal.id, currentCycleId),
        { cycle: terminalMovedCycle },
      );
    });

    fireEvent.click(movedLink);

    expect(
      cache.getQueryData<{ cycle: Cycle }>(
        userQueryKeys.cycle(session.user.id, goal.id, currentCycleId),
      )?.cycle,
    ).toEqual(terminalMovedCycle);
    await waitFor(() => expect(getGoal).toHaveBeenCalledTimes(3));
    const laggingActiveLink = screen.getByRole("link", {
      name: "現在の作業へ移動",
    });
    expect(laggingActiveLink).toHaveAttribute(
      "href",
      `/goals/${goal.id}/cycles/${currentCycleId}`,
    );

    fireEvent.click(laggingActiveLink);

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "現在の作業へ移動" }),
      ).toHaveAttribute("href", `/goals/${goal.id}/review`),
    );
    expect(editor).toHaveAttribute("readonly");
    expect(getGoal).toHaveBeenCalledTimes(4);
    expect(getCycle).toHaveBeenCalledTimes(3);
    expect(saveCycleFrame).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("link", { name: "現在の作業へ移動" }));
    expect(await screen.findByText("現在の目標レビュー")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "P — Plan" })).toBeNull();
  });

  it("retries a failed refresh without resending the stale frame or losing local input after the workspace moves", async () => {
    const movedGoal: Goal = {
      ...goal,
      revision: goal.revision + 1,
      currentWork: {
        kind: "active_cycle",
        cycleId: currentCycleId,
        cycleSequenceNumber: 2,
        reviewSchedule: {
          reviewDate: null,
          reviewScheduleRevision: 0,
        },
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
      sessionLease,
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
        sessionLease,
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
        sessionLease,
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
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("do");

    fireEvent.keyDown(doTab, { key: "End" });
    const actionTab = screen.getByRole("tab", { name: "A Action" });
    expect(actionTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(actionTab).toHaveFocus());
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("action");

    fireEvent.keyDown(actionTab, { key: "Home" });
    expect(planTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(planTab).toHaveFocus());
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("plan");

    fireEvent.keyDown(planTab, { key: "ArrowLeft" });
    expect(actionTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(actionTab).toHaveFocus());
    expect(readSelectedCycleFrame(cycle.id, "active")).toBe("action");
  });

  it("offers focused next-frame guidance through P, D, and C without gating A", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    for (const step of [
      {
        action: "D — Doへ進む",
        frame: "do",
        tab: /D\s*Do/,
        textbox: "D — Do",
      },
      {
        action: "C — Checkへ進む",
        frame: "check",
        tab: /C\s*Check/,
        textbox: "C — Check",
      },
      {
        action: "A — Actionへ進む",
        frame: "action",
        tab: /A\s*Action/,
        textbox: "A — Action",
      },
    ] as const) {
      const action = screen.getByRole("button", { name: step.action });
      expect(action).toBeEnabled();
      fireEvent.click(action);

      const tab = screen.getByRole("tab", { name: step.tab });
      expect(tab).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(tab).toHaveFocus());
      expect(
        screen.getByRole("textbox", { name: step.textbox }),
      ).toBeInTheDocument();
      expect(readSelectedCycleFrame(cycle.id, "active")).toBe(step.frame);
    }

    for (const name of ["D — Doへ進む", "C — Checkへ進む", "A — Actionへ進む"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it("keeps next-frame guidance available while a save is dirty, saving, or failed", async () => {
    const save = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    vi.mocked(saveCycleFrame).mockReset().mockReturnValueOnce(save.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "保存を待たずに進む計画" } });
    expect(screen.getByText("未保存")).toBeVisible();

    const goToDo = screen.getByRole("button", { name: "D — Doへ進む" });
    expect(goToDo).toBeEnabled();
    fireEvent.click(goToDo);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "D — Do" })).toBeVisible();
    expect(screen.getByText("保存中")).toBeVisible();

    const goToCheck = screen.getByRole("button", {
      name: "C — Checkへ進む",
    });
    expect(goToCheck).toBeEnabled();
    fireEvent.click(goToCheck);
    expect(screen.getByRole("textbox", { name: "C — Check" })).toBeVisible();

    await act(async () => save.reject(new Error("offline")));
    expect(await screen.findByText("保存失敗")).toBeVisible();
    const goToAction = screen.getByRole("button", {
      name: "A — Actionへ進む",
    });
    expect(goToAction).toBeEnabled();
    fireEvent.click(goToAction);
    expect(screen.getByRole("textbox", { name: "A — Action" })).toBeVisible();
  });

  it("restores the selected Frame when the same Active Cycle remounts", async () => {
    rememberSelectedCycleFrame(cycle.id, "check");
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    renderPage(cache);

    expect(await screen.findByRole("tab", { name: "C Check" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("textbox", { name: "C — Check" }),
    ).toBeInTheDocument();
  });

  it("keeps full tab names and marks an unselected recovery conflict", async () => {
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":do")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "この端末に残った実行",
            baseRevision: 9,
            updatedAt: "2026-09-08T00:00:00.000Z",
          }
        : null,
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const recoveryTab = await screen.findByRole("tab", {
      name: "D Do 要確認",
    });

    expect(screen.getByRole("tab", { name: "P Plan" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "C Check" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "A Action" })).toBeInTheDocument();
    expect(recoveryTab).toHaveAttribute("aria-selected", "false");
    expect(within(recoveryTab).getByText("要確認")).toBeVisible();
    expect(screen.getByRole("button", { name: "D — Doへ進む" })).toBeEnabled();
  });
});
