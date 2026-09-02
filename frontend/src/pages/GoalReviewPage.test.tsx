import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";

import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthenticatedSessionTestProvider } from "../test/AuthenticatedSessionTestProvider";
import { createCurrentAuthenticatedRequestLease } from "../test/authenticatedRequestLease";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
} from "../shared/autosave/AutoSaveScopeProvider";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import type {
  Cycle,
  Goal,
  GoalDraft,
  GoalReview,
  Session,
} from "../shared/api/schemas";
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
  type BrowserDraft,
  clearGoalDrafts,
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import { GoalWorkspacePage } from "./GoalWorkspacePage";
import { GoalReviewPage } from "./GoalReviewPage";

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
  clearGoalDrafts: vi.fn(),
  deleteBrowserDraft: vi.fn(),
  deleteBrowserDraftIfUnchanged: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
}));

const goal: Goal = {
  id: "20000000-0000-7000-8000-000000000001",
  status: "goal_review",
  revision: 2,
  currentVersion: {
    id: "30000000-0000-7000-8000-000000000001",
    versionNumber: 1,
    body: "現在の目標",
    createdAt: "2026-08-20T00:00:00.000Z",
  },
  currentWork: {
    kind: "goal_review",
    reviewDraftId: "40000000-0000-7000-8000-000000000002",
    triggerCycleId: "40000000-0000-7000-8000-000000000001",
    triggerCycleSequenceNumber: 1,
  },
  nextCycleSequenceNumber: 2,
  cycleCount: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  terminalAt: null,
};

const reviewDraft: GoalDraft = {
  id: "40000000-0000-7000-8000-000000000002",
  draftType: "review",
  goalId: goal.id,
  baseGoalVersionId: goal.currentVersion.id,
  reviewCycleId: "40000000-0000-7000-8000-000000000001",
  body: goal.currentVersion.body,
  revision: 0,
  updatedAt: "2026-08-20T00:01:00.000Z",
};

const triggerCycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: goal.id,
  sequenceNumber: 1,
  status: "completed",
  goalVersion: goal.currentVersion,
  startedAt: "2026-08-20T00:00:00.000Z",
  completedAt: "2026-08-20T00:01:00.000Z",
  canceledAt: null,
  cancellationReason: null,
  plan: "計画",
  do: "実行",
  check: "評価",
  action: "改善",
  contentRevision: 4,
  frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
};

const review: GoalReview = { goal, reviewDraft, triggerCycle };

const replacementReviewDraft: GoalDraft = {
  ...reviewDraft,
  id: "40000000-0000-7000-8000-000000000005",
  body: "新しいレビュー下書きB",
  updatedAt: "2026-08-20T00:05:00.000Z",
};

const replacementGoal: Goal = {
  ...goal,
  revision: goal.revision + 1,
  currentWork: {
    kind: "goal_review",
    reviewDraftId: replacementReviewDraft.id,
    triggerCycleId: triggerCycle.id,
    triggerCycleSequenceNumber: triggerCycle.sequenceNumber,
  },
};

const replacementReview: GoalReview = {
  goal: replacementGoal,
  reviewDraft: replacementReviewDraft,
  triggerCycle,
};

const replayedCycle: Cycle = {
  ...triggerCycle,
  id: "40000000-0000-7000-8000-000000000003",
  sequenceNumber: 2,
  status: "active",
  goalVersion: {
    ...goal.currentVersion,
    id: "30000000-0000-7000-8000-000000000002",
    versionNumber: 2,
  },
  startedAt: "2026-08-20T00:02:00.000Z",
  completedAt: null,
  plan: "",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};

const currentCycleId = "40000000-0000-7000-8000-000000000004";
const continuedGoal: Goal = {
  ...goal,
  status: "active_cycle",
  revision: goal.revision + 1,
  currentVersion: replayedCycle.goalVersion,
  currentWork: {
    kind: "active_cycle",
    cycleId: currentCycleId,
    cycleSequenceNumber: 3,
  },
  nextCycleSequenceNumber: 4,
  cycleCount: 3,
};

const session: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

const sessionLease = createCurrentAuthenticatedRequestLease(session.user.id);

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("GoalReviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReview).mockResolvedValue(review);
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(clearGoalDrafts).mockResolvedValue(undefined);
    vi.mocked(deleteGoal).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraftIfUnchanged).mockResolvedValue(undefined);
    vi.mocked(saveReview).mockResolvedValue({ reviewDraft });
    vi.mocked(refineReview).mockResolvedValue({
      generationId: "30000000-0000-7000-8000-000000000003",
      sourceDraftRevision: reviewDraft.revision,
      sourceGoalRevision: goal.revision,
      suggestion: "整理されたレビュー目標",
      contextChanged: false,
    });
    vi.mocked(adoptReview).mockResolvedValue({
      reviewDraft: {
        ...reviewDraft,
        body: "整理されたレビュー目標",
        revision: 1,
        updatedAt: "2026-08-20T00:02:00.000Z",
      },
    });
    vi.mocked(continueReview).mockResolvedValue({
      goal: continuedGoal,
      versionCreated: false,
      cycle: replayedCycle,
      replayed: true,
    });
    vi.mocked(terminateGoal).mockResolvedValue({
      goal: {
        ...goal,
        status: "ended",
        revision: goal.revision + 1,
        currentWork: null,
        terminalAt: "2026-08-20T00:02:00.000Z",
      },
      canceledCycle: null,
    });
  });

  it("accepts 80 non-BMP review code points and rejects the 81st", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    const eightyCodePoints = "😀".repeat(80);

    expect(editor).not.toHaveAttribute("maxlength");
    fireEvent.change(editor, { target: { value: eightyCodePoints } });

    expect(editor).toHaveValue(eightyCodePoints);
    expect(screen.getByText("80 / 80")).toBeInTheDocument();

    fireEvent.change(editor, {
      target: { value: `${eightyCodePoints}😀` },
    });

    expect(editor).toHaveValue(eightyCodePoints);
    expect(screen.getByText("80 / 80")).toBeInTheDocument();
  });

  it("keeps Review refinement separate until the user explicitly adopts it", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));

    expect(
      await screen.findByText("整理されたレビュー目標"),
    ).toBeInTheDocument();
    expect(editor).toHaveValue(reviewDraft.body);
    expect(adoptReview).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));

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

  it("ignores a late adoption from a replaced review-draft generation", async () => {
    const completion = deferred<Awaited<ReturnType<typeof adoptReview>>>();
    vi.mocked(adoptReview).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache);

    fireEvent.click(
      await screen.findByRole("button", { name: "AIで目標を整える" }),
    );
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
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", {
          name: "次のサイクルで目指す目標",
        }),
      ).toHaveValue(replacementReviewDraft.body),
    );
    const replacementEditor = screen.getByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

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
    ).toBe(replacementEditor);
    expect(replacementEditor).toHaveValue(replacementReviewDraft.body);
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(replacementReviewDraft);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();
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
        normalizedBody,
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
        `目標を維持してCycle ${goal.nextCycleSequenceNumber}を開始します`,
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

    expect(
      await screen.findByText(
        `変更した目標をGoal v${goal.currentVersion.versionNumber + 1}として保存し、Cycle ${goal.nextCycleSequenceNumber}を開始します`,
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

    await act(async () => browserRead.resolve(null));
    expect(terminate).toBeEnabled();
    expect(remove).toBeEnabled();
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
        "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionとして保存されません。",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("現在の目標のまま終了します。"),
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
    fireEvent.click(screen.getByRole("button", { name: "目標を終了" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionとして保存されません。",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("現在の目標のまま終了します。"),
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

    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    expect(editor).toHaveValue(localBody);
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: localBody,
        baseRevision: reviewDraft.revision,
      }),
    );
    expect(deleteBrowserDraft).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "サーバーの内容を使用" }),
    );
    await waitFor(() => expect(editor).toHaveValue(latestDraft.body));
    expect(saveReview).toHaveBeenCalledOnce();
    expect(screen.getByText("保存済み")).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");

    fireEvent.change(editor, { target: { value: nextBody } });
    fireEvent.blur(editor);

    await waitFor(() =>
      expect(saveReview).toHaveBeenLastCalledWith(
        sessionLease,
        goal.id,
        reviewDraft.id,
        nextBody,
        latestDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
  });

  it("isolates a cached and in-flight review when its draft identity changes", async () => {
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
    const reviewBBody = "レビューBでの入力";
    vi.mocked(saveReview)
      .mockImplementationOnce(() => reviewASave)
      .mockResolvedValueOnce({
        reviewDraft: {
          ...replacementReviewDraft,
          body: reviewBBody,
          revision: 1,
        },
      });
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
        reviewABody,
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
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", {
          name: "次のサイクルで目指す目標",
        }),
      ).toHaveValue(replacementReviewDraft.body),
    );
    const editorB = screen.getByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    expect(getBrowserDraft).toHaveBeenCalledWith(
      session.user.id,
      `goal-review:${goal.id}:${reviewDraft.id}`,
    );
    expect(getBrowserDraft).toHaveBeenCalledWith(
      session.user.id,
      `goal-review:${goal.id}:${replacementReviewDraft.id}`,
    );

    await act(async () => {
      resolveReviewA({
        reviewDraft: { ...reviewDraft, body: reviewABody, revision: 1 },
      });
    });

    expect(editorB).toHaveValue(replacementReviewDraft.body);
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(replacementReviewDraft);

    fireEvent.blur(editorB);
    await act(async () => undefined);
    expect(saveReview).toHaveBeenCalledOnce();

    fireEvent.change(editorB, { target: { value: reviewBBody } });
    fireEvent.blur(editorB);
    await waitFor(() =>
      expect(saveReview).toHaveBeenLastCalledWith(
        sessionLease,
        goal.id,
        replacementReviewDraft.id,
        reviewBBody,
        replacementReviewDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
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
    expect(resolver).toHaveAttribute("href", "/goals/" + goal.id);
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

  it("ignores a Continue completion from a replaced review generation and preserves the new local input", async () => {
    const completion = deferred<Awaited<ReturnType<typeof continueReview>>>();
    const replacementBody = "新しいReview世代の端末入力";
    vi.mocked(continueReview).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache);

    fireEvent.click(
      await screen.findByRole("button", {
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
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
      ).toHaveValue(replacementReviewDraft.body),
    );
    const replacementEditor = screen.getByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
    fireEvent.change(replacementEditor, { target: { value: replacementBody } });
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

    expect(replacementEditor).toHaveValue(replacementBody);
    expect(
      screen.getByRole("textbox", { name: "次のサイクルで目指す目標" }),
    ).toBe(replacementEditor);
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
  });

  it("ignores a Continue completion after identity quiescence begins and before remount", async () => {
    const completion = deferred<Awaited<ReturnType<typeof continueReview>>>();
    vi.mocked(continueReview).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache, false, true);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "この目標で次のサイクルへ",
      }),
    );
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
    ).toBeUndefined();
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
    vi.mocked(clearGoalDrafts).mockClear();

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
    expect(clearGoalDrafts).not.toHaveBeenCalled();
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

    fireEvent.click(
      await screen.findByRole("button", {
        name: "この目標で次のサイクルへ",
      }),
    );
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
    ).toBeUndefined();
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
    vi.mocked(clearGoalDrafts)
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
    expect(clearGoalDrafts).toHaveBeenCalledWith(session.user.id, goal.id);
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
    expect(clearGoalDrafts).toHaveBeenCalledTimes(2);
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
    renderPage();
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

      await waitFor(() => expect(clearGoalDrafts).toHaveBeenCalledOnce());
      await waitFor(() => expect(removeQueries).toHaveBeenCalled());
      expect(screen.getByText("外部route")).toBeInTheDocument();
      expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
      expect(
        cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)),
      ).toBeUndefined();
      expect(
        cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)),
      ).toBeUndefined();
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
      expect(clearGoalDrafts).toHaveBeenCalledWith(session.user.id, goal.id),
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
    expect(clearGoalDrafts).toHaveBeenCalledOnce();
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

    await waitFor(() => expect(clearGoalDrafts).toHaveBeenCalledOnce());
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
    vi.mocked(clearGoalDrafts)
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
    expect(clearGoalDrafts).toHaveBeenCalledWith(session.user.id, goal.id);
    expect(clearGoalDrafts).toHaveBeenCalledOnce();
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
    expect(clearGoalDrafts).toHaveBeenCalledTimes(2);
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
      expect(clearGoalDrafts).toHaveBeenCalledWith(session.user.id, goal.id),
    );
    expect(await screen.findByText("外部route")).toBeInTheDocument();
    expect(clearGoalDrafts).toHaveBeenCalledOnce();
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
});

function createCache() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

async function invokeReviewTerminalCommand(
  command: "continue" | "terminate" | "delete",
) {
  const label =
    command === "continue"
      ? "この目標で次のサイクルへ"
      : command === "terminate"
        ? "目標を終了"
        : "目標を削除";
  const button = await screen.findByRole("button", { name: label });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  if (command === "continue") return;
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
}

function CacheInspectingHome() {
  const cache = useQueryClient();
  const hasDeletedGoalCache =
    cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)) !==
      undefined ||
    cache.getQueryData(userQueryKeys.review(session.user.id, goal.id)) !==
      undefined;
  return (
    <>
      <p>ホーム</p>
      <p>{hasDeletedGoalCache ? "Goal cache残存" : "Goal cache削除済み"}</p>
    </>
  );
}

function renderPage(
  cache = createCache(),
  realCanonicalRoutes = false,
  identityQuiesceControl = false,
  cleanupRouteSwitch = false,
) {
  return render(
    <QueryClientProvider client={cache}>
      <AutoSaveScopeProvider>
        {identityQuiesceControl ? <IdentityQuiesceControl /> : null}
        <AuthenticatedSessionTestProvider
          lease={sessionLease}
          session={session}
        >
          <MemoryRouter initialEntries={[`/goals/${goal.id}/review`]}>
            {cleanupRouteSwitch ? (
              <Link to="/external">クリーンアップ中に別routeへ移動</Link>
            ) : null}
            <PostCommitCleanupBoundary
              runSessionOperation={async (_expectedUserId, operation) =>
                operation(() => true)
              }
            >
              <Routes>
                <Route path="/" element={<CacheInspectingHome />} />
                <Route
                  path="/goals/:goalId/review"
                  element={<GoalReviewPage />}
                />
                <Route
                  path="/goals/:goalId"
                  element={
                    realCanonicalRoutes ? (
                      <GoalWorkspacePage />
                    ) : (
                      <p>現在のワークスペース</p>
                    )
                  }
                />
                <Route
                  path="/history/goals/:goalId"
                  element={<p>canonical goal history</p>}
                />
                <Route path="/external" element={<p>外部route</p>} />
              </Routes>
            </PostCommitCleanupBoundary>
          </MemoryRouter>
        </AuthenticatedSessionTestProvider>
      </AutoSaveScopeProvider>
    </QueryClientProvider>,
  );
}
