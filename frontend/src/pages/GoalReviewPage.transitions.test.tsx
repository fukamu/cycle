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
import type { Goal, GoalDraft, GoalReview } from "../shared/api/schemas";
import { firstUseGuideCopy } from "../shared/copy/ja";
import {
  continueReview,
  deleteGoal,
  getGoal,
  getReview,
  saveReview,
  terminateGoal,
} from "../shared/api/workspace";
import {
  type BrowserDraft,
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import {
  activeGoalAfterReview,
  activeReviewTransportKey,
  continuedGoal,
  createCache,
  deferred,
  expectDescribedBy,
  expectNotDescribedBy,
  goal,
  goalDeletionAdvisoryHarness,
  invokeReviewTerminalCommand,
  newerReview,
  newerReviewDraft,
  newerReviewGoal,
  registerGoalReviewPageTestLifecycle,
  renderPage,
  replacementGoal,
  replacementReview,
  replacementReviewDraft,
  replayedCycle,
  review,
  reviewDraft,
  session,
  sessionLease,
  terminalGoalAfterReview,
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

describe("GoalReviewPage: transitions and conflicts", () => {
  registerGoalReviewPageTestLifecycle();

  it("retries an ambiguous Continue response with the same operation and resolves the canonical workspace", async () => {
    vi.mocked(continueReview)
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({
        goal: continuedGoal,
        versionCreated: false,
        cycle: replayedCycle,
        replayed: true,
      });
    renderPage();
    const continueButton = await screen.findByRole("button", {
      name: "この目標で次のサイクルへ",
    });

    fireEvent.click(continueButton);

    expect(
      await screen.findByText(
        "次のサイクルを開始できませんでした。保存状態を確認してください。",
      ),
    ).toBeInTheDocument();

    fireEvent.click(continueButton);

    expect(await screen.findByText("現在のワークスペース")).toBeInTheDocument();
    expect(continueReview).toHaveBeenCalledTimes(2);
    const firstOptions = vi.mocked(continueReview).mock.calls[0]?.[4];
    const secondOptions = vi.mocked(continueReview).mock.calls[1]?.[4];
    expect(firstOptions).toEqual({
      operationId: expect.any(String),
      csrfToken: session.csrfToken,
    });
    expect(secondOptions?.operationId).toBe(firstOptions?.operationId);
    expect(continueReview).toHaveBeenLastCalledWith(
      sessionLease,
      goal.id,
      goal.revision,
      reviewDraft.revision,
      secondOptions,
    );
  });

  it("rejects input while Continue is pending and restores editing after failure", async () => {
    const request = deferred<Awaited<ReturnType<typeof continueReview>>>();
    vi.mocked(continueReview).mockImplementationOnce(() => request.promise);
    const user = userEvent.setup();
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    await user.click(
      screen.getByRole("button", { name: "この目標で次のサイクルへ" }),
    );
    await waitFor(() => expect(continueReview).toHaveBeenCalledOnce());

    const commandGuidance = screen.getByText(
      "目標の操作を処理しています。完了するまでお待ちください。",
    );
    expect(screen.getAllByText(commandGuidance.textContent ?? "")).toHaveLength(
      1,
    );
    for (const actionName of [
      "AIで目標を整える",
      "この目標で次のサイクルへ",
      "目標を達成として終了",
      "目標を終了",
      "目標を削除",
    ]) {
      expectDescribedBy(
        screen.getByRole("button", { name: actionName }),
        commandGuidance.id,
      );
    }

    expect(editor).toHaveAttribute("readonly");
    await user.type(editor, "command中の追記");
    expect(editor).toHaveValue(reviewDraft.body);

    await act(async () => request.reject(new TypeError("network")));

    expect(
      await screen.findByText(
        "次のサイクルを開始できませんでした。保存状態を確認してください。",
      ),
    ).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");
    expect(editor).toHaveValue(reviewDraft.body);

    await user.type(editor, "失敗後の追記");
    expect(editor).toHaveValue(reviewDraft.body + "失敗後の追記");
  });

  it("preserves a local review on the exact revision conflict and adopts the latest server draft only by choice", async () => {
    const localBody = "この端末で見直した目標";
    const nextBody = "競合解消後の見直し";
    const latestDraft: GoalDraft = {
      ...reviewDraft,
      body: "別の端末で見直された目標",
      revision: 1,
      updatedAt: "2026-08-20T00:03:00.000Z",
    };
    vi.mocked(getReview)
      .mockResolvedValueOnce(review)
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ ...review, reviewDraft: latestDraft });
    vi.mocked(saveReview)
      .mockRejectedValueOnce(
        new APIError(
          409,
          "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
          "conflict",
          "request-2",
        ),
      )
      .mockResolvedValueOnce({
        reviewDraft: { ...latestDraft, body: nextBody, revision: 2 },
      });

    renderPage(createCache(), false, false, false, false, true);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "はじめてガイドを再表示",
      }),
    );
    expect(
      await screen.findByRole("complementary", {
        name: firstUseGuideCopy.heading,
      }),
    ).toBeInTheDocument();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    const retry = await screen.findByRole("button", { name: "再試行" });
    expect(
      screen.queryByRole("complementary", {
        name: firstUseGuideCopy.heading,
      }),
    ).not.toBeInTheDocument();
    expect(editor).toHaveAttribute("readonly");

    fireEvent.click(retry);
    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    const recoveryNotice = screen
      .getByText("別の更新が見つかりました")
      .closest<HTMLElement>('[role="alert"]');
    expect(recoveryNotice).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "AIで目標を整える" }),
    ).toHaveAttribute("aria-describedby", recoveryNotice?.id);
    expectDescribedBy(
      screen.getByRole("button", { name: "この目標で次のサイクルへ" }),
      recoveryNotice?.id ?? "",
    );
    expect(screen.getByRole("button", { name: "目標を終了" })).toBeEnabled();
    expectNotDescribedBy(
      screen.getByRole("button", { name: "目標を終了" }),
      recoveryNotice?.id ?? "",
    );
    expect(
      screen.queryByText(
        "入力を保存できていません。「再試行」で保存してから操作してください。",
      ),
    ).not.toBeInTheDocument();
    expect(editor).toHaveValue(localBody);
    expect(getReview).toHaveBeenCalledTimes(3);
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: localBody,
        baseRevision: reviewDraft.revision,
      }),
    );
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("complementary", {
        name: firstUseGuideCopy.heading,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "サーバーの内容を使用" }),
    );
    await waitFor(() => expect(editor).toHaveValue(latestDraft.body));
    expect(saveReview).toHaveBeenCalledOnce();
    expect(screen.getByText("保存済み")).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");
    expect(
      await screen.findByRole("complementary", {
        name: firstUseGuideCopy.heading,
      }),
    ).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: nextBody } });
    fireEvent.blur(editor);

    await waitFor(() =>
      expect(saveReview).toHaveBeenLastCalledWith(
        sessionLease,
        goal.id,
        reviewDraft.id,
        { body: nextBody, successSignal: null },
        latestDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
  });

  it("latches a dirty Review when its cached draft identity changes", async () => {
    let resolveReviewA!: (value: { reviewDraft: GoalDraft }) => void;
    const reviewASave = new Promise<{ reviewDraft: GoalDraft }>((resolve) => {
      resolveReviewA = resolve;
    });
    const browserDrafts = new Map<string, BrowserDraft>();
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
    const reviewABody = "レビューAの未完了入力";
    vi.mocked(saveReview).mockImplementationOnce(() => reviewASave);
    const cache = createCache();
    renderPage(cache);
    const editorA = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editorA, { target: { value: reviewABody } });
    fireEvent.blur(editorA);
    await waitFor(() =>
      expect(saveReview).toHaveBeenCalledWith(
        sessionLease,
        goal.id,
        reviewDraft.id,
        { body: reviewABody, successSignal: null },
        reviewDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect(putBrowserDraft).toHaveBeenCalled());

    act(() => {
      cache.setQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
        replacementReview,
      );
    });
    await waitFor(() => expect(editorA).toHaveAttribute("readonly"));
    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(editorA);
    expect(editorA).toHaveValue(reviewABody);
    expect(getBrowserDraft).toHaveBeenCalledWith(
      session.user.id,
      `goal-review:${goal.id}:${reviewDraft.id}`,
    );
    expect(getBrowserDraft).not.toHaveBeenCalledWith(
      session.user.id,
      `goal-review:${goal.id}:${replacementReviewDraft.id}`,
    );

    await act(async () => {
      resolveReviewA({
        reviewDraft: { ...reviewDraft, body: reviewABody, revision: 1 },
      });
    });

    expect(editorA).toHaveValue(reviewABody);
    expect(editorA).toHaveAttribute("readonly");
    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(editorA);
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(replacementReviewDraft);

    expect(saveReview).toHaveBeenCalledOnce();
    expect(
      browserDrafts.get(`goal-review:${goal.id}:${reviewDraft.id}`),
    ).toEqual(expect.objectContaining({ body: reviewABody }));
  });

  it("lets a matching deletion advisory clear a preserved latched Review", async () => {
    const lateReviewASave = deferred<Awaited<ReturnType<typeof saveReview>>>();
    const cleanup = deferred<void>();
    const browserDrafts = new Map<string, BrowserDraft>();
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
    vi.mocked(saveReview).mockReturnValueOnce(lateReviewASave.promise);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockImplementationOnce(
      async () => cleanup.promise,
    );
    const reviewSubjectKey = `goal-review:${goal.id}:${reviewDraft.id}`;
    const reviewABody = "削除通知で破棄するReview Aの端末入力";
    const cache = createCache();
    renderPage(cache);
    const editorA = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editorA, { target: { value: reviewABody } });
    fireEvent.blur(editorA);
    await waitFor(() => expect(saveReview).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(browserDrafts.get(reviewSubjectKey)).toEqual(
        expect.objectContaining({ body: reviewABody }),
      ),
    );
    act(() => {
      cache.setQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
        replacementReview,
      );
    });
    await waitFor(() => expect(editorA).toHaveAttribute("readonly"));
    vi.mocked(putBrowserDraft).mockClear();
    vi.mocked(deleteBrowserDraft).mockClear();

    act(() => {
      goalDeletionAdvisoryHarness.dispatch(session.user.id, goal.id);
    });

    await waitFor(() =>
      expect(deleteBrowserDraft).toHaveBeenCalledWith(
        session.user.id,
        reviewSubjectKey,
      ),
    );
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(browserDrafts.has(reviewSubjectKey)).toBe(false);
    expect(goalDeletionAdvisoryHarness.publish).not.toHaveBeenCalled();

    await act(async () =>
      lateReviewASave.resolve({
        reviewDraft: {
          ...reviewDraft,
          body: reviewABody,
          revision: reviewDraft.revision + 1,
        },
      }),
    );
    expect(saveReview).toHaveBeenCalledOnce();
    expect(putBrowserDraft).not.toHaveBeenCalled();
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(replacementReviewDraft);

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toBeUndefined();
  });

  it("does not let a late Review A response mutate a published Review B editor or live cache", async () => {
    const lateReviewA = deferred<GoalReview>();
    const reviewBPublication = deferred<GoalReview>();
    vi.mocked(getReview)
      .mockResolvedValueOnce(review)
      .mockReturnValueOnce(lateReviewA.promise)
      .mockReturnValueOnce(reviewBPublication.promise);
    const cache = createCache();
    const firstMount = renderPage(cache);
    const editorA = await within(firstMount.container).findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const reviewATransportKey = activeReviewTransportKey(cache);

    let lateRefetch!: Promise<void>;
    act(() => {
      lateRefetch = cache.refetchQueries({
        queryKey: reviewATransportKey,
        exact: true,
      });
    });
    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));

    const secondMount = renderPage(cache);
    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(3));
    await act(async () => reviewBPublication.resolve(newerReview));
    const editorB = await within(secondMount.container).findByDisplayValue(
      newerReviewDraft.body,
    );
    expect(editorB).toHaveValue(newerReviewDraft.body);
    await waitFor(() => expect(editorA).toHaveAttribute("readonly"));

    const reviewKey = userQueryKeys.review(session.user.id, goal.id);
    const goalKey = userQueryKeys.goal(session.user.id, goal.id);
    const cachedReviewB = cache.getQueryData<GoalReview>(reviewKey);
    const cachedGoalB = cache.getQueryData<{ goal: Goal }>(goalKey);
    const reviewStateBeforeLateA = cache.getQueryState(reviewKey);
    const goalStateBeforeLateA = cache.getQueryState(goalKey);
    expect(cachedReviewB).toEqual(newerReview);
    expect(cachedGoalB?.goal).toEqual(newerReviewGoal);

    await act(async () => {
      lateReviewA.resolve({
        ...review,
        reviewDraft: {
          ...reviewDraft,
          body: "遅れて届いたReview A",
          revision: 99,
          updatedAt: "2026-08-20T00:20:00.000Z",
        },
      });
      await lateRefetch;
    });

    expect(
      within(secondMount.container).getByDisplayValue(newerReviewDraft.body),
    ).toBe(editorB);
    expect(editorB).toHaveValue(newerReviewDraft.body);
    expect(cache.getQueryData(reviewKey)).toBe(cachedReviewB);
    expect(cache.getQueryData(goalKey)).toBe(cachedGoalB);
    expect(cache.getQueryState(reviewKey)?.dataUpdatedAt).toBe(
      reviewStateBeforeLateA?.dataUpdatedAt,
    );
    expect(cache.getQueryState(reviewKey)?.dataUpdateCount).toBe(
      reviewStateBeforeLateA?.dataUpdateCount,
    );
    expect(cache.getQueryState(goalKey)?.dataUpdatedAt).toBe(
      goalStateBeforeLateA?.dataUpdatedAt,
    );
    expect(cache.getQueryState(goalKey)?.dataUpdateCount).toBe(
      goalStateBeforeLateA?.dataUpdateCount,
    );
  });

  it.each([
    ["active_cycle", activeGoalAfterReview],
    ["terminal", terminalGoalAfterReview],
  ] as const)(
    "keeps a dirty mounted Review A copyable after the canonical Goal becomes %s",
    async (_state, canonicalGoal) => {
      const lateReviewA = deferred<GoalReview>();
      vi.mocked(getReview)
        .mockResolvedValueOnce(review)
        .mockReturnValueOnce(lateReviewA.promise);
      const cache = createCache();
      renderPage(cache);
      const editor = await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });
      const localBody = `canonical ${canonicalGoal.status} 後もコピーする入力`;
      fireEvent.change(editor, { target: { value: localBody } });
      const transportKey = activeReviewTransportKey(cache);

      let lateRefetch!: Promise<void>;
      act(() => {
        lateRefetch = cache.refetchQueries({
          queryKey: transportKey,
          exact: true,
        });
      });
      await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));

      const reviewKey = userQueryKeys.review(session.user.id, goal.id);
      const goalKey = userQueryKeys.goal(session.user.id, goal.id);
      act(() => {
        cache.setQueryData(goalKey, { goal: canonicalGoal });
      });
      await waitFor(() => expect(editor).toHaveAttribute("readonly"));
      expect(editor).not.toBeDisabled();
      expect(editor).toHaveValue(localBody);
      expect(
        screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
      ).toBe(editor);
      expect(
        screen.getByRole("link", { name: "現在のGoalを開いてください" }),
      ).toHaveAttribute("href", `/goals/${goal.id}`);
      await waitFor(() =>
        expect(putBrowserDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            subjectKey: `goal-review:${goal.id}:${reviewDraft.id}`,
            body: localBody,
          }),
        ),
      );
      const cachedReview = cache.getQueryData(reviewKey);
      const cachedCanonicalGoal = cache.getQueryData(goalKey);

      await act(async () => {
        lateReviewA.resolve({
          ...review,
          reviewDraft: {
            ...reviewDraft,
            body: "canonical Goalより遅いReview A",
            revision: reviewDraft.revision + 1,
          },
        });
        await lateRefetch;
      });

      expect(
        screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
      ).toBe(editor);
      expect(editor).toHaveValue(localBody);
      expect(editor).toHaveAttribute("readonly");
      expect(cache.getQueryData(reviewKey)).toBe(cachedReview);
      expect(cache.getQueryData(goalKey)).toBe(cachedCanonicalGoal);
      expect(deleteBrowserDraft).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["active_cycle", activeGoalAfterReview],
    ["terminal", terminalGoalAfterReview],
  ] as const)(
    "never mounts the old Review textbox after a route round trip to a %s Goal",
    async (_state, canonicalGoal) => {
      const staleReviewOnReturn = deferred<GoalReview>();
      vi.mocked(getReview)
        .mockResolvedValueOnce(review)
        .mockReturnValueOnce(staleReviewOnReturn.promise);
      vi.mocked(getGoal).mockResolvedValue({ goal: canonicalGoal });
      const cache = createCache();
      renderPage(cache, false, false, false, true);
      const editor = await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });
      const localBody = `route往復前の${canonicalGoal.status}入力`;
      fireEvent.change(editor, { target: { value: localBody } });

      act(() => {
        cache.setQueryData(userQueryKeys.goal(session.user.id, goal.id), {
          goal: canonicalGoal,
        });
      });
      const currentGoalLink = await screen.findByRole("link", {
        name: "現在のGoalを開いてください",
      });
      await waitFor(() => expect(editor).toHaveAttribute("readonly"));
      await waitFor(() =>
        expect(putBrowserDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            subjectKey: `goal-review:${goal.id}:${reviewDraft.id}`,
            body: localBody,
          }),
        ),
      );

      fireEvent.click(currentGoalLink);
      expect(await screen.findByText("現在のGoal route")).toBeInTheDocument();
      expect(editor).not.toBeInTheDocument();
      const browserDraftReads = vi.mocked(getBrowserDraft).mock.calls.length;
      const mountedReviewTextareas: Element[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches("textarea#review-goal"))
              mountedReviewTextareas.push(node);
            mountedReviewTextareas.push(
              ...node.querySelectorAll("textarea#review-goal"),
            );
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      fireEvent.click(screen.getByRole("link", { name: "Reviewへ戻る" }));
      await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      await act(async () => staleReviewOnReturn.resolve(review));
      expect(
        await screen.findByRole("link", {
          name: "現在のGoalを開いてください",
        }),
      ).toHaveAttribute("href", `/goals/${goal.id}`);
      observer.disconnect();

      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(mountedReviewTextareas).toHaveLength(0);
      expect(getBrowserDraft).toHaveBeenCalledTimes(browserDraftReads);
      expect(deleteBrowserDraft).not.toHaveBeenCalled();
    },
  );

  it("fails closed when an equal Goal revision arrives with a different Review Draft ID", async () => {
    const conflictingPublication = deferred<GoalReview>();
    const equalRevisionDifferentDraft: GoalReview = {
      ...replacementReview,
      goal: { ...replacementGoal, revision: goal.revision },
    };
    vi.mocked(getReview)
      .mockResolvedValueOnce(review)
      .mockReturnValueOnce(conflictingPublication.promise);
    const cache = createCache();
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const localBody = "同じGoal revisionで保持するReview A";
    fireEvent.change(editor, { target: { value: localBody } });
    const transportKey = activeReviewTransportKey(cache);
    const reviewKey = userQueryKeys.review(session.user.id, goal.id);
    const goalKey = userQueryKeys.goal(session.user.id, goal.id);
    const cachedReview = cache.getQueryData(reviewKey);
    const cachedGoal = cache.getQueryData(goalKey);
    const reviewState = cache.getQueryState(reviewKey);
    const goalState = cache.getQueryState(goalKey);

    let refetch!: Promise<void>;
    act(() => {
      refetch = cache.refetchQueries({ queryKey: transportKey, exact: true });
    });
    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));
    await act(async () => {
      conflictingPublication.resolve(equalRevisionDifferentDraft);
      await refetch;
    });

    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(editor);
    expect(editor).toHaveValue(localBody);
    await waitFor(() => expect(editor).toHaveAttribute("readonly"));
    expect(
      screen.getByRole("link", { name: "現在のGoalを開いてください" }),
    ).toHaveAttribute("href", `/goals/${goal.id}`);
    expect(cache.getQueryData(reviewKey)).toBe(cachedReview);
    expect(cache.getQueryData(goalKey)).toBe(cachedGoal);
    expect(cache.getQueryState(reviewKey)?.dataUpdatedAt).toBe(
      reviewState?.dataUpdatedAt,
    );
    expect(cache.getQueryState(reviewKey)?.dataUpdateCount).toBe(
      reviewState?.dataUpdateCount,
    );
    expect(cache.getQueryState(goalKey)?.dataUpdatedAt).toBe(
      goalState?.dataUpdatedAt,
    );
    expect(cache.getQueryState(goalKey)?.dataUpdateCount).toBe(
      goalState?.dataUpdateCount,
    );
  });

  it("accepts a newer coherent Review generation even when its Draft revision resets to zero", async () => {
    const reviewBPublication = deferred<GoalReview>();
    const highDraftRevisionReviewA: GoalReview = {
      ...review,
      reviewDraft: { ...reviewDraft, revision: 99 },
    };
    vi.mocked(getReview).mockReturnValueOnce(reviewBPublication.promise);
    const cache = createCache();
    cache.setQueryData(userQueryKeys.goal(session.user.id, goal.id), {
      goal: highDraftRevisionReviewA.goal,
    });
    cache.setQueryData(
      userQueryKeys.review(session.user.id, goal.id),
      highDraftRevisionReviewA,
    );
    renderPage(cache);
    await waitFor(() => expect(getReview).toHaveBeenCalledOnce());
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await act(async () => reviewBPublication.resolve(newerReview));

    const editorB = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    expect(editorB).toHaveValue(newerReviewDraft.body);
    expect(editorB).not.toHaveAttribute("readonly");
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      ),
    ).toEqual(newerReview);
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft.revision,
    ).toBe(0);
  });

  it("preserves the local review when the server reports the exact inactive-workspace error", async () => {
    const localBody = "終了したReviewでコピーする入力";
    vi.mocked(getReview)
      .mockResolvedValueOnce(review)
      .mockRejectedValueOnce(
        new APIError(
          409,
          "GOAL_REVIEW_NOT_ACTIVE",
          "review ended",
          "request-review-moved",
        ),
      );
    vi.mocked(saveReview).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
        "conflict",
        "request-review-conflict",
      ),
    );

    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    const resolver = await screen.findByRole("link", {
      name: "現在のGoalを開いてください",
    });
    const movedNotice = resolver.closest<HTMLElement>('[role="alert"]');
    expect(resolver).toHaveAttribute("href", "/goals/" + goal.id);
    expect(resolver).toHaveClass("touch-target", "touch-target--inline");
    expect(movedNotice).not.toBeNull();
    for (const actionName of [
      "AIで目標を整える",
      "この目標で次のサイクルへ",
      "目標を達成として終了",
      "目標を終了",
      "目標を削除",
    ]) {
      expectDescribedBy(
        screen.getByRole("button", { name: actionName }),
        movedNotice?.id ?? "",
      );
    }
    expect(
      screen.queryByText(
        "入力を保存できていません。「再試行」で保存してから操作してください。",
      ),
    ).not.toBeInTheDocument();
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "再試行" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "目標を終了" })).toBeDisabled();
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({ body: localBody }),
      ),
    );
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
  });

  it("moves directly on the exact inactive-review PATCH error without refetching the stale review", async () => {
    const localBody = "直接終了を検知したReview入力";
    vi.mocked(saveReview).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_NOT_ACTIVE",
        "review ended",
        "request-direct-review-moved",
      ),
    );

    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    expect(
      await screen.findByRole("link", {
        name: "現在のGoalを開いてください",
      }),
    ).toHaveAttribute("href", "/goals/" + goal.id);
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    expect(getReview).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "再試行" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "目標を終了" })).toBeDisabled();
  });

  it("ignores a Continue completion after the admitted Review generation moves", async () => {
    const completion = deferred<Awaited<ReturnType<typeof continueReview>>>();
    vi.mocked(continueReview).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache);

    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "この目標で次のサイクルへ",
      }),
    );
    await waitFor(() => expect(continueReview).toHaveBeenCalledOnce());

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
    vi.mocked(deleteBrowserDraft).mockClear();

    await act(async () =>
      completion.resolve({
        goal: continuedGoal,
        versionCreated: false,
        cycle: replayedCycle,
        replayed: true,
      }),
    );
    await act(async () => undefined);

    expect(editor).toHaveValue(reviewDraft.body);
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(editor);
    expect(
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toEqual(replacementReview);
    expect(
      screen.getByRole("link", { name: "現在のGoalを開いてください" }),
    ).toBeInTheDocument();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
  });

  it("ignores a Continue completion after identity quiescence begins and before remount", async () => {
    const completion = deferred<Awaited<ReturnType<typeof continueReview>>>();
    vi.mocked(continueReview).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache, false, true);

    const continueButton = await screen.findByRole("button", {
      name: "この目標で次のサイクルへ",
    });
    const cachedGoal = cache.getQueryData(
      userQueryKeys.goal(session.user.id, goal.id),
    );
    fireEvent.click(continueButton);
    await waitFor(() => expect(continueReview).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
    );
    expect(await screen.findByText("切替準備完了")).toBeInTheDocument();
    vi.mocked(deleteBrowserDraft).mockClear();

    await act(async () =>
      completion.resolve({
        goal: continuedGoal,
        versionCreated: false,
        cycle: replayedCycle,
        replayed: true,
      }),
    );
    await act(async () => undefined);

    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toHaveValue(reviewDraft.body);
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
    ).toBe(cachedGoal);
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
  });

  it("ignores a terminal completion after identity quiescence begins and before remount", async () => {
    const completion = deferred<Awaited<ReturnType<typeof terminateGoal>>>();
    vi.mocked(terminateGoal).mockReturnValue(completion.promise);
    renderPage(createCache(), false, true);

    await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.click(screen.getByRole("button", { name: "目標を終了" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "目標を終了",
      }),
    );
    await waitFor(() => expect(terminateGoal).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
    );
    expect(await screen.findByText("切替準備完了")).toBeInTheDocument();
    vi.mocked(deleteBrowserDraft).mockClear();
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockClear();

    await act(async () =>
      completion.resolve({
        goal: {
          ...goal,
          status: "ended",
          revision: goal.revision + 1,
          currentWork: null,
          terminalAt: "2026-08-20T00:02:00.000Z",
        },
        canceledCycle: null,
      }),
    );
    await act(async () => undefined);

    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toHaveValue(reviewDraft.body);
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
  });

  it("retries only browser cleanup after Continue succeeds", async () => {
    vi.mocked(deleteBrowserDraft)
      .mockRejectedValueOnce(new Error("indexeddb unavailable"))
      .mockResolvedValueOnce(undefined);

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "この目標で次のサイクルへ",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "次のサイクルは開始されましたが、このブラウザのReview下書きを削除できませんでした。",
    );
    expect(continueReview).toHaveBeenCalledOnce();
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "ブラウザデータの削除を再試行" }),
    );

    expect(await screen.findByText("現在のワークスペース")).toBeInTheDocument();
    expect(continueReview).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).toHaveBeenCalledTimes(2);
  });

  it("does not publish Continue cleanup success into a replacement route generation", async () => {
    const cleanupGate = deferred<void>();
    vi.mocked(deleteBrowserDraft)
      .mockImplementationOnce(async () => cleanupGate.promise)
      .mockResolvedValue(undefined);
    const cache = createCache();
    const invalidateQueries = vi.spyOn(cache, "invalidateQueries");
    renderPage(cache, false, false, true);

    const continueButton = await screen.findByRole("button", {
      name: "この目標で次のサイクルへ",
    });
    const cachedGoal = cache.getQueryData(
      userQueryKeys.goal(session.user.id, goal.id),
    );
    fireEvent.click(continueButton);
    await waitFor(() => expect(continueReview).toHaveBeenCalledOnce());
    await waitFor(() => expect(deleteBrowserDraft).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("ブラウザに残るReview下書きを削除しています…"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("link", { name: "クリーンアップ中に別routeへ移動" }),
    );
    await act(async () => cleanupGate.resolve());

    expect(await screen.findByText("外部route")).toBeInTheDocument();
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: userQueryKeys.root(session.user.id),
      refetchType: "none",
    });
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
    ).toBe(cachedGoal);
    expect(
      cache.getQueryData(
        userQueryKeys.cycle(session.user.id, goal.id, replayedCycle.id),
      ),
    ).toBeUndefined();
    expect(continueReview).toHaveBeenCalledOnce();
  });

  it("retries only browser cleanup after dirty Review terminal success", async () => {
    vi.mocked(deleteBrowserDraft)
      .mockRejectedValueOnce(new Error("indexeddb unavailable"))
      .mockResolvedValueOnce(undefined);

    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(editor, { target: { value: "破棄する端末変更" } });
    fireEvent.click(screen.getByRole("button", { name: "目標を終了" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "目標を終了" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "目標は終了しましたが、このブラウザのReview下書きを削除できませんでした。",
    );
    expect(terminateGoal).toHaveBeenCalledOnce();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "ブラウザデータの削除を再試行" }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(terminateGoal).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).toHaveBeenCalledTimes(2);
  });

  it("retries goal-scoped browser cleanup after Goal Delete without resending DELETE", async () => {
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("indexeddb unavailable"))
      .mockResolvedValueOnce(undefined);

    const cache = createCache();
    renderPage(cache);
    await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.click(screen.getByRole("button", { name: "目標を削除" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "目標を削除" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "削除済みGoalのブラウザ下書きを削除できませんでした。",
    );
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
    );
    expect(deleteGoal).toHaveBeenCalledWith(
      sessionLease,
      goal.id,
      goal.revision,
      expect.objectContaining({ csrfToken: session.csrfToken }),
    );
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "ブラウザデータの削除を再試行" }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(getReview).toHaveBeenCalledOnce();
    expect(screen.getByText("Goal cache削除済み")).toBeInTheDocument();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
  });

  it("preserves the local review and links the current Goal when the draft identity moves", async () => {
    const localBody = "レビューAの競合入力";
    const canonicalGoal: Goal = {
      ...goal,
      status: "ended",
      revision: goal.revision + 2,
      currentWork: null,
      terminalAt: "2026-08-20T00:06:00.000Z",
    };
    vi.mocked(getGoal).mockResolvedValue({ goal: canonicalGoal });
    vi.mocked(getReview)
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce(replacementReview);
    vi.mocked(saveReview).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
        "conflict",
        "request-wrong-review",
      ),
    );
    const cache = createCache();
    cache.setQueryData(userQueryKeys.goal(session.user.id, goal.id), { goal });
    renderPage(cache, true);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("保存失敗")).toBeInTheDocument();
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    const resolver = screen.getByRole("link", {
      name: "現在のGoalを開いてください",
    });
    expect(resolver).toHaveAttribute("href", "/goals/" + goal.id);
    expect(
      screen.queryByRole("button", { name: "再試行" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("別の更新が見つかりました"),
    ).not.toBeInTheDocument();
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(reviewDraft);
    expect(deleteBrowserDraft).not.toHaveBeenCalled();

    fireEvent.click(resolver);
    expect(
      await screen.findByText("canonical goal history"),
    ).toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledWith(
      sessionLease,
      goal.id,
      expect.any(AbortSignal),
    );
    expect(getReview).toHaveBeenCalledTimes(2);
  });

  it.each([
    { command: "continue", code: "GOAL_REVIEW_NOT_ACTIVE" },
    { command: "continue", code: "GOAL_VERSION_CONFLICT" },
    { command: "terminate", code: "GOAL_STATE_CONFLICT" },
    { command: "terminate", code: "GOAL_ALREADY_TERMINAL" },
    { command: "delete", code: "GOAL_DELETE_CONFLICT" },
  ] as const)(
    "fences a stale $command command on exact $code and converges with GET only",
    async ({ command, code }) => {
      const canonicalGoal: Goal =
        command === "continue"
          ? continuedGoal
          : command === "terminate"
            ? {
                ...goal,
                status: "ended",
                revision: goal.revision + 1,
                currentWork: null,
                terminalAt: "2026-08-20T00:06:00.000Z",
              }
            : { ...goal, revision: goal.revision + 1 };
      vi.mocked(getGoal).mockResolvedValueOnce({ goal: canonicalGoal });
      const conflict = new APIError(
        409,
        code,
        "stale workspace",
        `request-${command}-${code}`,
      );
      if (command === "continue")
        vi.mocked(continueReview).mockRejectedValueOnce(conflict);
      else if (command === "terminate")
        vi.mocked(terminateGoal).mockRejectedValueOnce(conflict);
      else vi.mocked(deleteGoal).mockRejectedValueOnce(conflict);
      renderPage();
      const editor = await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });

      await invokeReviewTerminalCommand(command);

      const resolver = await screen.findByRole("link", {
        name: "現在のGoalを開いてください",
      });
      expect(resolver).toHaveAttribute("href", `/goals/${goal.id}`);
      expect(editor).toHaveAttribute("readonly");
      expect(screen.getByText("読み取り専用")).toBeInTheDocument();
      expect(getGoal).toHaveBeenCalledOnce();
      expect(putBrowserDraft).not.toHaveBeenCalled();
      if (command === "continue") expect(continueReview).toHaveBeenCalledOnce();
      else if (command === "terminate")
        expect(terminateGoal).toHaveBeenCalledOnce();
      else expect(deleteGoal).toHaveBeenCalledOnce();

      window.dispatchEvent(new Event("online"));
      fireEvent.blur(editor);
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));
      if (command === "continue") expect(continueReview).toHaveBeenCalledOnce();
      else if (command === "terminate")
        expect(terminateGoal).toHaveBeenCalledOnce();
      else expect(deleteGoal).toHaveBeenCalledOnce();
    },
  );

  it("retries only canonical GET after a Continue conflict refresh fails", async () => {
    vi.mocked(continueReview).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_NOT_ACTIVE",
        "stale review",
        "request-review-refresh",
      ),
    );
    vi.mocked(getGoal)
      .mockRejectedValueOnce(new TypeError("GET failed"))
      .mockResolvedValueOnce({ goal: continuedGoal });
    renderPage();

    await invokeReviewTerminalCommand("continue");
    fireEvent.click(
      await screen.findByRole("button", { name: "現在のGoalを再取得" }),
    );

    expect(
      await screen.findByRole("link", {
        name: "現在のGoalを開いてください",
      }),
    ).toHaveAttribute("href", `/goals/${goal.id}`);
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(continueReview).toHaveBeenCalledOnce();
  });

  it("does not treat an unrelated Continue 409 as workspace movement", async () => {
    vi.mocked(continueReview).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_STATE_CONFLICT",
        "different command conflict",
        "request-unrelated-continue",
      ),
    );
    renderPage();

    await invokeReviewTerminalCommand("continue");

    expect(
      await screen.findByText(
        "次のサイクルを開始できませんでした。保存状態を確認してください。",
      ),
    ).toBeInTheDocument();
    expect(getGoal).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Reviewの作業場所は変わりました。", {
        exact: false,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", {
        name: "次のサイクルで目指す目標",
      }),
    ).not.toHaveAttribute("readonly");
  });
});
