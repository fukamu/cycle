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
  GoalDeletionAdvisoryContext,
  type GoalDeletionAdvisoryRegistry,
  type GoalDeletionCleanupOutcome,
} from "../features/goal-deletion";
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
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
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
  deleteBrowserDraft: vi.fn(),
  deleteBrowserDraftIfUnchanged: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
  tombstoneDeletedGoalAndClearDrafts: vi.fn(),
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

const newerTriggerCycle: Cycle = {
  ...triggerCycle,
  id: "40000000-0000-7000-8000-000000000006",
  sequenceNumber: 2,
  startedAt: "2026-08-20T00:03:00.000Z",
  completedAt: "2026-08-20T00:04:00.000Z",
};

const newerReviewDraft: GoalDraft = {
  ...reviewDraft,
  id: "40000000-0000-7000-8000-000000000007",
  reviewCycleId: newerTriggerCycle.id,
  body: "新しいReview B",
  revision: 0,
  updatedAt: "2026-08-20T00:04:00.000Z",
};

const newerReviewGoal: Goal = {
  ...goal,
  revision: goal.revision + 2,
  currentWork: {
    kind: "goal_review",
    reviewDraftId: newerReviewDraft.id,
    triggerCycleId: newerTriggerCycle.id,
    triggerCycleSequenceNumber: newerTriggerCycle.sequenceNumber,
  },
  nextCycleSequenceNumber: newerTriggerCycle.sequenceNumber + 1,
  cycleCount: newerTriggerCycle.sequenceNumber,
};

const newerReview: GoalReview = {
  goal: newerReviewGoal,
  reviewDraft: newerReviewDraft,
  triggerCycle: newerTriggerCycle,
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

const activeGoalAfterReview: Goal = {
  ...goal,
  status: "active_cycle",
  revision: goal.revision + 1,
  currentWork: {
    kind: "active_cycle",
    cycleId: "40000000-0000-7000-8000-000000000008",
    cycleSequenceNumber: 2,
  },
  nextCycleSequenceNumber: 3,
  cycleCount: 2,
};

const terminalGoalAfterReview: Goal = {
  ...goal,
  status: "ended",
  revision: goal.revision + 1,
  currentWork: null,
  terminalAt: "2026-08-20T00:03:00.000Z",
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

type GoalDeletionAdvisoryHarness = {
  readonly registry: GoalDeletionAdvisoryRegistry;
  readonly publish: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly dispatch: (deletedUserId: string, deletedGoalId: string) => void;
};

let goalDeletionAdvisoryHarness: GoalDeletionAdvisoryHarness;

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

function deletedGoalError(requestId: string) {
  return new APIError(404, "GOAL_NOT_FOUND", "deleted", requestId);
}

function expectBefore(first: Node, second: Node) {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

describe("GoalReviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    goalDeletionAdvisoryHarness = createGoalDeletionAdvisoryHarness();
    vi.mocked(getReview).mockResolvedValue(review);
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockResolvedValue(undefined);
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
    expect(screen.getByText("80 / 80")).toBeInTheDocument();
    const saveCallsBeforeRejection = vi.mocked(saveReview).mock.calls.length;
    const cacheCallsBeforeRejection =
      vi.mocked(putBrowserDraft).mock.calls.length;

    fireEvent.change(editor, {
      target: { value: `${eightyCodePoints}😀` },
    });

    expect(editor).toHaveValue(eightyCodePoints);
    expect(screen.getByText("80 / 80")).toBeInTheDocument();
    const feedback = screen.getByText(
      "入力後は81文字になるため反映できませんでした。上限80文字まで、入力内容をあと1文字減らしてください。",
    );
    expect(feedback).toHaveAttribute("role", "status");
    expect(editor).toHaveAttribute("aria-describedby", feedback.id);
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
    expect(refine).toHaveAttribute("aria-describedby", guidance.id);
    expect(continueAction).toHaveAttribute("aria-describedby", guidance.id);
    await waitFor(() => expect(terminate).toBeEnabled());
    expect(terminate).not.toHaveAttribute("aria-describedby");
  });

  it("groups idle Review outcomes into ordered labelled sections", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });
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
      `目標を維持してCycle ${goal.nextCycleSequenceNumber}を開始します`,
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

    expectBefore(editor, saveStatus);
    expectBefore(saveStatus, refine);
    expectBefore(refine, nextCycleHeading);
    expectBefore(nextCycleHeading, note);
    expectBefore(note, continueAction);
    expectBefore(continueAction, terminalHeading);
    expect(refine).toBeEnabled();
    expect(continueAction).toBeEnabled();
    expect(
      within(terminalSection).getByRole("button", {
        name: "目標を達成として終了",
      }),
    ).toBeEnabled();
    expect(
      within(terminalSection).getByRole("button", { name: "目標を終了" }),
    ).toBeEnabled();
    expect(
      within(terminalSection).getByRole("button", { name: "目標を削除" }),
    ).toBeEnabled();
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

    const refine = screen.getByRole("button", { name: "AIで目標を整える" });
    const suggestion = screen.getByRole("heading", { name: "AIからの提案" });
    const adopt = screen.getByRole("button", { name: "提案を採用" });
    const nextCycleHeading = screen.getByRole("heading", {
      level: 2,
      name: "次のサイクルへ進む",
    });
    const note = screen.getByText(
      `目標を維持してCycle ${goal.nextCycleSequenceNumber}を開始します`,
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
        revisionTwoDraft.body,
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
        revisionThreeDraft.body,
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
    const guidance = screen.getByText(
      "この端末に残る入力を確認しています。完了するまでお待ちください。",
    );
    expect(terminate).toHaveAttribute("aria-describedby", guidance.id);
    expect(remove).toHaveAttribute("aria-describedby", guidance.id);

    await act(async () => browserRead.resolve(null));
    expect(terminate).toBeEnabled();
    expect(remove).toBeEnabled();
    expect(terminate).not.toHaveAttribute("aria-describedby");
    expect(remove).not.toHaveAttribute("aria-describedby");
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
    ])
      expect(screen.getByRole("button", { name: actionName })).toHaveAttribute(
        "aria-describedby",
        commandGuidance.id,
      );

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
    const recoveryNotice = screen
      .getByText("別の更新が見つかりました")
      .closest<HTMLElement>('[role="alert"]');
    expect(recoveryNotice).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "AIで目標を整える" }),
    ).toHaveAttribute("aria-describedby", recoveryNotice?.id);
    expect(
      screen.getByRole("button", { name: "この目標で次のサイクルへ" }),
    ).toHaveAttribute("aria-describedby", recoveryNotice?.id);
    expect(screen.getByRole("button", { name: "目標を終了" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "目標を終了" }),
    ).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText(
        "入力を保存できていません。「再試行」で保存してから操作してください。",
      ),
    ).not.toBeInTheDocument();
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
    expect(movedNotice).not.toBeNull();
    for (const actionName of [
      "AIで目標を整える",
      "この目標で次のサイクルへ",
      "目標を達成として終了",
      "目標を終了",
      "目標を削除",
    ])
      expect(screen.getByRole("button", { name: actionName })).toHaveAttribute(
        "aria-describedby",
        movedNotice?.id,
      );
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

function createCache() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function activeReviewTransportKey(cache: QueryClient) {
  const transportQueries = cache
    .getQueryCache()
    .findAll({
      queryKey: userQueryKeys.review(session.user.id, goal.id),
      type: "active",
    })
    .filter(({ queryKey }) => queryKey.at(-2) === "transport");
  const transportQuery = transportQueries[0];
  if (transportQueries.length !== 1 || transportQuery === undefined)
    throw new Error(
      `active Review transport query count = ${transportQueries.length}, want 1`,
    );
  return transportQuery.queryKey;
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

function CanonicalGoalRoundTrip() {
  return (
    <>
      <p>現在のGoal route</p>
      <Link to={`/goals/${goal.id}/review`}>Reviewへ戻る</Link>
    </>
  );
}

function createGoalDeletionAdvisoryHarness(): GoalDeletionAdvisoryHarness {
  const listeners = new Map<string, Set<() => void>>();
  const cleanups = new Map<
    string,
    {
      readonly completion: Promise<GoalDeletionCleanupOutcome>;
      readonly resolve: (outcome: GoalDeletionCleanupOutcome) => void;
    }
  >();
  const keyOf = (userId: string, goalId: string) =>
    JSON.stringify([userId, goalId]);
  const publish = vi.fn(() => undefined);
  const subscribe = vi.fn(
    (userId: string, goalId: string, listener: () => void) => {
      const key = keyOf(userId, goalId);
      const exactListeners = listeners.get(key) ?? new Set<() => void>();
      exactListeners.add(listener);
      listeners.set(key, exactListeners);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        exactListeners.delete(listener);
        if (exactListeners.size === 0) listeners.delete(key);
      };
    },
  );
  const beginCleanup: GoalDeletionAdvisoryRegistry["beginCleanup"] = (
    userId,
    goalId,
  ) => {
    const key = keyOf(userId, goalId);
    const current = cleanups.get(key);
    if (current) return { kind: "joined", completion: current.completion };
    let resolve: (outcome: GoalDeletionCleanupOutcome) => void = () =>
      undefined;
    const completion = new Promise<GoalDeletionCleanupOutcome>((done) => {
      resolve = done;
    });
    const cleanup = { completion, resolve };
    cleanups.set(key, cleanup);
    return {
      kind: "owner",
      completion,
      complete: () => {
        if (cleanups.get(key) !== cleanup) return;
        cleanups.delete(key);
        resolve("completed");
      },
      fail: () => {
        if (cleanups.get(key) !== cleanup) return;
        cleanups.delete(key);
        resolve("failed");
      },
    };
  };
  return {
    registry: {
      publish,
      subscribe,
      beginCleanup,
      isKnown: () => false,
    },
    publish,
    subscribe,
    dispatch: (deletedUserId, deletedGoalId) => {
      for (const listener of [
        ...(listeners.get(keyOf(deletedUserId, deletedGoalId)) ?? []),
      ])
        listener();
    },
  };
}

function renderPage(
  cache = createCache(),
  realCanonicalRoutes = false,
  identityQuiesceControl = false,
  cleanupRouteSwitch = false,
  canonicalGoalRoundTrip = false,
) {
  return render(
    <QueryClientProvider client={cache}>
      <AutoSaveScopeProvider>
        {identityQuiesceControl ? <IdentityQuiesceControl /> : null}
        <GoalDeletionAdvisoryContext.Provider
          value={goalDeletionAdvisoryHarness.registry}
        >
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
                      ) : canonicalGoalRoundTrip ? (
                        <CanonicalGoalRoundTrip />
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
        </GoalDeletionAdvisoryContext.Provider>
      </AutoSaveScopeProvider>
    </QueryClientProvider>,
  );
}
