import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
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
  continueReview,
  getReview,
  saveReview,
  terminateGoal,
} from "../shared/api/workspace";
import {
  type BrowserDraft,
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import { GoalReviewPage } from "./GoalReviewPage";

vi.mock("../shared/api/workspace", () => ({
  adoptReview: vi.fn(),
  continueReview: vi.fn(),
  deleteGoal: vi.fn(),
  getReview: vi.fn(),
  refineReview: vi.fn(),
  saveReview: vi.fn(),
  terminateGoal: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn(),
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

describe("GoalReviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReview).mockResolvedValue(review);
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(saveReview).mockResolvedValue({ reviewDraft });
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
        "この変更案は、次のサイクルを開始しないため保存されません。",
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
    const firstOptions = vi.mocked(continueReview).mock.calls[0]?.[3];
    const secondOptions = vi.mocked(continueReview).mock.calls[1]?.[3];
    expect(firstOptions).toEqual({
      operationId: expect.any(String),
      csrfToken: session.csrfToken,
    });
    expect(secondOptions?.operationId).toBe(firstOptions?.operationId);
    expect(continueReview).toHaveBeenLastCalledWith(
      goal.id,
      goal.revision,
      reviewDraft.revision,
      secondOptions,
    );
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
        goal.id,
        reviewDraft.id,
        nextBody,
        latestDraft.revision,
        session.csrfToken,
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
        goal.id,
        reviewDraft.id,
        reviewABody,
        reviewDraft.revision,
        session.csrfToken,
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
        goal.id,
        replacementReviewDraft.id,
        reviewBBody,
        replacementReviewDraft.revision,
        session.csrfToken,
      ),
    );
  });

  it("rejects a conflict refresh that returns another review draft identity", async () => {
    const localBody = "レビューAの競合入力";
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
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "次のサイクルで目指す目標",
    });

    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    await waitFor(() => expect(getReview).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("保存失敗")).toBeInTheDocument();
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.queryByText("別の更新が見つかりました"),
    ).not.toBeInTheDocument();
    expect(
      cache.getQueryData<GoalReview>(
        userQueryKeys.review(session.user.id, goal.id),
      )?.reviewDraft,
    ).toEqual(reviewDraft);
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
  });
});

function createCache() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function renderPage(cache = createCache()) {
  return render(
    <QueryClientProvider client={cache}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[`/goals/${goal.id}/review`]}>
          <Routes>
            <Route path="/" element={<p>ホーム</p>} />
            <Route path="/goals/:goalId/review" element={<GoalReviewPage />} />
            <Route
              path="/goals/:goalId"
              element={<p>現在のワークスペース</p>}
            />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}
