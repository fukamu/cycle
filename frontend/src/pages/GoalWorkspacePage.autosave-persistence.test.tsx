import { QueryClient } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { userQueryKeys } from "../features/goal-collection/goalCache";
import type { Cycle, Goal } from "../shared/api/schemas";
import { cyclePreviousActionReferenceCopy } from "../shared/copy/ja";
import { deleteGoal, getCycle, saveCycleFrame } from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import {
  createGoalDeletionAdvisoryHarness,
  currentCycleId,
  cycle,
  cycleWithPreviousAction,
  deferred,
  goal,
  registerGoalWorkspacePageTestLifecycle,
  renderPage,
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

describe("GoalWorkspacePage: autosave persistence", () => {
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
});
