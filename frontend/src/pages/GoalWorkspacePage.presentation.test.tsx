import { QueryClient } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { userQueryKeys } from "../features/goal-collection/goalCache";
import { APIError } from "../shared/api/client";
import type { Cycle, Goal } from "../shared/api/schemas";
import {
  cycleFrameCopy,
  cycleFrameTemplateCopy,
  cyclePreviousActionReferenceCopy,
  firstUseGuideCopy,
  frameCopy,
} from "../shared/copy/ja";
import {
  completeCycle,
  deleteGoal,
  generateAction,
  getCycle,
  getGoal,
  refineAction,
  saveCycleFrame,
} from "../shared/api/workspace";
import {
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import { activateFirstUseGuide } from "../shared/preferences/firstUseGuidePreference";
import {
  completableCycle,
  createGoalDeletionAdvisoryHarness,
  cycle,
  cycleWithPreviousAction,
  deferred,
  deletedGoalError,
  expandFrameTemplates,
  goal,
  goalWithPreviousAction,
  mockEchoingCycleSave,
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

describe("GoalWorkspacePage: presentation and initialization", () => {
  registerGoalWorkspacePageTestLifecycle();

  it("shows the pinned Cycle success signal as static multiline context", async () => {
    const pinnedSignal = "週3回できる\n夕方に余裕がある";
    vi.mocked(getCycle).mockResolvedValue({
      cycle: {
        ...cycle,
        goalVersion: { ...cycle.goalVersion, successSignal: pinnedSignal },
      },
    });
    renderPage(
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      }),
    );

    const region = await screen.findByRole("region", {
      name: "良くなったと分かるサイン",
    });
    expect(region.querySelector("p")).toHaveTextContent(pinnedSignal, {
      normalizeWhitespace: false,
    });
    expect(within(region).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("labels the text count for every P/D/C/A Frame without announcing each keystroke", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    for (const frame of ["plan", "do", "check", "action"] as const) {
      const copy = frameCopy[frame];
      fireEvent.click(
        await screen.findByRole("tab", {
          name: new RegExp(`${copy.label}\\s*${copy.name}`),
        }),
      );
      const count = frame === "plan" ? 5 : 0;
      const counter = screen.getByRole("status", {
        name: `${copy.label} — ${copy.name}は上限200文字中${count}文字です`,
      });
      expect(counter).toHaveTextContent(`${count} / 200文字`);
      expect(counter).toHaveAttribute("aria-live", "off");
    }
  });

  it("shows the exact previous Action between the Plan guide and editor only on active Plan", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: cycleWithPreviousAction });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const reference = await screen.findByRole("region", {
      name: cyclePreviousActionReferenceCopy.heading,
    });
    const guide = screen.getByText(frameCopy.plan.guide);
    const template = screen.getByRole("region", {
      name: cycleFrameTemplateCopy.heading,
    });
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    expect(
      guide.compareDocumentPosition(reference) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      reference.compareDocumentPosition(template) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      template.compareDocumentPosition(editor) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(reference).getByText("Cycle 1 · Goal v1")).toBeVisible();
    expect(
      within(reference).getByText(
        (_content, element) =>
          element?.textContent ===
          cycleWithPreviousAction.previousCompletedCycleAction?.action,
      ),
    ).toBeVisible();
    expect(within(reference).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(reference).queryByRole("button")).not.toBeInTheDocument();
    expect(saveCycleFrame).not.toHaveBeenCalled();

    for (const tab of [/D\s*Do/, /C\s*Check/, /A\s*Action/]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(
        screen.queryByRole("region", {
          name: cyclePreviousActionReferenceCopy.heading,
        }),
      ).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("tab", { name: /P\s*Plan/ }));
    expect(
      screen.getByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).toBeVisible();
  });

  it("does not render an empty previous Action reference for Cycle 1", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    expect(
      screen.queryByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps a saved review schedule hidden from the workspace", async () => {
    const reviewDate = "2026-09-25";
    vi.mocked(getCycle).mockResolvedValue({
      cycle: { ...cycle, reviewDate, reviewScheduleRevision: 3 },
    });
    vi.mocked(getGoal).mockResolvedValue({
      goal: {
        ...goal,
        currentWork: {
          kind: "active_cycle",
          cycleId: cycle.id,
          cycleSequenceNumber: cycle.sequenceNumber,
          reviewSchedule: { reviewDate, reviewScheduleRevision: 3 },
        },
      },
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(cache);

    await screen.findByText("保存済み");
    expect(screen.queryByText(reviewDate)).not.toBeInTheDocument();
    expect(view.container.querySelector('input[type="date"]')).toBeNull();
  });

  it("hides the previous Action before workspace-move conflict navigation", async () => {
    const movedGoal: Goal = {
      ...goalWithPreviousAction,
      status: "goal_review",
      revision: goalWithPreviousAction.revision + 1,
      currentWork: {
        kind: "goal_review",
        reviewDraftId,
        triggerCycleId: cycleWithPreviousAction.id,
        triggerCycleSequenceNumber: cycleWithPreviousAction.sequenceNumber,
      },
    };
    const completedCycle: Cycle = {
      ...cycleWithPreviousAction,
      status: "completed",
      previousCompletedCycleAction: null,
      completedAt: "2026-08-20T00:06:00.000Z",
    };
    vi.mocked(getGoal)
      .mockReset()
      .mockResolvedValueOnce({ goal: goalWithPreviousAction })
      .mockResolvedValueOnce({ goal: movedGoal });
    vi.mocked(getCycle)
      .mockReset()
      .mockResolvedValueOnce({ cycle: cycleWithPreviousAction })
      .mockResolvedValueOnce({ cycle: completedCycle });
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockRejectedValueOnce(
        new APIError(
          409,
          "GOAL_STATE_CONFLICT",
          "workspace moved",
          "request-previous-action-workspace-moved",
        ),
      );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    expect(
      await screen.findByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).toBeVisible();
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    fireEvent.change(editor, { target: { value: "移動前の計画" } });
    fireEvent.blur(editor);

    expect(
      await screen.findByText("現在の作業状態が更新されました"),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("現在の目標レビュー")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "現在の作業へ移動" }),
    ).toHaveAttribute("href", `/goals/${goal.id}/review`);
  });

  it("hides the previous Action before a deletion advisory cleanup completes", async () => {
    const cleanup = deferred<void>();
    vi.mocked(getGoal).mockResolvedValue({ goal: goalWithPreviousAction });
    vi.mocked(getCycle).mockResolvedValue({
      cycle: cycleWithPreviousAction,
    });
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValue(
      cleanup.promise,
    );
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache, { goalDeletionAdvisory: advisory });

    expect(
      await screen.findByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).toBeVisible();
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    expect(await screen.findByText("保存済み")).toBeVisible();

    await act(async () => {
      advisory.dispatch(session.user.id, goal.id);
      await Promise.resolve();
    });

    expect(
      screen.queryByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).not.toBeInTheDocument();
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
        session.user.id,
        goal.id,
      ),
    );
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();

    await act(async () => cleanup.resolve());
    expect(await screen.findByText("ホーム")).toBeVisible();
  });

  it("moves the eligible Cycle 1 guide from Plan to Do without stealing tab focus or saving", async () => {
    activateFirstUseGuide();
    const user = userEvent.setup();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    renderPage(cache);

    const guide = await screen.findByRole("complementary", {
      name: firstUseGuideCopy.heading,
    });
    expect(
      within(guide).getByText(firstUseGuideCopy.stages.plan.location),
    ).toBeInTheDocument();
    expect(
      within(guide).getByText(firstUseGuideCopy.stages.plan.guide),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "P — Plan" })).toHaveValue(
      cycle.plan,
    );

    const doTab = screen.getByRole("tab", { name: /D\s*Do/ });
    await user.click(doTab);

    await screen.findByText(firstUseGuideCopy.stages.do.location);
    expect(
      within(
        screen.getByRole("complementary", {
          name: firstUseGuideCopy.heading,
        }),
      ).getByText(firstUseGuideCopy.stages.do.guide),
    ).toBeInTheDocument();
    expect(doTab).toHaveFocus();
    expect(saveCycleFrame).not.toHaveBeenCalled();
    expect(generateAction).not.toHaveBeenCalled();
  });

  it("inserts a Plan template into Unicode whitespace through normal autosave and restores the exact prior value with Undo", async () => {
    const before = "\u00a0\u2003\n";
    const template = cycleFrameTemplateCopy.templates.plan[0];
    vi.mocked(getCycle).mockResolvedValue({
      cycle: { ...cycle, plan: before },
    });
    mockEchoingCycleSave();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    expandFrameTemplates();
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    const insert = screen.getByRole("button", {
      name: cycleFrameTemplateCopy.insert(template.name),
    });
    expect(insert).toHaveAttribute("aria-disabled", "false");

    fireEvent.click(insert);

    expect(editor).toHaveValue(template.content);
    await waitFor(() => expect(editor).toHaveFocus());
    expect((editor as HTMLTextAreaElement).selectionStart).toBe(
      template.content.length,
    );
    expect((editor as HTMLTextAreaElement).selectionEnd).toBe(
      template.content.length,
    );
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    expect(saveCycleFrame).toHaveBeenLastCalledWith(
      sessionLease,
      goal.id,
      cycle.id,
      "plan",
      template.content,
      0,
      session.csrfToken,
      expect.any(AbortSignal),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: cycleFrameTemplateCopy.undo,
      }),
    );

    expect(editor).toHaveValue(before);
    await waitFor(() => expect(editor).toHaveFocus());
    expect((editor as HTMLTextAreaElement).selectionStart).toBe(before.length);
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledTimes(2));
    expect(saveCycleFrame).toHaveBeenLastCalledWith(
      sessionLease,
      goal.id,
      cycle.id,
      "plan",
      before,
      1,
      session.csrfToken,
      expect.any(AbortSignal),
    );
  });

  it("keeps all previews visible without overwriting nonempty content and offers the matching Do templates", async () => {
    mockEchoingCycleSave();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    const planEditor = screen.getByRole("textbox", { name: "P — Plan" });
    const planRegion = screen.getByRole("region", {
      name: cycleFrameTemplateCopy.heading,
    });
    const planToggle = within(planRegion).getByRole("button", {
      name: cycleFrameTemplateCopy.toggle,
    });
    expect(planToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(planRegion).queryByRole("heading", {
        name: cycleFrameTemplateCopy.templates.plan[0].name,
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(planToggle);
    expect(
      within(planRegion).getByText(
        cycleFrameTemplateCopy.disabled.hasContent("P"),
      ),
    ).toBeVisible();
    for (const template of cycleFrameTemplateCopy.templates.plan) {
      expect(within(planRegion).getByText(template.name)).toBeVisible();
      expect(
        within(planRegion).getByText(
          (_content, element) => element?.textContent === template.content,
        ),
      ).toBeVisible();
      const insert = within(planRegion).getByRole("button", {
        name: cycleFrameTemplateCopy.insert(template.name),
      });
      expect(insert).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(insert);
    }
    expect(planEditor).toHaveValue(cycle.plan);
    expect(saveCycleFrame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const doRegion = screen.getByRole("region", {
      name: cycleFrameTemplateCopy.heading,
    });
    const doToggle = within(doRegion).getByRole("button", {
      name: cycleFrameTemplateCopy.toggle,
    });
    expect(doToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(doRegion).queryByText(
        cycleFrameTemplateCopy.templates.plan[0].name,
      ),
    ).not.toBeInTheDocument();
    expect(
      within(doRegion).queryByRole("heading", {
        name: cycleFrameTemplateCopy.templates.do[0].name,
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(doToggle);
    for (const template of cycleFrameTemplateCopy.templates.do) {
      expect(within(doRegion).getByText(template.name)).toBeVisible();
    }
    const doTemplate = cycleFrameTemplateCopy.templates.do[1];
    fireEvent.click(
      within(doRegion).getByRole("button", {
        name: cycleFrameTemplateCopy.insert(doTemplate.name),
      }),
    );
    const doEditor = screen.getByRole("textbox", { name: "D — Do" });
    expect(doEditor).toHaveValue(doTemplate.content);
    await waitFor(() => expect(doEditor).toHaveFocus());
    expect((doEditor as HTMLTextAreaElement).selectionStart).toBe(
      doTemplate.content.length,
    );
    expect(
      screen.getByRole("button", { name: cycleFrameTemplateCopy.undo }),
    ).toBeVisible();

    fireEvent.change(doEditor, {
      target: { value: `${doTemplate.content}記録` },
    });
    expect(
      screen.queryByRole("button", { name: cycleFrameTemplateCopy.undo }),
    ).not.toBeInTheDocument();

    for (const tab of [/C\s*Check/, /A\s*Action/]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(
        screen.queryByRole("region", {
          name: cycleFrameTemplateCopy.heading,
        }),
      ).not.toBeInTheDocument();
    }
  });

  it("blocks template insertion during IME composition and enables it after confirmation", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: { ...cycle, plan: "" } });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    expandFrameTemplates();
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    const insert = screen.getByRole("button", {
      name: cycleFrameTemplateCopy.insert(
        cycleFrameTemplateCopy.templates.plan[0].name,
      ),
    });
    fireEvent.compositionStart(editor);

    expect(insert).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(cycleFrameTemplateCopy.disabled.composition),
    ).toBeVisible();
    fireEvent.click(insert);
    expect(editor).toHaveValue("");
    expect(saveCycleFrame).not.toHaveBeenCalled();

    fireEvent.compositionEnd(editor);
    expect(insert).toHaveAttribute("aria-disabled", "false");
  });

  it("blocks template insertion while browser recovery needs a choice", async () => {
    vi.mocked(getCycle).mockResolvedValue({
      cycle: { ...cycleWithPreviousAction, plan: "" },
    });
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":plan")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "",
            baseRevision: 9,
            updatedAt: "2026-09-08T00:00:00.000Z",
          }
        : null,
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("別の更新が見つかりました");
    expect(
      screen.queryByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).not.toBeInTheDocument();
    expandFrameTemplates();
    const editor = screen.getByRole("textbox", { name: "P — Plan" });
    const insert = screen.getByRole("button", {
      name: cycleFrameTemplateCopy.insert(
        cycleFrameTemplateCopy.templates.plan[0].name,
      ),
    });
    expect(insert).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(cycleFrameTemplateCopy.disabled.recovery),
    ).toBeVisible();
    fireEvent.click(insert);
    expect(editor).toHaveValue("");
    expect(saveCycleFrame).not.toHaveBeenCalled();
  });

  it.each(["Goal", "Cycle"] as const)(
    "turns an initial %s GET GOAL_NOT_FOUND into one durable deletion fence",
    async (resource) => {
      const advisory = createGoalDeletionAdvisoryHarness();
      const deleted = deletedGoalError(`request-initial-${resource}`);
      if (resource === "Goal") vi.mocked(getGoal).mockRejectedValue(deleted);
      else vi.mocked(getCycle).mockRejectedValue(deleted);
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });

      renderPage(cache, { goalDeletionAdvisory: advisory });

      expect(await screen.findByText("ホーム")).toBeInTheDocument();
      expect(screen.getByText("Goal cache削除済み")).toBeInTheDocument();
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
        session.user.id,
        goal.id,
      );
      expect(advisory.publish).toHaveBeenCalledTimes(2);
      expect(getGoal).toHaveBeenCalledOnce();
      expect(getCycle).toHaveBeenCalledOnce();
    },
  );

  it("coalesces concurrent initial Goal and Cycle GOAL_NOT_FOUND responses", async () => {
    const advisory = createGoalDeletionAdvisoryHarness();
    vi.mocked(getGoal).mockRejectedValue(
      deletedGoalError("request-initial-goal"),
    );
    vi.mocked(getCycle).mockRejectedValue(
      deletedGoalError("request-initial-cycle"),
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    renderPage(cache, { goalDeletionAdvisory: advisory });

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
    expect(getGoal).toHaveBeenCalledOnce();
    expect(getCycle).toHaveBeenCalledOnce();
  });

  it("cleans an initial late GOAL_NOT_FOUND without replacing the newer route", async () => {
    const goalRequest = deferred<Awaited<ReturnType<typeof getGoal>>>();
    vi.mocked(getGoal).mockReturnValue(goalRequest.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    renderPage(cache, { commandRouteSwitch: true });
    fireEvent.click(
      await screen.findByRole("link", {
        name: "コマンド中に外部routeへ移動",
      }),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();

    await act(async () => {
      goalRequest.reject(deletedGoalError("request-late-initial-goal"));
    });

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(screen.getByText("外部route")).toBeInTheDocument();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
  });

  it("keeps an invalidated autosave GOAL_NOT_FOUND as a deletion witness", async () => {
    const saveRequest = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    vi.mocked(saveCycleFrame).mockReset().mockReturnValue(saveRequest.promise);
    const advisory = createGoalDeletionAdvisoryHarness();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    renderPage(cache, {
      goalDeletionAdvisory: advisory,
      identityQuiesceControl: true,
    });
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "送信後に削除された計画" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    const saveSignal = vi.mocked(saveCycleFrame).mock.calls[0]?.[7];
    expect(saveSignal).toBeInstanceOf(AbortSignal);

    fireEvent.click(
      screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
    );
    expect(await screen.findByText("切替準備完了")).toBeInTheDocument();
    expect(saveSignal?.aborted).toBe(true);

    await act(async () => {
      saveRequest.reject(deletedGoalError("request-late-autosave-goal"));
    });

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(saveCycleFrame).toHaveBeenCalledOnce();
    expect(advisory.publish).toHaveBeenCalledTimes(2);
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
    expect(getGoal).toHaveBeenCalledWith(
      sessionLease,
      goal.id,
      expect.any(AbortSignal),
    );
    expect(getCycle).toHaveBeenCalledWith(
      sessionLease,
      goal.id,
      cycle.id,
      expect.any(AbortSignal),
    );

    expect(screen.getByText("保存中")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "アクションを生成" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "AIで推敲" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "サイクルを完了" }),
    ).toBeDisabled();
    const savingGuidance = screen.getByText(
      "入力を保存しています。保存済みになるまでお待ちください。",
    );
    expect(savingGuidance).toHaveAttribute("role", "status");
    expect(
      screen.getByRole("button", { name: "アクションを生成" }),
    ).toHaveAttribute("aria-describedby", savingGuidance.id);
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

  it("explains autosave blockers beside Active Cycle Goal actions without gating Delete", async () => {
    const firstSave = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "plan",
        content: "保存状態を案内する計画",
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-08-20T00:01:00.000Z",
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(cache);

    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    fireEvent.click(screen.getByText("目標の操作"));
    const goalActions =
      view.container.querySelector<HTMLElement>(".goal-actions");
    expect(goalActions).not.toBeNull();
    if (!goalActions) throw new Error("Goal actions are missing");
    const achieve = within(goalActions).getByRole("button", {
      name: "目標を達成として終了",
    });
    const end = within(goalActions).getByRole("button", {
      name: "目標を終了",
    });
    const remove = within(goalActions).getByRole("button", {
      name: "目標を削除",
    });
    const expectTerminationGuidance = (text: string) => {
      const guidance = within(goalActions).getByText(text);
      expect(guidance).toBeVisible();
      expect(guidance).toHaveAttribute("role", "status");
      expect(guidance).toHaveAttribute("aria-live", "polite");
      expect(guidance).toHaveAttribute("aria-atomic", "true");
      expect(achieve).toBeDisabled();
      expect(end).toBeDisabled();
      expect(achieve).toHaveAttribute("aria-describedby", guidance.id);
      expect(end).toHaveAttribute("aria-describedby", guidance.id);
      expect(remove).toBeEnabled();
      expect(remove).not.toHaveAttribute("aria-describedby");
    };

    expect(achieve).toBeEnabled();
    expect(end).toBeEnabled();
    expect(remove).toBeEnabled();
    expect(
      goalActions.querySelector(".goal-actions__guidance"),
    ).toBeEmptyDOMElement();

    fireEvent.change(editor, {
      target: { value: "保存状態を案内する計画" },
    });
    expectTerminationGuidance(
      "目標を達成・終了するには、入力が保存済みになるまでお待ちください。",
    );

    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    expectTerminationGuidance(
      "目標を達成・終了するには、入力の保存完了をお待ちください。",
    );

    await act(async () =>
      firstSave.reject(
        new APIError(
          409,
          "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
          "different resource conflict",
          "60000000-0000-7000-8000-000000000052",
        ),
      ),
    );
    expect(await screen.findByText("保存失敗")).toBeInTheDocument();
    expectTerminationGuidance(
      "目標を達成・終了するには、「再試行」で入力を保存してください。",
    );

    fireEvent.click(screen.getByRole("button", { name: "再試行" }));

    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(saveCycleFrame).toHaveBeenCalledTimes(2);
    expect(achieve).toBeEnabled();
    expect(end).toBeEnabled();
    expect(remove).toBeEnabled();
    expect(achieve).not.toHaveAttribute("aria-describedby");
    expect(end).not.toHaveAttribute("aria-describedby");
    expect(remove).not.toHaveAttribute("aria-describedby");
    expect(
      goalActions.querySelector(".goal-actions__guidance"),
    ).toBeEmptyDOMElement();
  });

  it("explains an Action AI blocker only to Active Cycle Goal termination", async () => {
    const refinement = deferred<Awaited<ReturnType<typeof refineAction>>>();
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(refineAction).mockReturnValue(refinement.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(cache);

    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    fireEvent.click(screen.getByText("目標の操作"));
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
    fireEvent.click(screen.getByRole("button", { name: "AIで推敲" }));

    const goalActions =
      view.container.querySelector<HTMLElement>(".goal-actions");
    expect(goalActions).not.toBeNull();
    if (!goalActions) throw new Error("Goal actions are missing");
    const guidance = within(goalActions).getByText(
      "目標を達成・終了するには、アクションの推敲完了をお待ちください。",
    );
    const achieve = within(goalActions).getByRole("button", {
      name: "目標を達成として終了",
    });
    const end = within(goalActions).getByRole("button", {
      name: "目標を終了",
    });
    const remove = within(goalActions).getByRole("button", {
      name: "目標を削除",
    });
    expect(achieve).toBeDisabled();
    expect(end).toBeDisabled();
    expect(achieve).toHaveAttribute("aria-describedby", guidance.id);
    expect(end).toHaveAttribute("aria-describedby", guidance.id);
    expect(remove).toBeEnabled();
    expect(remove).not.toHaveAttribute("aria-describedby");

    await act(async () => refinement.reject(new Error("provider failure")));

    expect(
      await screen.findByText(
        "AI処理を完了できませんでした。現在のAは保持されています。",
      ),
    ).toBeInTheDocument();
    expect(achieve).toBeEnabled();
    expect(end).toBeEnabled();
    expect(remove).toBeEnabled();
    expect(
      goalActions.querySelector(".goal-actions__guidance"),
    ).toBeEmptyDOMElement();
  });

  it("associates pending command guidance with every Active Cycle Goal action", async () => {
    const deletion = deferred<Awaited<ReturnType<typeof deleteGoal>>>();
    vi.mocked(deleteGoal).mockReturnValue(deletion.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(cache);

    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const editor = screen.getByRole("textbox", { name: "D — Do" });
    expect(editor).not.toHaveAttribute("readonly");
    expect(editor).toHaveAttribute("placeholder", frameCopy.do.placeholder);
    fireEvent.click(screen.getByText("目標の操作"));
    fireEvent.click(screen.getByRole("button", { name: "目標を削除" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "目標を削除",
      }),
    );
    await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());
    expect(editor).toHaveAttribute("readonly");
    expect(editor).toHaveValue("");
    expect(editor).toHaveAttribute("placeholder", frameCopy.do.placeholder);
    expect(
      screen.queryByText(cycleFrameCopy.terminalEmpty, { exact: true }),
    ).not.toBeInTheDocument();

    const goalActions =
      view.container.querySelector<HTMLElement>(".goal-actions");
    expect(goalActions).not.toBeNull();
    if (!goalActions) throw new Error("Goal actions are missing");
    const guidance = within(goalActions).getByText(
      "現在の操作を処理しています。完了するまでお待ちください。",
    );
    expect(guidance).toHaveAttribute("role", "status");
    for (const name of ["目標を達成として終了", "目標を終了", "目標を削除"]) {
      const control = within(goalActions).getByRole("button", { name });
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute("aria-describedby", guidance.id);
    }

    await act(async () => deletion.reject(new Error("delete failed")));

    expect(
      await screen.findByText("目標を削除できませんでした。"),
    ).toBeInTheDocument();
    expect(
      goalActions.querySelector(".goal-actions__guidance"),
    ).toBeEmptyDOMElement();
  });

  it("explains missing P/D/C and follows the specified Action control order", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));

    const generate = screen.getByRole("button", { name: "アクションを生成" });
    const refine = screen.getByRole("button", { name: "AIで推敲" });
    const complete = screen.getByRole("button", { name: "サイクルを完了" });
    const saveStatus = screen.getByText("保存済み");
    const guidance = screen.getByText(
      "D・Cを入力して保存すると、Aの操作へ進めます。",
    );

    expect(guidance).toBeVisible();
    expect(generate).toBeDisabled();
    expect(refine).toBeDisabled();
    expect(complete).toBeDisabled();
    expect(guidance).toHaveAttribute("role", "status");
    expect(guidance).toHaveAttribute("aria-live", "polite");
    expect(generate).toHaveAttribute("aria-describedby", guidance.id);
    expect(refine).toHaveAttribute("aria-describedby", guidance.id);
    expect(complete).toHaveAttribute("aria-describedby", guidance.id);
    expect(
      generate.compareDocumentPosition(refine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      refine.compareDocumentPosition(saveStatus) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      saveStatus.compareDocumentPosition(complete) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("keeps Generate available and links only Refine and Complete to the missing A guidance", async () => {
    vi.mocked(getCycle).mockResolvedValue({
      cycle: {
        ...completableCycle,
        action: "",
        contentRevision: 3,
        frameRevisions: { ...completableCycle.frameRevisions, action: 0 },
      },
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));

    const generate = screen.getByRole("button", { name: "アクションを生成" });
    const refine = screen.getByRole("button", { name: "AIで推敲" });
    const complete = screen.getByRole("button", { name: "サイクルを完了" });
    const guidance = screen.getByText(
      "Aを入力するか「アクションを生成」を使うと、AIで推敲してサイクルを完了できます。",
    );

    expect(generate).toBeEnabled();
    expect(generate).not.toHaveAttribute("aria-describedby");
    expect(refine).toBeDisabled();
    expect(refine).toHaveAttribute("aria-describedby", guidance.id);
    expect(complete).toBeDisabled();
    expect(complete).toHaveAttribute("aria-describedby", guidance.id);
  });

  it("does not render warning text or descriptions when every Action control is available", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));

    for (const name of ["アクションを生成", "AIで推敲", "サイクルを完了"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeEnabled();
      expect(control).not.toHaveAttribute("aria-describedby");
    }
    expect(
      view.container.querySelector(".action-controls__guidance"),
    ).toBeEmptyDOMElement();
  });

  it("reviews the immutable goal and complete P/D/C/A in order before completion", async () => {
    const reviewedCycle: Cycle = {
      ...completableCycle,
      goalVersion: {
        ...completableCycle.goalVersion,
        versionNumber: 2,
        body: "固定された目標\n二行目",
      },
      sequenceNumber: 4,
      plan: "計画\n全文",
      do: "実行\n全文",
      check: "確認\n全文",
      action: "改善\n全文",
    };
    vi.mocked(getCycle).mockResolvedValue({ cycle: reviewedCycle });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
    fireEvent.click(screen.getByRole("button", { name: "サイクルを完了" }));
    const dialog = await screen.findByRole("dialog", {
      name: "サイクルを完了する前に確認",
    });

    expect(dialog).not.toHaveAttribute("aria-describedby");
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(within(dialog).getByText("Goal v2 · Cycle 4")).toBeVisible();
    const headings = within(dialog).getAllByRole("heading");
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "サイクルを完了する前に確認",
      "目標",
      "P — Plan",
      "D — Do",
      "C — Check",
      "A — Action",
    ]);
    for (const content of [
      "固定された目標\n二行目",
      "計画\n全文",
      "実行\n全文",
      "確認\n全文",
      "改善\n全文",
    ])
      expect(
        [...dialog.querySelectorAll("p")].some(
          (paragraph) => paragraph.textContent === content,
        ),
      ).toBe(true);
    expect(
      within(dialog).getByText(
        "完了後はP/D/C/Aを編集できません。目標の見直しへ進みます。",
      ),
    ).toBeVisible();
    expect(completeCycle).not.toHaveBeenCalled();
  });

  it("closes the completion summary and focuses the selected frame for editing", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
    fireEvent.click(screen.getByRole("button", { name: "サイクルを完了" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Dを編集" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /D\s*Do/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const editor = screen.getByRole("textbox", {
      name: "D — Do",
    }) as HTMLTextAreaElement;
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveValue("実行");
    expect(saveCycleFrame).not.toHaveBeenCalled();
    expect(completeCycle).not.toHaveBeenCalled();
  });

  it("cancels completion without changing editor or save state and returns focus", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
    const complete = screen.getByRole("button", { name: "サイクルを完了" });
    complete.focus();
    fireEvent.click(complete);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(complete).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "A — Action" })).toHaveValue(
      "改善",
    );
    expect(screen.getByText("保存済み")).toBeVisible();
    expect(saveCycleFrame).not.toHaveBeenCalled();
    expect(putBrowserDraft).not.toHaveBeenCalled();
    expect(completeCycle).not.toHaveBeenCalled();

    fireEvent.click(complete);
    const reopened = await screen.findByRole("dialog");
    fireEvent(
      reopened,
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(complete).toHaveFocus();
    expect(saveCycleFrame).not.toHaveBeenCalled();
    expect(completeCycle).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Canceled empty",
      terminalCycle: {
        ...cycle,
        status: "canceled",
        plan: "",
        canceledAt: "2026-08-20T00:06:00.000Z",
        cancellationReason: "goal_ended",
      },
      emptyFrames: { plan: true, do: true, check: true, action: true },
    },
    {
      label: "Canceled Unicode-whitespace-only",
      terminalCycle: {
        ...cycle,
        status: "canceled",
        plan: "\u0085",
        do: "\u00a0",
        check: "\u2003",
        action: "\u3000",
        canceledAt: "2026-08-20T00:06:00.000Z",
        cancellationReason: "goal_ended",
      },
      emptyFrames: { plan: true, do: true, check: true, action: true },
    },
    {
      label: "Canceled filled",
      terminalCycle: {
        ...completableCycle,
        status: "canceled",
        canceledAt: "2026-08-20T00:06:00.000Z",
        cancellationReason: "goal_ended",
      },
      emptyFrames: { plan: false, do: false, check: false, action: false },
    },
    {
      label: "Completed filled",
      terminalCycle: {
        ...completableCycle,
        status: "completed",
        completedAt: "2026-08-20T00:06:00.000Z",
      },
      emptyFrames: { plan: false, do: false, check: false, action: false },
    },
    {
      label: "Canceled mixed",
      terminalCycle: {
        ...cycle,
        status: "canceled",
        plan: "入力済みの計画",
        do: "",
        check: "\u2003",
        action: "改善\n次へ",
        canceledAt: "2026-08-20T00:06:00.000Z",
        cancellationReason: "goal_ended",
      },
      emptyFrames: { plan: false, do: true, check: true, action: false },
    },
  ] satisfies Array<{
    label: string;
    terminalCycle: Cycle;
    emptyFrames: {
      plan: boolean;
      do: boolean;
      check: boolean;
      action: boolean;
    };
  }>)(
    "renders $label frames as immutable values without editable examples",
    async ({ terminalCycle, emptyFrames }) => {
      const user = userEvent.setup();
      vi.mocked(getCycle).mockResolvedValue({ cycle: terminalCycle });
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      renderPage(cache);

      await screen.findByText("読み取り専用");
      const frameCases = [
        { frame: "plan", tab: /P\s*Plan/, textbox: "P — Plan" },
        { frame: "do", tab: /D\s*Do/, textbox: "D — Do" },
        { frame: "check", tab: /C\s*Check/, textbox: "C — Check" },
        { frame: "action", tab: /A\s*Action/, textbox: "A — Action" },
      ] as const;

      for (const [index, { frame, tab, textbox }] of frameCases.entries()) {
        const frameTab = screen.getByRole("tab", { name: tab });
        if (index === 0) {
          frameTab.focus();
        } else {
          await user.click(frameTab);
        }
        const editor = screen.getByRole("textbox", { name: textbox });
        if (index === 0) {
          await user.tab();
          expect(editor).toHaveFocus();
        }

        expect(editor).toHaveAttribute("readonly");
        expect(editor).toHaveAttribute("aria-readonly", "true");
        expect(editor).toHaveValue(terminalCycle[frame]);
        expect(
          screen.queryByRole("region", {
            name: cycleFrameTemplateCopy.heading,
          }),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("region", {
            name: cyclePreviousActionReferenceCopy.heading,
          }),
        ).not.toBeInTheDocument();
        expect(
          document.querySelector('label[for="cycle-frame-editor"]'),
        ).toHaveTextContent(frameCopy[frame].name);
        const count = Array.from(terminalCycle[frame]).length;
        expect(
          screen.getByRole("status", {
            name: `${textbox}は上限200文字中${count}文字です`,
          }),
        ).toHaveTextContent(`${count} / 200文字`);
        const describedBy =
          editor.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
        expect(describedBy).toContain("cycle-frame-guide");

        if (emptyFrames[frame]) {
          expect(editor).not.toHaveAttribute("placeholder");
          const empty = screen.getByText("未入力", { exact: true });
          expect(empty).toBeVisible();
          expect(empty.id).not.toBe("");
          expect(describedBy).toContain(empty.id);
          expect(
            editor.compareDocumentPosition(empty) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        } else {
          expect(editor).toHaveAttribute(
            "placeholder",
            frameCopy[frame].placeholder,
          );
          expect(
            screen.queryByText(cycleFrameCopy.terminalEmpty, { exact: true }),
          ).not.toBeInTheDocument();
        }
      }
      expect(saveCycleFrame).not.toHaveBeenCalled();
    },
  );

  it("fails closed on a stale Active cache view until the terminal Goal and Cycle converge", async () => {
    const refreshedCycle = deferred<Awaited<ReturnType<typeof getCycle>>>();
    const staleActiveCycle: Cycle = { ...cycle, plan: "" };
    const canonicalCanceledCycle: Cycle = {
      ...staleActiveCycle,
      status: "canceled",
      canceledAt: "2026-08-20T00:06:00.000Z",
      cancellationReason: "goal_ended",
    };
    const endedGoal: Goal = {
      ...goal,
      status: "ended",
      currentWork: null,
      terminalAt: "2026-08-20T00:06:00.000Z",
    };
    vi.mocked(getGoal).mockResolvedValue({ goal: endedGoal });
    vi.mocked(getCycle).mockReturnValue(refreshedCycle.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    cache.setQueryData(userQueryKeys.goal(session.user.id, goal.id), {
      goal: endedGoal,
    });
    cache.setQueryData(
      userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
      { cycle: staleActiveCycle },
    );
    renderPage(cache);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "読み込めませんでした。",
    );
    expect(
      screen.queryByRole("textbox", { name: "P — Plan" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(getCycle).toHaveBeenCalledOnce());

    await act(async () =>
      refreshedCycle.resolve({ cycle: canonicalCanceledCycle }),
    );

    await screen.findByText("読み取り専用");
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    expect(editor).toHaveAttribute("readonly");
    expect(editor).toHaveAttribute("aria-readonly", "true");
    expect(editor).toHaveValue("");
    expect(editor).not.toHaveAttribute("placeholder");
    const empty = screen.getByText("未入力", { exact: true });
    expect(empty).toBeVisible();
    expect(empty.id).not.toBe("");
    expect(editor.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(
      expect.arrayContaining(["cycle-frame-guide", empty.id]),
    );
  });

  it("keeps the editable example for an empty Active Action while AI temporarily makes it read-only", async () => {
    const generation = deferred<Awaited<ReturnType<typeof generateAction>>>();
    vi.mocked(getCycle).mockResolvedValue({
      cycle: { ...completableCycle, action: "" },
    });
    vi.mocked(generateAction).mockReturnValue(generation.promise);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
    const editor = screen.getByRole("textbox", { name: "A — Action" });
    expect(editor).not.toHaveAttribute("readonly");
    expect(editor).toHaveValue("");
    expect(editor).toHaveAttribute("placeholder", frameCopy.action.placeholder);
    expect(
      screen.queryByText(cycleFrameCopy.terminalEmpty, { exact: true }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "アクションを生成" }));
    await waitFor(() => expect(generateAction).toHaveBeenCalledOnce());

    expect(editor).toHaveAttribute("readonly");
    expect(editor).toHaveAttribute("aria-readonly", "true");
    expect(editor).toHaveValue("");
    expect(editor).toHaveAttribute("placeholder", frameCopy.action.placeholder);
    expect(editor).toHaveAttribute("aria-describedby", "cycle-frame-guide");
    expect(
      screen.queryByText(cycleFrameCopy.terminalEmpty, { exact: true }),
    ).not.toBeInTheDocument();

    await act(async () => generation.reject(new Error("provider failure")));
    expect(
      await screen.findByText(
        "AI処理を完了できませんでした。現在のAは保持されています。",
      ),
    ).toBeVisible();
  });

  it.each([
    {
      status: "completed",
      endedAt: { completedAt: "2026-08-20T00:06:00.000Z" },
    },
    {
      status: "canceled",
      endedAt: {
        canceledAt: "2026-08-20T00:06:00.000Z",
        cancellationReason: "goal_ended",
      },
    },
  ] as const)(
    "keeps $status Cycle actions read-only without presenting unavailable CTAs",
    async ({ status, endedAt }) => {
      vi.mocked(getCycle).mockResolvedValue({
        cycle: {
          ...completableCycle,
          status,
          ...endedAt,
          reviewDate: "2026-09-25",
          reviewScheduleRevision: 2,
        },
      });
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const advisory = createGoalDeletionAdvisoryHarness();
      const view = renderPage(cache, { goalDeletionAdvisory: advisory });

      await screen.findByText("読み取り専用");
      expect(screen.queryByText("2026-09-25")).not.toBeInTheDocument();
      expect(view.container.querySelector('input[type="date"]')).toBeNull();
      expect(
        view.container.querySelector(".goal-actions"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "D — Doへ進む" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
      expect(
        screen.queryByRole("button", { name: "今の実行を記録" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "C — Checkへ進む" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: /C\s*Check/ }));
      expect(
        screen.queryByRole("button", { name: "A — Actionへ進む" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));

      expect(
        screen.getByRole("textbox", { name: "A — Action" }),
      ).toHaveAttribute("readonly");
      for (const name of ["アクションを生成", "AIで推敲", "サイクルを完了"]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }

      act(() => advisory.dispatch(session.user.id, goal.id));
      await screen.findByText("Goal cache削除済み");
      expect(
        screen.queryByRole("button", { name: "今の実行を記録" }),
      ).not.toBeInTheDocument();
    },
  );

  it("adds one browser-local D heading, focuses the end, and uses normal autosave", async () => {
    mockEchoingCycleSave();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    expect(
      screen.queryByRole("button", { name: "今の実行を記録" }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("tab", { name: /D\s*Do/ }));
    const editor = screen.getByRole("textbox", {
      name: "D — Do",
    }) as HTMLTextAreaElement;
    const add = screen.getByRole("button", { name: "今の実行を記録" });

    expect(add).toHaveAttribute("aria-disabled", "false");
    expect(add).toHaveAccessibleDescription(
      "この端末の現在時刻をDに追加します。サーバーの基準時刻ではありません。",
    );
    fireEvent.click(add);
    fireEvent.click(add);

    const content = editor.value;
    expect(content).toMatch(
      /^【\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} UTC[+-]\d{2}:\d{2}】\n$/,
    );
    expect(
      screen.getByText("同じ日時の見出しはすでに追加されています。"),
    ).toBeVisible();
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor.selectionStart).toBe(content.length);
    expect(editor.selectionEnd).toBe(content.length);

    await waitFor(() => expect(putBrowserDraft).toHaveBeenCalledOnce());
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: session.user.id,
        goalId: goal.id,
        subjectKey: `cycle:${cycle.id}:do`,
        body: content,
        baseRevision: 0,
      }),
    );
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce(), {
      timeout: 2_000,
    });
    expect(saveCycleFrame).toHaveBeenCalledWith(
      sessionLease,
      goal.id,
      cycle.id,
      "do",
      content,
      0,
      session.csrfToken,
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(screen.getByText("保存済み")).toBeVisible());
  });

  it("restores the exact pre-insert D through the same serialized save queue", async () => {
    const first = deferred<Awaited<ReturnType<typeof saveCycleFrame>>>();
    const startingCycle = { ...cycle, do: "実行\n末尾の空白 \t" };
    vi.mocked(getCycle).mockResolvedValue({ cycle: startingCycle });
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(
        async (_lease, _goalId, _cycleId, frame, body) => ({
          cycleId: cycle.id,
          frame,
          content: body,
          frameRevision: 2,
          contentRevision: 2,
          savedAt: "2026-09-08T00:02:00.000Z",
        }),
      );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const editor = screen.getByRole("textbox", {
      name: "D — Do",
    }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "今の実行を記録" }));
    const inserted = editor.value;
    expect(inserted.startsWith(`${startingCycle.do}\n\n【`)).toBe(true);
    fireEvent.blur(editor);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "今の実行を記録" }),
    ).toHaveAttribute("aria-disabled", "false");

    fireEvent.click(
      screen.getByRole("button", { name: "日時の追加を取り消す" }),
    );
    expect(editor).toHaveValue(startingCycle.do);
    expect(
      screen.queryByRole("button", { name: "日時の追加を取り消す" }),
    ).not.toBeInTheDocument();
    expect(saveCycleFrame).toHaveBeenCalledOnce();

    await act(async () =>
      first.resolve({
        cycleId: cycle.id,
        frame: "do",
        content: inserted,
        frameRevision: 1,
        contentRevision: 1,
        savedAt: "2026-09-08T00:01:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(saveCycleFrame).toHaveBeenNthCalledWith(
        2,
        sessionLease,
        goal.id,
        cycle.id,
        "do",
        startingCycle.do,
        1,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor.selectionStart).toBe(startingCycle.do.length);
    await waitFor(() => expect(screen.getByText("保存済み")).toBeVisible());
  });

  it("invalidates quick-entry Undo after manual D input", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const editor = screen.getByRole("textbox", { name: "D — Do" });
    fireEvent.click(screen.getByRole("button", { name: "今の実行を記録" }));
    expect(
      screen.getByRole("button", { name: "日時の追加を取り消す" }),
    ).toBeVisible();

    fireEvent.change(editor, {
      target: { value: `${(editor as HTMLTextAreaElement).value}事実` },
    });

    expect(
      screen.queryByRole("button", { name: "日時の追加を取り消す" }),
    ).not.toBeInTheDocument();
  });

  it("keeps D unchanged and explains the exact code-point shortage", async () => {
    const fullD = "😀".repeat(200);
    vi.mocked(getCycle).mockResolvedValue({ cycle: { ...cycle, do: fullD } });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const editor = screen.getByRole("textbox", { name: "D — Do" });
    fireEvent.click(screen.getByRole("button", { name: "今の実行を記録" }));

    expect(editor).toHaveValue(fullD);
    expect(
      screen.getByText(
        "追加後は231文字になるため、Dをあと31文字減らしてください（上限200文字）。",
      ),
    ).toBeVisible();
    expect(saveCycleFrame).not.toHaveBeenCalled();
    expect(putBrowserDraft).not.toHaveBeenCalled();
  });

  it("blocks quick entry during D composition and enables it after confirmation", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const editor = screen.getByRole("textbox", { name: "D — Do" });
    const add = screen.getByRole("button", { name: "今の実行を記録" });
    fireEvent.compositionStart(editor);

    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("文字の変換を確定してから追加してください。"),
    ).toBeVisible();
    fireEvent.pointerDown(add);
    fireEvent.click(add);
    expect(editor).toHaveValue("");
    expect(saveCycleFrame).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "変換中" } });
    expect(editor).toHaveValue("変換中");
    expect(saveCycleFrame).not.toHaveBeenCalled();
    expect(putBrowserDraft).not.toHaveBeenCalled();

    fireEvent.compositionEnd(editor);
    expect(add).toHaveAttribute("aria-disabled", "false");
    expect(editor).toHaveValue("変換中");
    fireEvent.click(add);
    expect(editor).not.toHaveValue("");
  });

  it("blocks quick entry while D browser recovery needs a choice", async () => {
    const recoveredBody = "この端末に残った実行";
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":do")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: recoveredBody,
            baseRevision: 9,
            updatedAt: "2026-09-08T00:00:00.000Z",
          }
        : null,
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    fireEvent.click(await screen.findByRole("tab", { name: /D\s*Do/ }));
    await screen.findByText("別の更新が見つかりました");
    const editor = screen.getByRole("textbox", { name: "D — Do" });
    const add = screen.getByRole("button", { name: "今の実行を記録" });

    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("確認待ちの入力を解決してから追加してください。"),
    ).toBeVisible();
    fireEvent.click(add);
    expect(editor).toHaveValue(recoveredBody);
    expect(saveCycleFrame).not.toHaveBeenCalled();
  });

  it("uses a new D edit to resume the existing failed autosave path", async () => {
    vi.mocked(saveCycleFrame)
      .mockReset()
      .mockRejectedValueOnce(
        new APIError(
          409,
          "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
          "save failed",
          "60000000-0000-7000-8000-000000000051",
        ),
      )
      .mockImplementationOnce(
        async (_lease, _goalId, _cycleId, frame, body) => ({
          cycleId: cycle.id,
          frame,
          content: body,
          frameRevision: 1,
          contentRevision: 1,
          savedAt: "2026-09-08T00:01:00.000Z",
        }),
      );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /D\s*Do/ }));
    const editor = screen.getByRole("textbox", { name: "D — Do" });
    fireEvent.change(editor, { target: { value: "保存に失敗した実行" } });
    fireEvent.blur(editor);
    expect(await screen.findByText("保存失敗")).toBeVisible();
    const add = screen.getByRole("button", { name: "今の実行を記録" });
    expect(add).toHaveAttribute("aria-disabled", "false");

    fireEvent.click(add);

    const content = (editor as HTMLTextAreaElement).value;
    expect(content.startsWith("保存に失敗した実行\n\n【")).toBe(true);
    await waitFor(() => expect(saveCycleFrame).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    expect(saveCycleFrame).toHaveBeenLastCalledWith(
      sessionLease,
      goal.id,
      cycle.id,
      "do",
      content,
      0,
      session.csrfToken,
      expect.any(AbortSignal),
    );
  });

  it("prioritizes recovery guidance over missing-frame guidance", async () => {
    vi.mocked(getCycle).mockResolvedValue({
      cycle: { ...completableCycle, plan: "" },
    });
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":plan")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: "",
            baseRevision: 9,
            updatedAt: new Date().toISOString(),
          }
        : null,
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(cache);

    await screen.findByText("別の更新が見つかりました");
    const recoveryEditor = screen.getByRole("textbox", { name: "P — Plan" });
    expect(recoveryEditor).toHaveAttribute("readonly");
    expect(recoveryEditor).toHaveAttribute("aria-readonly", "true");
    expect(recoveryEditor).toHaveValue("");
    expect(recoveryEditor).toHaveAttribute(
      "placeholder",
      frameCopy.plan.placeholder,
    );
    expect(
      screen.queryByText(cycleFrameCopy.terminalEmpty, { exact: true }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));

    const guidance = screen.getByText(
      "確認待ちの入力があります。「要確認」のフレームを開き、使用する内容を選んでください。",
    );
    expect(guidance).toBeVisible();
    for (const name of ["アクションを生成", "AIで推敲", "サイクルを完了"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-describedby",
        guidance.id,
      );
    }
    fireEvent.click(screen.getByText("目標の操作"));
    const goalActions =
      view.container.querySelector<HTMLElement>(".goal-actions");
    expect(goalActions).not.toBeNull();
    if (!goalActions) throw new Error("Goal actions are missing");
    const goalGuidance = within(goalActions).getByText(
      "目標を達成・終了するには、「要確認」のフレームを開き、使用する内容を選んでください。",
    );
    for (const name of ["目標を達成として終了", "目標を終了"]) {
      const control = within(goalActions).getByRole("button", { name });
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute("aria-describedby", goalGuidance.id);
    }
    const remove = within(goalActions).getByRole("button", {
      name: "目標を削除",
    });
    expect(remove).toBeEnabled();
    expect(remove).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();
  });

  it("explains a failed Action save and removes the guidance after retry succeeds", async () => {
    vi.mocked(getCycle).mockResolvedValue({ cycle: completableCycle });
    vi.mocked(saveCycleFrame)
      .mockRejectedValueOnce(
        new APIError(
          409,
          "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
          "different resource conflict",
          "60000000-0000-7000-8000-000000000019",
        ),
      )
      .mockResolvedValueOnce({
        cycleId: cycle.id,
        frame: "action",
        content: "保存できない改善",
        frameRevision: 2,
        contentRevision: 5,
        savedAt: "2026-08-20T00:02:00.000Z",
      });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = renderPage(cache);

    await screen.findByText("保存済み");
    fireEvent.click(screen.getByRole("tab", { name: /A\s*Action/ }));
    const editor = screen.getByRole("textbox", { name: "A — Action" });
    fireEvent.change(editor, { target: { value: "保存できない改善" } });
    fireEvent.blur(editor);

    expect(await screen.findByText("保存失敗")).toBeInTheDocument();
    const guidance = screen.getByText(
      "入力を保存できていません。「再試行」で保存してから操作してください。",
    );
    expect(guidance).toBeVisible();
    const retry = screen.getByRole("button", { name: "再試行" });
    expect(retry).toBeVisible();
    for (const name of ["アクションを生成", "AIで推敲", "サイクルを完了"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-describedby",
        guidance.id,
      );
    }

    fireEvent.click(retry);

    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(saveCycleFrame).toHaveBeenCalledTimes(2);
    expect(
      view.container.querySelector(".action-controls__guidance"),
    ).toBeEmptyDOMElement();
    for (const name of ["アクションを生成", "AIで推敲", "サイクルを完了"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeEnabled();
      expect(control).not.toHaveAttribute("aria-describedby");
    }
  });
});
