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
  createGoalDeletionAdvisoryHarness,
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

describe("GoalWorkspacePage: autosave and recovery", () => {
  registerGoalWorkspacePageTestLifecycle();

  it("keeps hydration-time input and saves it only after every draft read completes", async () => {
    const hydration = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    const localBody = "読込中に編集した計画";
    vi.mocked(getCycle).mockResolvedValue({ cycle: cycleWithPreviousAction });
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
    expect(
      screen.queryByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).not.toBeInTheDocument();

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
    expect(
      await screen.findByRole("region", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).toBeVisible();
    await waitFor(
      () =>
        expect(saveCycleFrame).toHaveBeenCalledWith(
          sessionLease,
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
    const advisory = createGoalDeletionAdvisoryHarness();
    renderPage(cache, { goalDeletionAdvisory: advisory });
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
          sessionLease,
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
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
    expect(advisory.publish).not.toHaveBeenCalled();
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
    expect(vi.mocked(saveCycleFrame).mock.calls[0]?.[7]).toEqual(
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
      sessionLease,
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
        requestedCycleId === nextCycle.id ? { cycle: nextCycle } : { cycle },
    );
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.startsWith("cycle:" + cycle.id + ":") ? oldHydration.promise : null,
    );
    vi.mocked(saveCycleFrame).mockImplementation(
      async (_lease, _goalId, cycleId, frame, content) => ({
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
    await act(async () => {
      cache.setQueryData(userQueryKeys.goal(session.user.id, goal.id), {
        goal: nextGoal,
      });
      fireEvent.click(screen.getByRole("link", { name: "別のCycleへ移動" }));
    });

    const nextEditor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(nextEditor).toHaveValue(nextCycle.plan));
    expect(saveCycleFrame).not.toHaveBeenCalled();

    await act(async () => oldHydration.resolve(null));

    await waitFor(
      () =>
        expect(saveCycleFrame).toHaveBeenCalledWith(
          sessionLease,
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
          sessionLease,
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

  it("accepts 200 non-BMP code points and explains the atomic rejection of the 201st", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    const twoHundredCodePoints = "😀".repeat(200);

    expect(editor).not.toHaveAttribute("maxlength");
    fireEvent.change(editor, { target: { value: twoHundredCodePoints } });

    expect(editor).toHaveValue(twoHundredCodePoints);
    const counter = screen.getByRole("status", {
      name: "P — Planは上限200文字中200文字です",
    });
    expect(counter).toHaveTextContent("200 / 200文字");
    const saveCallsBeforeRejection =
      vi.mocked(saveCycleFrame).mock.calls.length;
    const cacheCallsBeforeRejection =
      vi.mocked(putBrowserDraft).mock.calls.length;

    fireEvent.change(editor, {
      target: { value: `${twoHundredCodePoints}😀` },
    });

    expect(editor).toHaveValue(twoHundredCodePoints);
    expect(counter).toHaveTextContent("200 / 200文字");
    const feedback = screen.getByText(
      "入力後は201文字になるため反映できませんでした。上限200文字まで、入力内容をあと1文字減らしてください。",
    );
    expect(feedback).toHaveAttribute("role", "status");
    expect(editor.getAttribute("aria-describedby")).toContain(feedback.id);
    expect(saveCycleFrame).toHaveBeenCalledTimes(saveCallsBeforeRejection);
    expect(putBrowserDraft).toHaveBeenCalledTimes(cacheCallsBeforeRejection);

    fireEvent.click(screen.getByRole("button", { name: "D — Doへ進む" }));

    expect(feedback).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /D\s*Do/ })).toHaveFocus(),
    );
    expect(saveCycleFrame).toHaveBeenCalledTimes(saveCallsBeforeRejection + 1);
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
        sessionLease,
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
        sessionLease,
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
        sessionLease,
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
        sessionLease,
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

  it("preserves a dirty Cycle frame on pagehide before either debounce elapses", async () => {
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);
    const editor = await screen.findByRole("textbox", { name: "P — Plan" });
    await waitFor(() => expect(getBrowserDraft).toHaveBeenCalledTimes(4));
    vi.useFakeTimers();

    fireEvent.change(editor, { target: { value: "終了直前の計画" } });
    expect(putBrowserDraft).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(putBrowserDraft).toHaveBeenCalledOnce();
    expect(putBrowserDraft).toHaveBeenCalledWith({
      userId: session.user.id,
      goalId: goal.id,
      subjectKey: `cycle:${cycle.id}:plan`,
      body: "終了直前の計画",
      baseRevision: 0,
      updatedAt: expect.any(String),
    });
    expect(saveCycleFrame).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(putBrowserDraft).toHaveBeenCalledOnce();
    expect(saveCycleFrame).not.toHaveBeenCalled();
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
        sessionLease,
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

  it("compares saved P and D without exposing a pending browser draft", async () => {
    const browserOnlyPlan = "比較欄には出してはいけない端末の計画";
    vi.mocked(getBrowserDraft).mockImplementation(async (_userId, key) =>
      key.endsWith(":plan")
        ? {
            userId: session.user.id,
            goalId: goal.id,
            subjectKey: key,
            body: browserOnlyPlan,
            baseRevision: 9,
            updatedAt: new Date().toISOString(),
          }
        : null,
    );
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    renderPage(cache);

    const planEditor = await screen.findByRole("textbox", {
      name: "P — Plan",
    });
    await waitFor(() => expect(planEditor).toHaveValue(browserOnlyPlan));
    expect(planEditor).toHaveAttribute("readonly");

    fireEvent.click(screen.getByRole("tab", { name: /C\s*Check/ }));
    const comparison = await screen.findByRole("region", {
      name: "今回のPとDを比べる",
    });
    expect(within(comparison).getByText(cycle.plan)).toBeInTheDocument();
    expect(
      within(comparison).queryByText(browserOnlyPlan),
    ).not.toBeInTheDocument();
    expect(within(comparison).getByText("要確認")).toBeInTheDocument();

    fireEvent.click(
      within(comparison).getByRole("button", { name: "Pの入力を確認" }),
    );
    const recoveryNotice = (
      await screen.findByText("別の更新が見つかりました")
    ).closest<HTMLElement>('[role="alert"]');
    expect(recoveryNotice).not.toBeNull();
    await waitFor(() => expect(recoveryNotice).toHaveFocus());
    expect(screen.getByRole("tab", { name: /P\s*Plan/ })).toHaveAttribute(
      "aria-selected",
      "true",
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
