import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { userQueryKeys } from "../features/goal-collection/goalCache";
import type { GoalDraft, GoalReview } from "../shared/api/schemas";
import { firstUseGuideCopy } from "../shared/copy/ja";
import {
  adoptReview,
  getReview,
  refineReview,
  saveReview,
  terminateGoal,
} from "../shared/api/workspace";
import {
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import { activateFirstUseGuide } from "../shared/preferences/firstUseGuidePreference";
import {
  activeReviewTransportKey,
  createCache,
  deferred,
  deletedGoalError,
  expectBefore,
  expectDescribedBy,
  expectNotDescribedBy,
  goal,
  goalDeletionAdvisoryHarness,
  registerGoalReviewPageTestLifecycle,
  renderPage,
  replacementReview,
  replacementReviewDraft,
  review,
  reviewDraft,
  session,
  sessionLease,
  triggerCycle,
} from "./GoalReviewPage.test-harness";

vi.mock("../shared/api/workspace", () => ({
  adoptReview: vi.fn(),
  continueReview: vi.fn(),
  deleteGoal: vi.fn(),
  getGoal: vi.fn(),
  getReview: vi.fn(),
  refineReview: vi.fn(),
  saveReview: vi.fn(),
  terminateGoal: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn(),
  deleteBrowserDraftIfUnchanged: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
  tombstoneDeletedGoalAndClearDrafts: vi.fn(),
}));

describe("GoalReviewPage: editor and refinement", () => {
  registerGoalReviewPageTestLifecycle();

  it("shows the eligible Cycle 1 Review guide without changing the draft or autosave", async () => {
    activateFirstUseGuide();

    renderPage();

    const guide = await screen.findByRole("complementary", {
      name: firstUseGuideCopy.heading,
    });
    expect(
      within(guide).getByText(firstUseGuideCopy.stages.review.location),
    ).toBeInTheDocument();
    expect(
      within(guide).getByText(firstUseGuideCopy.stages.review.guide),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      }),
    ).toHaveValue(reviewDraft.body);
    expect(saveReview).not.toHaveBeenCalled();
    expect(refineReview).not.toHaveBeenCalled();
  });

  it("turns the initial Review GET GOAL_NOT_FOUND into durable deletion cleanup", async () => {
    vi.mocked(getReview).mockRejectedValue(
      deletedGoalError("request-initial-review"),
    );

    renderPage();

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(screen.getByText("Goal cache削除済み")).toBeInTheDocument();
    expect(getReview).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
    );
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });

  it("retries only initial Review deletion cleanup without resending its GET", async () => {
    vi.mocked(getReview).mockRejectedValue(
      deletedGoalError("request-initial-review-retry"),
    );
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("private IndexedDB failure"))
      .mockResolvedValueOnce(undefined);

    renderPage();

    expect(
      await screen.findByText(
        "削除済みGoalのブラウザ下書きを削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(getReview).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(getReview).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });

  it("cleans an initial late Review GOAL_NOT_FOUND without replacing the newer route", async () => {
    const reviewRequest = deferred<GoalReview>();
    vi.mocked(getReview).mockReturnValue(reviewRequest.promise);

    renderPage(createCache(), false, false, true);
    fireEvent.click(
      await screen.findByRole("link", {
        name: "クリーンアップ中に別routeへ移動",
      }),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();

    await act(async () => {
      reviewRequest.reject(deletedGoalError("request-late-initial-review"));
    });

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(screen.getByText("外部route")).toBeInTheDocument();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
  });

  it("accepts 80 non-BMP review code points and explains the atomic rejection of the 81st", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const eightyCodePoints = "😀".repeat(80);

    expect(editor).not.toHaveAttribute("maxlength");
    fireEvent.change(editor, { target: { value: eightyCodePoints } });

    expect(editor).toHaveValue(eightyCodePoints);
    const counter = screen.getByRole("status", {
      name: "次のサイクルで目指す目標は上限80文字中80文字です",
    });
    expect(counter).toHaveTextContent("80 / 80文字");
    expect(counter).toHaveAttribute("aria-live", "off");
    const saveCallsBeforeRejection = vi.mocked(saveReview).mock.calls.length;
    const cacheCallsBeforeRejection =
      vi.mocked(putBrowserDraft).mock.calls.length;

    fireEvent.change(editor, {
      target: { value: `${eightyCodePoints}😀` },
    });

    expect(editor).toHaveValue(eightyCodePoints);
    expect(counter).toHaveTextContent("80 / 80文字");
    const feedback = screen.getByText(
      "入力後は81文字になるため反映できませんでした。上限80文字まで、入力内容をあと1文字減らしてください。",
    );
    expect(feedback).toHaveAttribute("role", "status");
    expectDescribedBy(editor, feedback.id);
    expect(saveReview).toHaveBeenCalledTimes(saveCallsBeforeRejection);
    expect(putBrowserDraft).toHaveBeenCalledTimes(cacheCallsBeforeRejection);

    fireEvent.change(editor, { target: { value: "次の有効な見直し" } });

    expect(editor).toHaveValue("次の有効な見直し");
    expect(feedback).not.toBeInTheDocument();
  });

  it("explains disabled Review actions without blocking terminal actions", async () => {
    const emptyReviewDraft = { ...reviewDraft, body: "\t\n\u3000" };
    vi.mocked(getReview).mockResolvedValue({
      ...review,
      reviewDraft: emptyReviewDraft,
    });

    renderPage();
    await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const refine = screen.getByRole("button", { name: "AIで目標を整える" });
    const continueAction = screen.getByRole("button", {
      name: "この目標で次のサイクルへ",
    });
    const terminate = screen.getByRole("button", { name: "目標を終了" });
    const guidance = screen.getByText(
      "空白以外の文字を含む80文字以内で、次のサイクルの目標を入力してください。",
    );

    expect(refine).toBeDisabled();
    expect(continueAction).toBeDisabled();
    expectDescribedBy(refine, guidance.id);
    expectDescribedBy(continueAction, guidance.id);
    await waitFor(() => expect(terminate).toBeEnabled());
    expect(terminate).toHaveAccessibleDescription(
      /この目標はあとから再開できません/,
    );
  });

  it("groups idle Review outcomes into ordered labelled sections", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const context = screen.getByRole("region", { name: "判断の材料" });
    const currentGoalLabel = screen.getByText("現在の目標 · Goal v1");
    const check = within(context).getByRole("heading", {
      level: 3,
      name: "直前のC — 分かったこと",
    });
    const action = within(context).getByRole("heading", {
      level: 3,
      name: "直前のA — 次に続ける・変えること",
    });
    expect(within(context).getByText(triggerCycle.check)).toBeVisible();
    expect(within(context).getByText(triggerCycle.action)).toBeVisible();
    expect(within(context).getByText("直前のCycleのP/Dも確認")).toBeVisible();
    expect(within(context).getByText(triggerCycle.plan)).toBeVisible();
    expect(within(context).getByText(triggerCycle.do)).toBeVisible();
    const draftComparison = screen.getByText(
      `現在のGoal v${goal.currentVersion.versionNumber}と同じ内容です。`,
    );
    const saveStatus = await screen.findByText("保存済み");
    const refine = screen.getByRole("button", { name: "AIで目標を整える" });
    const nextCycleHeading = screen.getByRole("heading", {
      level: 2,
      name: "次のサイクルへ進む",
    });
    const nextCycleSection = screen.getByRole("region", {
      name: "次のサイクルへ進む",
    });
    const note = within(nextCycleSection).getByText(
      `現在のGoal v${goal.currentVersion.versionNumber}を維持し、新しいGoal Versionは作成せず、Cycle ${goal.nextCycleSequenceNumber}を開始します。`,
    );
    const continueAction = within(nextCycleSection).getByRole("button", {
      name: "この目標で次のサイクルへ",
    });
    const terminalHeading = screen.getByRole("heading", {
      level: 2,
      name: "この目標を終える",
    });
    const terminalSection = screen.getByRole("region", {
      name: "この目標を終える",
    });
    const terminalResult = within(terminalSection).getByText(
      `Review下書きは破棄されます。現在のGoal v${goal.currentVersion.versionNumber}のまま終了し、新しいGoal Versionは作成せず、Cycle ${goal.nextCycleSequenceNumber}も開始しません。 どちらの操作も取り消せず、この目標はあとから再開できません。`,
    );
    const achieve = within(terminalSection).getByRole("button", {
      name: "目標を達成として終了",
    });
    const terminate = within(terminalSection).getByRole("button", {
      name: "目標を終了",
    });

    expectBefore(currentGoalLabel, context);
    expectBefore(context, editor);
    expectBefore(check, action);
    expectBefore(editor, draftComparison);
    expectBefore(editor, saveStatus);
    expectBefore(saveStatus, refine);
    expectBefore(refine, nextCycleHeading);
    expectBefore(nextCycleHeading, note);
    expectBefore(note, continueAction);
    expectBefore(continueAction, terminalHeading);
    expectDescribedBy(editor, draftComparison.id);
    expectDescribedBy(continueAction, note.id);
    expectDescribedBy(achieve, terminalResult.id);
    expectDescribedBy(terminate, terminalResult.id);
    expect(achieve).toHaveAccessibleDescription(
      /目標を達成した状態として記録して、ここで取り組みを終えます/,
    );
    expect(terminate).toHaveAccessibleDescription(
      /目標を達成したとはせず、ここで取り組みを終えます/,
    );
    expect(refine).toBeEnabled();
    expect(continueAction).toBeEnabled();
    expect(achieve).toBeEnabled();
    expect(terminate).toBeEnabled();
    expect(
      within(terminalSection).getByRole("button", { name: "目標を削除" }),
    ).toBeEnabled();
  });

  it("keeps Review refinement separate until the user explicitly adopts it", async () => {
    const preservedSignal = "週3回できる\n夕方に余裕がある";
    const signaledVersion = {
      ...goal.currentVersion,
      successSignal: preservedSignal,
    };
    const signaledDraft = {
      ...reviewDraft,
      successSignal: preservedSignal,
    };
    vi.mocked(getReview).mockResolvedValue({
      ...review,
      goal: { ...goal, currentVersion: signaledVersion },
      reviewDraft: signaledDraft,
      triggerCycle: { ...triggerCycle, goalVersion: signaledVersion },
    });
    vi.mocked(adoptReview).mockResolvedValue({
      reviewDraft: {
        ...signaledDraft,
        body: "整理されたレビュー目標",
        revision: 1,
        updatedAt: "2026-08-20T00:02:00.000Z",
      },
    });
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const signal = screen.getByRole("textbox", {
      name: "良くなったと分かるサイン（任意）",
    });
    expect(signal).toHaveValue(preservedSignal);

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));

    expect(
      await screen.findByText("整理されたレビュー目標"),
    ).toBeInTheDocument();
    expect(editor).toHaveValue(reviewDraft.body);
    expect(adoptReview).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();

    const refine = screen.getByRole("button", { name: "AIで目標を整える" });
    const suggestion = screen.getByRole("heading", { name: "AIからの提案" });
    const adopt = screen.getByRole("button", { name: "提案を採用" });
    const nextCycleHeading = screen.getByRole("heading", {
      level: 2,
      name: "次のサイクルへ進む",
    });
    const note = screen.getByText(
      `現在のGoal v${goal.currentVersion.versionNumber}を維持し、新しいGoal Versionは作成せず、Cycle ${goal.nextCycleSequenceNumber}を開始します。`,
    );
    const continueAction = screen.getByRole("button", {
      name: "この目標で次のサイクルへ",
    });
    const terminal = screen.getByRole("heading", {
      level: 2,
      name: "この目標を終える",
    });

    expectBefore(refine, suggestion);
    expectBefore(suggestion, adopt);
    expectBefore(adopt, nextCycleHeading);
    expectBefore(nextCycleHeading, note);
    expectBefore(note, continueAction);
    expectBefore(continueAction, terminal);

    fireEvent.click(adopt);

    await waitFor(() =>
      expect(adoptReview).toHaveBeenCalledWith(
        sessionLease,
        goal.id,
        "30000000-0000-7000-8000-000000000003",
        reviewDraft.revision,
        goal.revision,
        session.csrfToken,
      ),
    );
    await waitFor(() => expect(editor).toHaveValue("整理されたレビュー目標"));
    expect(signal).toHaveValue(preservedSignal);
  });

  it("clears a prior adoption error when retry succeeds", async () => {
    vi.mocked(adoptReview).mockRejectedValueOnce(new Error("unavailable"));
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
    expect(
      await screen.findByText("整理されたレビュー目標"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "提案を採用できませんでした。現在の下書きを確認してください。",
    );
    expect(editor).toHaveValue(reviewDraft.body);

    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));

    await waitFor(() => expect(adoptReview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(editor).toHaveValue("整理されたレビュー目標"));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("ignores an adoption response bound to a different review draft", async () => {
    vi.mocked(adoptReview).mockResolvedValue({
      reviewDraft: replacementReviewDraft,
    });
    const cache = createCache();
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
    expect(
      await screen.findByText("整理されたレビュー目標"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));
    await waitFor(() => expect(adoptReview).toHaveBeenCalledOnce());
    await act(async () => undefined);

    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(editor);
    expect(editor).toHaveValue(reviewDraft.body);
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(reviewDraft);
    expect(screen.getByText("整理されたレビュー目標")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late Review Refine settlement after identity quiescence: %s",
    async (settlement) => {
      const completion = deferred<Awaited<ReturnType<typeof refineReview>>>();
      vi.mocked(refineReview).mockReturnValue(completion.promise);
      const cache = createCache();
      renderPage(cache, false, true);
      const editor = await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });
      const cachedReview = cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      );

      fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
      await waitFor(() => expect(refineReview).toHaveBeenCalledOnce());
      fireEvent.click(
        screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
      );
      expect(await screen.findByText("切替準備完了")).toBeInTheDocument();

      await act(async () => {
        if (settlement === "resolve") {
          completion.resolve({
            generationId: "30000000-0000-7000-8000-000000000009",
            sourceDraftRevision: reviewDraft.revision,
            sourceGoalRevision: goal.revision,
            suggestion: "切替後に届いたReview提案",
            contextChanged: false,
          });
        } else {
          completion.reject(new Error("late failure"));
        }
      });
      await act(async () => undefined);

      expect(
        screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
      ).toBe(editor);
      expect(editor).toHaveValue(reviewDraft.body);
      expect(
        cache.getQueryData<GoalReview>(
          userQueryKeys.review(session.user.id, goal.id),
        ),
      ).toBe(cachedReview);
      expect(
        screen.queryByText("切替後に届いたReview提案"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
      expect(
        screen.queryByText("現在のワークスペース"),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps the admitted Review read-only when a late adoption outlives its generation", async () => {
    const completion = deferred<Awaited<ReturnType<typeof adoptReview>>>();
    vi.mocked(adoptReview).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache);

    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
    expect(
      await screen.findByText("整理されたレビュー目標"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));
    await waitFor(() => expect(adoptReview).toHaveBeenCalledOnce());

    act(() => {
      cache.setQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
        replacementReview,
      );
    });
    await waitFor(() => expect(editor).toHaveAttribute("readonly"));
    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(editor);
    expect(editor).toHaveValue(reviewDraft.body);
    expect(
      screen.getByRole("link", { name: "現在のGoalを開いてください" }),
    ).toHaveAttribute("href", `/goals/${goal.id}`);

    await act(async () =>
      completion.resolve({
        reviewDraft: {
          ...reviewDraft,
          body: "旧レビュー下書きAへの遅延採用結果",
          revision: 1,
          updatedAt: "2026-08-20T00:10:00.000Z",
        },
      }),
    );
    await act(async () => undefined);

    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(editor);
    expect(editor).toHaveValue(reviewDraft.body);
    expect(editor).toHaveAttribute("readonly");
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(replacementReviewDraft);
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "現在のGoalを開いてください" }),
    ).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late Review adoption after identity quiescence: %s",
    async (settlement) => {
      const completion = deferred<Awaited<ReturnType<typeof adoptReview>>>();
      vi.mocked(adoptReview).mockReturnValue(completion.promise);
      const cache = createCache();
      renderPage(cache, false, true);
      const editor = await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });
      const cachedReview = cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      );

      fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
      expect(
        await screen.findByText("整理されたレビュー目標"),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));
      await waitFor(() => expect(adoptReview).toHaveBeenCalledOnce());
      fireEvent.click(
        screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
      );
      expect(await screen.findByText("切替準備完了")).toBeInTheDocument();

      await act(async () => {
        if (settlement === "resolve") {
          completion.resolve({
            reviewDraft: {
              ...reviewDraft,
              body: "切替後に届いたReview採用結果",
              revision: 1,
              updatedAt: "2026-08-20T00:10:00.000Z",
            },
          });
        } else {
          completion.reject(new Error("late failure"));
        }
      });
      await act(async () => undefined);

      expect(
        screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
      ).toBe(editor);
      expect(editor).toHaveValue(reviewDraft.body);
      expect(
        cache.getQueryData<GoalReview>(
          userQueryKeys.review(session.user.id, goal.id),
        ),
      ).toBe(cachedReview);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
      expect(
        screen.queryByText("現在のワークスペース"),
      ).not.toBeInTheDocument();
    },
  );

  it("normalizes line endings before autosave without trimming whitespace", async () => {
    const normalizedBody = "\t一行目\n二行目\n三行目 \t";
    vi.mocked(saveReview).mockResolvedValue({
      reviewDraft: {
        ...reviewDraft,
        body: normalizedBody,
        revision: reviewDraft.revision + 1,
      },
    });
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    expect(getReview).toHaveBeenCalledWith(
      sessionLease,
      goal.id,
      expect.any(AbortSignal),
    );
    fireEvent.change(editor, {
      target: { value: "\t一行目\r\n二行目\r三行目 \t" },
    });
    fireEvent.blur(editor);

    await waitFor(() =>
      expect(saveReview).toHaveBeenCalledWith(
        sessionLease,
        goal.id,
        reviewDraft.id,
        { body: normalizedBody, successSignal: null },
        reviewDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          body: normalizedBody,
          baseRevision: reviewDraft.revision,
        }),
      ),
    );
  });

  it("treats a success-signal-only edit as the next Goal Version tuple", async () => {
    vi.mocked(saveReview).mockImplementation(
      async (_lease, _goalId, _reviewDraftId, content, expectedRevision) => ({
        reviewDraft: {
          ...reviewDraft,
          ...content,
          revision: expectedRevision + 1,
          updatedAt: "2026-08-20T00:03:00.000Z",
        },
      }),
    );
    renderPage();
    const signal = await screen.findByRole("textbox", {
      name: "良くなったと分かるサイン（任意）",
    });

    fireEvent.change(signal, { target: { value: "週3回\r\nできる" } });
    fireEvent.blur(signal);

    await waitFor(() =>
      expect(saveReview).toHaveBeenCalledWith(
        sessionLease,
        goal.id,
        reviewDraft.id,
        { body: reviewDraft.body, successSignal: "週3回\nできる" },
        reviewDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    const comparison = screen.getByText(
      "変更案です。次のサイクルへ進む場合だけGoal v2として保存します。",
    );
    expect(comparison).toBeVisible();
    expect(signal.getAttribute("aria-describedby")).toContain(comparison.id);
  });

  it("keeps autosave revision 2 when a captured revision 1 GET resolves late", async () => {
    const revisionOneDraft: GoalDraft = {
      ...reviewDraft,
      body: "保存済みReview revision 1",
      revision: 1,
      updatedAt: "2026-08-20T00:02:00.000Z",
    };
    const revisionOneReview: GoalReview = {
      ...review,
      reviewDraft: revisionOneDraft,
    };
    const revisionTwoDraft: GoalDraft = {
      ...revisionOneDraft,
      body: "保存済みReview revision 2",
      revision: 2,
      updatedAt: "2026-08-20T00:03:00.000Z",
    };
    const revisionThreeDraft: GoalDraft = {
      ...revisionTwoDraft,
      body: "保存済みReview revision 3",
      revision: 3,
      updatedAt: "2026-08-20T00:04:00.000Z",
    };
    const revisionTwoReview: GoalReview = {
      ...revisionOneReview,
      reviewDraft: revisionTwoDraft,
    };
    const lateGet = deferred<Awaited<ReturnType<typeof getReview>>>();
    vi.mocked(getReview)
      .mockResolvedValueOnce(revisionOneReview)
      .mockReturnValueOnce(lateGet.promise)
      .mockResolvedValueOnce(revisionTwoReview);
    vi.mocked(saveReview)
      .mockResolvedValueOnce({ reviewDraft: revisionTwoDraft })
      .mockResolvedValueOnce({ reviewDraft: revisionThreeDraft });
    const cache = createCache();
    const reviewKey = userQueryKeys.review(session.user.id, goal.id);
    const firstMount = renderPage(cache);
    const firstEditor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    expect(firstEditor).toHaveValue(revisionOneDraft.body);
    const transportKey = activeReviewTransportKey(cache);

    let refetch!: Promise<void>;
    act(() => {
      refetch = cache.refetchQueries({ queryKey: transportKey, exact: true });
    });
    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));
    expect(cache.getQueryState(transportKey)?.fetchStatus).toBe("fetching");

    fireEvent.change(firstEditor, { target: { value: revisionTwoDraft.body } });
    fireEvent.blur(firstEditor);
    await waitFor(() =>
      expect(saveReview).toHaveBeenCalledWith(
        sessionLease,
        goal.id,
        revisionOneDraft.id,
        { body: revisionTwoDraft.body, successSignal: null },
        revisionOneDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(cache.getQueryData<GoalReview>(reviewKey)?.reviewDraft).toEqual(
        revisionTwoDraft,
      ),
    );
    const cachedRevisionTwo = cache.getQueryData<GoalReview>(reviewKey);

    await act(async () => {
      lateGet.resolve(revisionOneReview);
      await refetch;
    });

    expect(cache.getQueryData<GoalReview>(reviewKey)).toBe(cachedRevisionTwo);
    expect(cachedRevisionTwo?.reviewDraft).toEqual(revisionTwoDraft);

    firstMount.unmount();
    renderPage(cache);
    const remountedEditor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    expect(remountedEditor).toHaveValue(revisionTwoDraft.body);
    expect(getReview).toHaveBeenCalledTimes(3);

    fireEvent.change(remountedEditor, {
      target: { value: revisionThreeDraft.body },
    });
    fireEvent.blur(remountedEditor);

    await waitFor(() =>
      expect(saveReview).toHaveBeenLastCalledWith(
        sessionLease,
        goal.id,
        revisionTwoDraft.id,
        { body: revisionThreeDraft.body, successSignal: null },
        revisionTwoDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
  });

  it("treats CRLF and lone CR as LF before exact review comparison", async () => {
    const currentBody = "一行目\n二行目";
    vi.mocked(getReview).mockResolvedValue({
      ...review,
      goal: {
        ...goal,
        currentVersion: { ...goal.currentVersion, body: currentBody },
      },
      reviewDraft: { ...reviewDraft, body: "一行目\r二行目" },
    });

    renderPage();

    expect(
      await screen.findByText(
        `現在のGoal v${goal.currentVersion.versionNumber}を維持し、新しいGoal Versionは作成せず、Cycle ${goal.nextCycleSequenceNumber}を開始します。`,
      ),
    ).toBeInTheDocument();
  });

  it("treats trailing whitespace as an actual review change", async () => {
    vi.mocked(getReview).mockResolvedValue({
      ...review,
      reviewDraft: {
        ...reviewDraft,
        body: `${goal.currentVersion.body} `,
      },
    });

    renderPage();

    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const draftComparison = screen.getByText(
      `変更案です。次のサイクルへ進む場合だけGoal v${goal.currentVersion.versionNumber + 1}として保存します。`,
    );
    expectDescribedBy(editor, draftComparison.id);
    expect(
      screen.getByText(
        `変更案をGoal v${goal.currentVersion.versionNumber + 1}として保存し、Cycle ${goal.nextCycleSequenceNumber}を開始します。`,
      ),
    ).toBeInTheDocument();
  });

  it("keeps terminal actions disabled until browser draft hydration finishes", async () => {
    const browserRead = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    vi.mocked(getBrowserDraft).mockReturnValueOnce(browserRead.promise);

    renderPage();
    await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const terminate = screen.getByRole("button", { name: "目標を終了" });
    const remove = screen.getByRole("button", { name: "目標を削除" });
    expect(terminate).toBeDisabled();
    expect(remove).toBeDisabled();
    const guidance = screen.getByText(
      "この端末に残る入力を確認しています。完了するまでお待ちください。",
    );
    expectDescribedBy(terminate, guidance.id);
    expectDescribedBy(remove, guidance.id);

    await act(async () => browserRead.resolve(null));
    expect(terminate).toBeEnabled();
    expect(remove).toBeEnabled();
    expectNotDescribedBy(terminate, guidance.id);
    expectNotDescribedBy(remove, guidance.id);
    expect(terminate).toHaveAccessibleDescription(/達成したとはせず/);
    expect(remove).toHaveAccessibleDescription(/すべてのCycle履歴/);
    expect(guidance).not.toBeInTheDocument();
  });

  it("requires explicit Review Draft discard confirmation before terminating an unchanged review", async () => {
    renderPage();
    await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const terminate = screen.getByRole("button", { name: "目標を終了" });
    await waitFor(() => expect(terminate).toBeEnabled());

    fireEvent.click(terminate);

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionは作成しません。",
      ),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Goal v2として保存されません");
    expect(
      within(dialog).getByText(
        `現在のGoal v${goal.currentVersion.versionNumber}のまま終了し、Cycle ${goal.nextCycleSequenceNumber}は開始されません。`,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "目標を達成したとはせず、ここで取り組みを終えます。",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "どちらの操作も取り消せず、この目標はあとから再開できません。",
      ),
    ).toBeInTheDocument();
    expect(terminateGoal).not.toHaveBeenCalled();
  });

  it("requires discard confirmation before terminating a dirty review", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editor, { target: { value: "明確に変更した目標" } });

    expect(screen.getByText("未保存")).toBeInTheDocument();
    expect(
      screen.getByText(
        `変更中の目標案は破棄し、Goal v${goal.currentVersion.versionNumber + 1}は作成しません。現在のGoal v${goal.currentVersion.versionNumber}のまま終了し、Cycle ${goal.nextCycleSequenceNumber}も開始しません。 どちらの操作も取り消せず、この目標はあとから再開できません。`,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "目標を終了" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "このReview下書きは、別のタブで保存された変更も含めて破棄され、Goal v2として保存されません。",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `現在のGoal v${goal.currentVersion.versionNumber}のまま終了し、Cycle ${goal.nextCycleSequenceNumber}は開始されません。`,
      ),
    ).toBeInTheDocument();
    expect(terminateGoal).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "目標を終了" }));

    await waitFor(() =>
      expect(terminateGoal).toHaveBeenCalledWith(
        sessionLease,
        goal.id,
        "ended",
        goal.revision,
        "goal_review",
        {
          operationId: expect.any(String),
          csrfToken: session.csrfToken,
        },
      ),
    );
  });
});
