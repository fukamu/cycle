import { act, fireEvent, screen, waitFor } from "@testing-library/react";

import { userQueryKeys } from "../features/goal-collection/goalCache";
import { APIError } from "../shared/api/client";
import {
  adoptReview,
  continueReview,
  deleteGoal,
  getGoal,
  getReview,
  refineReview,
  saveReview,
  terminateGoal,
} from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import {
  createCache,
  deferred,
  goal,
  goalDeletionAdvisoryHarness,
  invokeReviewTerminalCommand,
  registerGoalReviewPageTestLifecycle,
  renderPage,
  review,
  reviewDraft,
  session,
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

describe("GoalReviewPage: deletion fences", () => {
  registerGoalReviewPageTestLifecycle();

  it("keeps only a dirty local Review after a Delete conflict", async () => {
    const localBody = "削除競合後にコピーする端末入力";
    vi.mocked(deleteGoal).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_DELETE_CONFLICT",
        "stale delete",
        "request-dirty-review-delete",
      ),
    );
    vi.mocked(getGoal).mockResolvedValueOnce({
      goal: { ...goal, revision: goal.revision + 1 },
    });
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });

    await invokeReviewTerminalCommand("delete");

    await screen.findByRole("link", { name: "現在のGoalを開いてください" });
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectKey: `goal-review:${goal.id}:${reviewDraft.id}`,
          body: localBody,
        }),
      ),
    );
    expect(deleteGoal).toHaveBeenCalledOnce();
  });

  it("preserves the latest reversion when a Delete conflict fences an in-flight Review save", async () => {
    const inFlightSave = deferred<Awaited<ReturnType<typeof saveReview>>>();
    const inFlightBody = "競合前に送信中だったReview";
    vi.mocked(saveReview).mockReset().mockReturnValueOnce(inFlightSave.promise);
    vi.mocked(deleteGoal).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_DELETE_CONFLICT",
        "stale delete",
        "request-review-delete-in-flight-reversion",
      ),
    );
    vi.mocked(getGoal).mockResolvedValueOnce({
      goal: { ...goal, revision: goal.revision + 1 },
    });
    const cache = createCache();
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editor, { target: { value: inFlightBody } });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveReview).toHaveBeenCalledOnce());
    fireEvent.change(editor, { target: { value: reviewDraft.body } });

    await invokeReviewTerminalCommand("delete");

    await screen.findByRole("link", { name: "現在のGoalを開いてください" });
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectKey: `goal-review:${goal.id}:${reviewDraft.id}`,
          body: reviewDraft.body,
          baseRevision: reviewDraft.revision,
        }),
      ),
    );
    expect(editor).toHaveValue(reviewDraft.body);
    expect(editor).toHaveAttribute("readonly");
    expect(deleteGoal).toHaveBeenCalledOnce();
    const reviewKey = userQueryKeys.review(session.user.id, goal.id);
    const cachedReview = cache.getQueryData(reviewKey);
    const cachedReviewState = cache.getQueryState(reviewKey);

    await act(async () =>
      inFlightSave.resolve({
        reviewDraft: {
          ...reviewDraft,
          body: inFlightBody,
          revision: reviewDraft.revision + 1,
          updatedAt: "2026-08-20T00:08:00.000Z",
        },
      }),
    );
    expect(saveReview).toHaveBeenCalledOnce();
    expect(editor).toHaveValue(reviewDraft.body);
    expect(cache.getQueryData(reviewKey)).toBe(cachedReview);
    expect(cache.getQueryState(reviewKey)).toBe(cachedReviewState);
  });

  it("publishes deletion before durable cleanup and confirms only after cache removal", async () => {
    const cleanup = deferred<void>();
    const events: string[] = [];
    vi.mocked(deleteGoal).mockImplementationOnce(async () => {
      events.push("server:deleted");
    });
    goalDeletionAdvisoryHarness.publish.mockImplementation(() => {
      events.push("advisory");
    });
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockImplementationOnce(
      async () => {
        events.push("tombstone:start");
        await cleanup.promise;
        events.push("tombstone:success");
      },
    );
    const cache = createCache();
    const removeQueries = cache.removeQueries.bind(cache);
    vi.spyOn(cache, "removeQueries").mockImplementation((filters) => {
      events.push("cache:removed");
      return removeQueries(filters);
    });
    renderPage(cache);

    await invokeReviewTerminalCommand("delete");

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(events).toEqual(["server:deleted", "advisory", "tombstone:start"]);
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
    );
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(events).toEqual([
      "server:deleted",
      "advisory",
      "tombstone:start",
      "tombstone:success",
      "cache:removed",
      "advisory",
    ]);
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });

  it("synchronously fences and coalesces duplicate matching deletion advisories without echoing", async () => {
    const cleanup = deferred<void>();
    const lateSave = deferred<Awaited<ReturnType<typeof saveReview>>>();
    vi.mocked(saveReview).mockReturnValueOnce(lateSave.promise);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockImplementationOnce(
      async () => cleanup.promise,
    );
    const cache = createCache();
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    vi.mocked(putBrowserDraft).mockClear();
    vi.mocked(deleteBrowserDraft).mockClear();
    fireEvent.change(editor, {
      target: { value: "通知後に復活させないReview入力" },
    });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveReview).toHaveBeenCalledOnce());
    vi.mocked(putBrowserDraft).mockClear();

    act(() => {
      goalDeletionAdvisoryHarness.dispatch(session.user.id, goal.id);
      goalDeletionAdvisoryHarness.dispatch(session.user.id, goal.id);
    });

    expect(editor).toHaveAttribute("readonly");
    await waitFor(() => expect(deleteBrowserDraft).toHaveBeenCalledOnce());
    expect(deleteBrowserDraft).toHaveBeenCalledWith(
      session.user.id,
      `goal-review:${goal.id}:${reviewDraft.id}`,
    );
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(putBrowserDraft).not.toHaveBeenCalled();
    expect(goalDeletionAdvisoryHarness.publish).not.toHaveBeenCalled();
    expect(deleteGoal).not.toHaveBeenCalled();
    expect(continueReview).not.toHaveBeenCalled();
    expect(terminateGoal).not.toHaveBeenCalled();
    expect(getGoal).not.toHaveBeenCalled();
    expect(refineReview).not.toHaveBeenCalled();
    expect(adoptReview).not.toHaveBeenCalled();

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    await act(async () =>
      lateSave.resolve({
        reviewDraft: {
          ...reviewDraft,
          body: "通知後に復活させないReview入力",
          revision: reviewDraft.revision + 1,
        },
      }),
    );
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(saveReview).toHaveBeenCalledOnce();
    expect(putBrowserDraft).not.toHaveBeenCalled();
    expect(
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toBeUndefined();
    expect(goalDeletionAdvisoryHarness.publish).not.toHaveBeenCalled();
  });

  it("ignores deletion advisories for a different User or Goal", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    vi.mocked(deleteBrowserDraft).mockClear();

    act(() => {
      goalDeletionAdvisoryHarness.dispatch(
        "10000000-0000-7000-8000-000000000002",
        goal.id,
      );
      goalDeletionAdvisoryHarness.dispatch(
        session.user.id,
        "20000000-0000-7000-8000-000000000002",
      );
    });

    expect(goalDeletionAdvisoryHarness.subscribe).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
      expect.anything(),
    );
    expect(
      typeof goalDeletionAdvisoryHarness.subscribe.mock.calls[0]?.[2],
    ).toBe("function");
    expect(editor).not.toHaveAttribute("readonly");
    expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
    expect(goalDeletionAdvisoryHarness.publish).not.toHaveBeenCalled();
    expect(deleteGoal).not.toHaveBeenCalled();
    expect(continueReview).not.toHaveBeenCalled();
    expect(terminateGoal).not.toHaveBeenCalled();
  });

  it.each(["continue", "terminate", "delete"] as const)(
    "cleans a deleted Goal when a pending $command receives GOAL_NOT_FOUND after route leave",
    async (command) => {
      const commandFailure = deferred<never>();
      if (command === "continue")
        vi.mocked(continueReview).mockReturnValueOnce(commandFailure.promise);
      else if (command === "terminate")
        vi.mocked(terminateGoal).mockReturnValueOnce(commandFailure.promise);
      else vi.mocked(deleteGoal).mockReturnValueOnce(commandFailure.promise);
      const cache = createCache();
      const removeQueries = vi.spyOn(cache, "removeQueries");
      renderPage(cache, false, false, true);
      await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });

      await invokeReviewTerminalCommand(command);
      if (command === "continue")
        await waitFor(() => expect(continueReview).toHaveBeenCalledOnce());
      else if (command === "terminate")
        await waitFor(() => expect(terminateGoal).toHaveBeenCalledOnce());
      else await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());
      const goalReadsBeforeFailure = vi.mocked(getGoal).mock.calls.length;

      fireEvent.click(
        screen.getByRole("link", {
          name: "クリーンアップ中に別routeへ移動",
        }),
      );
      expect(await screen.findByText("外部route")).toBeInTheDocument();
      await act(async () =>
        commandFailure.reject(
          new APIError(
            404,
            "GOAL_NOT_FOUND",
            "deleted",
            `request-late-review-${command}-deleted-goal`,
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
        cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
      ).toBeUndefined();
      expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
      expect(goalDeletionAdvisoryHarness.publish).toHaveBeenNthCalledWith(
        1,
        session.user.id,
        goal.id,
      );
      expect(goalDeletionAdvisoryHarness.publish).toHaveBeenNthCalledWith(
        2,
        session.user.id,
        goal.id,
      );
      expect(getGoal).toHaveBeenCalledTimes(goalReadsBeforeFailure);
      if (command === "continue") expect(continueReview).toHaveBeenCalledOnce();
      else if (command === "terminate")
        expect(terminateGoal).toHaveBeenCalledOnce();
      else expect(deleteGoal).toHaveBeenCalledOnce();
    },
  );

  it("cleans a deleted Goal when Delete succeeds after route leave", async () => {
    const deletion = deferred<Awaited<ReturnType<typeof deleteGoal>>>();
    vi.mocked(deleteGoal).mockReturnValueOnce(deletion.promise);
    const cache = createCache();
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache, false, false, true);
    await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    expect(
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toBeDefined();

    await invokeReviewTerminalCommand("delete");
    await waitFor(() => expect(deleteGoal).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", {
        name: "クリーンアップ中に別routeへ移動",
      }),
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
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toBeUndefined();
    expect(deleteGoal).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });

  it("cleans a deleted Goal when a canonical GET receives GOAL_NOT_FOUND after route leave", async () => {
    const canonicalFailure = deferred<never>();
    vi.mocked(continueReview).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_NOT_ACTIVE",
        "stale review",
        "request-late-canonical-review",
      ),
    );
    vi.mocked(getGoal).mockReturnValueOnce(canonicalFailure.promise);
    const cache = createCache();
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache, false, false, true);

    await invokeReviewTerminalCommand("continue");
    await waitFor(() => expect(getGoal).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", {
        name: "クリーンアップ中に別routeへ移動",
      }),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();
    await act(async () =>
      canonicalFailure.reject(
        new APIError(
          404,
          "GOAL_NOT_FOUND",
          "deleted",
          "request-late-canonical-review-deleted-goal",
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
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toBeUndefined();
    expect(continueReview).toHaveBeenCalledOnce();
    expect(getGoal).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });

  it("retries only local cleanup after GOAL_NOT_FOUND and keeps Review fenced", async () => {
    const localBody = "削除済みGoalに残さない端末入力";
    vi.mocked(continueReview).mockRejectedValueOnce(
      new APIError(
        404,
        "GOAL_NOT_FOUND",
        "deleted",
        "request-deleted-review-goal",
      ),
    );
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValueOnce(undefined);
    const cache = createCache();
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });

    await invokeReviewTerminalCommand("continue");

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
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledWith(
      session.user.id,
      goal.id,
    );
    expect(deleteBrowserDraft).toHaveBeenCalledWith(
      session.user.id,
      `goal-review:${goal.id}:${reviewDraft.id}`,
    );
    vi.mocked(putBrowserDraft).mockClear();
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 350)));
    expect(putBrowserDraft).not.toHaveBeenCalled();
    expect(continueReview).toHaveBeenCalledOnce();
    expect(deleteGoal).not.toHaveBeenCalled();
    expect(getGoal).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(getReview).toHaveBeenCalledOnce();
    expect(screen.getByText("Goal cache削除済み")).toBeInTheDocument();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
    expect(continueReview).toHaveBeenCalledOnce();
    expect(getGoal).not.toHaveBeenCalled();
    await waitFor(() => expect(removeQueries).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
      ).toBeUndefined();
      expect(
        cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
      ).toBeUndefined();
    });
  });

  it("still clears Goal drafts when the route leaves during the deleted-Review fence", async () => {
    const reviewDraftCleanup = deferred<void>();
    vi.mocked(continueReview).mockRejectedValueOnce(
      new APIError(
        404,
        "GOAL_NOT_FOUND",
        "deleted",
        "request-deleted-review-route-leave",
      ),
    );
    vi.mocked(deleteBrowserDraft).mockImplementationOnce(
      async () => reviewDraftCleanup.promise,
    );
    const cache = createCache();
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache, false, false, true);

    await invokeReviewTerminalCommand("continue");
    await waitFor(() => expect(deleteBrowserDraft).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("link", {
        name: "クリーンアップ中に別routeへ移動",
      }),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();

    await act(async () => reviewDraftCleanup.resolve());

    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
        session.user.id,
        goal.id,
      ),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
    expect(continueReview).toHaveBeenCalledOnce();
    expect(getGoal).not.toHaveBeenCalled();
    expect(deleteGoal).not.toHaveBeenCalled();
    expect(removeQueries).toHaveBeenCalled();
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toBeUndefined();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
  });

  it("fences a deleted Goal when the mounted Review autosave PATCH returns exact GOAL_NOT_FOUND", async () => {
    const cleanup = deferred<void>();
    vi.mocked(saveReview).mockRejectedValueOnce(
      new APIError(
        404,
        "GOAL_NOT_FOUND",
        "deleted",
        "request-review-autosave-deleted-goal",
      ),
    );
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValueOnce(
      cleanup.promise,
    );
    const cache = createCache();
    const removeQueries = vi.spyOn(cache, "removeQueries");
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    vi.mocked(putBrowserDraft).mockClear();

    fireEvent.change(editor, {
      target: { value: "削除後に保存しないReview入力" },
    });
    fireEvent.blur(editor);

    await waitFor(() => expect(saveReview).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledWith(
        session.user.id,
        goal.id,
      ),
    );
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.getByText("削除済みGoalのブラウザ下書きを削除しています…"),
    ).toBeInTheDocument();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();
    expect(getReview).toHaveBeenCalledOnce();
    vi.mocked(putBrowserDraft).mockClear();
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 350)));
    expect(putBrowserDraft).not.toHaveBeenCalled();

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(saveReview).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
    expect(removeQueries).toHaveBeenCalled();
    expect(
      cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
    ).toBeUndefined();
  });

  it("fences a deleted Goal when Review revision-conflict recovery GET returns exact GOAL_NOT_FOUND", async () => {
    const cleanup = deferred<void>();
    vi.mocked(saveReview).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
        "conflict",
        "request-review-conflict-before-delete",
      ),
    );
    vi.mocked(getReview)
      .mockResolvedValueOnce(review)
      .mockRejectedValueOnce(
        new APIError(
          404,
          "GOAL_NOT_FOUND",
          "deleted",
          "request-review-recovery-deleted-goal",
        ),
      );
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValueOnce(
      cleanup.promise,
    );
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editor, {
      target: { value: "競合確認中に削除されたReview入力" },
    });
    fireEvent.blur(editor);

    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.getByText("削除済みGoalのブラウザ下書きを削除しています…"),
    ).toBeInTheDocument();
    expect(saveReview).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("別の更新が見つかりました"),
    ).not.toBeInTheDocument();

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(saveReview).toHaveBeenCalledOnce();
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });

  it.each(["refine", "adopt"] as const)(
    "fences a deleted Goal when Review %s returns exact GOAL_NOT_FOUND",
    async (operation) => {
      const cleanup = deferred<void>();
      const notFound = new APIError(
        404,
        "GOAL_NOT_FOUND",
        "deleted",
        `request-review-${operation}-deleted-goal`,
      );
      if (operation === "refine")
        vi.mocked(refineReview).mockRejectedValueOnce(notFound);
      else vi.mocked(adoptReview).mockRejectedValueOnce(notFound);
      vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValueOnce(
        cleanup.promise,
      );
      renderPage();
      const editor = await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });

      fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
      if (operation === "adopt") {
        expect(
          await screen.findByText("整理されたレビュー目標"),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));
      }

      await waitFor(() =>
        expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
      );
      expect(editor).toHaveAttribute("readonly");
      expect(
        screen.getByText("削除済みGoalのブラウザ下書きを削除しています…"),
      ).toBeInTheDocument();
      expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();
      expect(refineReview).toHaveBeenCalledOnce();
      expect(adoptReview).toHaveBeenCalledTimes(operation === "adopt" ? 1 : 0);
      expect(
        screen.queryByText("AIから提案を取得できませんでした。"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          "提案を採用できませんでした。現在の下書きを確認してください。",
        ),
      ).not.toBeInTheDocument();

      await act(async () => cleanup.resolve());

      expect(await screen.findByText("ホーム")).toBeInTheDocument();
      expect(refineReview).toHaveBeenCalledOnce();
      expect(adoptReview).toHaveBeenCalledTimes(operation === "adopt" ? 1 : 0);
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
      expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["autosave", "recovery", "refine", "adopt"] as const)(
    "does not delete-fence Review on a non-exact 404 from %s",
    async (operation) => {
      const genericNotFound = new APIError(
        404,
        "INVALID_ERROR_RESPONSE",
        "not the deleted Goal contract",
        `request-review-${operation}-generic-not-found`,
      );
      if (operation === "autosave") {
        vi.mocked(saveReview).mockRejectedValueOnce(genericNotFound);
      } else if (operation === "recovery") {
        vi.mocked(saveReview).mockRejectedValueOnce(
          new APIError(
            409,
            "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
            "conflict",
            "request-review-generic-recovery-conflict",
          ),
        );
        vi.mocked(getReview)
          .mockResolvedValueOnce(review)
          .mockRejectedValueOnce(genericNotFound);
      } else if (operation === "refine") {
        vi.mocked(refineReview).mockRejectedValueOnce(genericNotFound);
      } else {
        vi.mocked(adoptReview).mockRejectedValueOnce(genericNotFound);
      }
      renderPage();
      const editor = await screen.findByRole("textbox", {
        name: "次のサイクルで目指す目標",
      });

      if (operation === "autosave" || operation === "recovery") {
        fireEvent.change(editor, {
          target: { value: `generic 404を保持する${operation}入力` },
        });
        fireEvent.blur(editor);
        await waitFor(() => expect(saveReview).toHaveBeenCalledOnce());
        if (operation === "recovery")
          await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));
        else await screen.findByText("保存失敗");
      } else {
        fireEvent.click(
          screen.getByRole("button", { name: "AIで目標を整える" }),
        );
        if (operation === "adopt") {
          expect(
            await screen.findByText("整理されたレビュー目標"),
          ).toBeInTheDocument();
          fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));
          expect(
            await screen.findByText(
              "提案を採用できませんでした。現在の下書きを確認してください。",
            ),
          ).toBeInTheDocument();
        } else {
          expect(
            await screen.findByText("AIから提案を取得できませんでした。"),
          ).toBeInTheDocument();
        }
      }

      expect(tombstoneDeletedGoalAndClearDrafts).not.toHaveBeenCalled();
      expect(goalDeletionAdvisoryHarness.publish).not.toHaveBeenCalled();
      expect(
        screen.queryByText("このGoalはすでに削除されています。"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    },
  );

  it("coalesces concurrent Review autosave and Refine GOAL_NOT_FOUND fences", async () => {
    const cleanup = deferred<void>();
    const refineFailure = deferred<never>();
    const saveFailure = deferred<never>();
    vi.mocked(refineReview).mockReturnValueOnce(refineFailure.promise);
    vi.mocked(saveReview).mockReturnValueOnce(saveFailure.promise);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockReturnValueOnce(
      cleanup.promise,
    );
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
    await waitFor(() => expect(refineReview).toHaveBeenCalledOnce());
    fireEvent.change(editor, {
      target: { value: "並行404で復活させないReview入力" },
    });
    fireEvent.blur(editor);
    await waitFor(() => expect(saveReview).toHaveBeenCalledOnce());

    await act(async () =>
      refineFailure.reject(
        new APIError(
          404,
          "GOAL_NOT_FOUND",
          "deleted",
          "request-review-concurrent-refine-deleted-goal",
        ),
      ),
    );
    await waitFor(() =>
      expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce(),
    );
    await act(async () =>
      saveFailure.reject(
        new APIError(
          404,
          "GOAL_NOT_FOUND",
          "deleted",
          "request-review-concurrent-save-deleted-goal",
        ),
      ),
    );

    expect(editor).toHaveAttribute("readonly");
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();
    expect(saveReview).toHaveBeenCalledOnce();
    expect(refineReview).toHaveBeenCalledOnce();

    await act(async () => cleanup.resolve());

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });

  it("retries only deleted-Goal cleanup after autosave GOAL_NOT_FOUND without resending PATCH", async () => {
    vi.mocked(saveReview).mockRejectedValueOnce(
      new APIError(
        404,
        "GOAL_NOT_FOUND",
        "deleted",
        "request-review-autosave-cleanup-retry",
      ),
    );
    vi.mocked(tombstoneDeletedGoalAndClearDrafts)
      .mockRejectedValueOnce(new Error("indexedDB unavailable"))
      .mockResolvedValueOnce(undefined);
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editor, {
      target: { value: "cleanup retryでも再送しないReview入力" },
    });
    fireEvent.blur(editor);

    expect(
      await screen.findByText(
        "削除済みGoalのブラウザ下書きを削除できませんでした。",
      ),
    ).toBeInTheDocument();
    expect(editor).toHaveAttribute("readonly");
    expect(saveReview).toHaveBeenCalledOnce();
    expect(getReview).toHaveBeenCalledOnce();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledOnce();
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(saveReview).toHaveBeenCalledOnce();
    expect(getReview).toHaveBeenCalledOnce();
    expect(refineReview).not.toHaveBeenCalled();
    expect(adoptReview).not.toHaveBeenCalled();
    expect(tombstoneDeletedGoalAndClearDrafts).toHaveBeenCalledTimes(2);
    expect(goalDeletionAdvisoryHarness.publish).toHaveBeenCalledTimes(2);
  });
});
