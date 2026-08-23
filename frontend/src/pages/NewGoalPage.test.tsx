import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import type {
  Cycle,
  Goal,
  GoalDraft,
  Home,
  Session,
} from "../shared/api/schemas";
import { APIError } from "../shared/api/client";
import {
  adoptGoalDraft,
  getGoalDraft,
  getHome,
  refineGoalDraft,
  saveGoalDraft,
  startGoal,
} from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import { NewGoalPage } from "./NewGoalPage";

vi.mock("../shared/api/workspace", () => ({
  adoptGoalDraft: vi.fn(),
  createGoalDraft: vi.fn(),
  discardGoalDraft: vi.fn(),
  getGoalDraft: vi.fn(),
  getHome: vi.fn(),
  refineGoalDraft: vi.fn(),
  saveGoalDraft: vi.fn(),
  startGoal: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
}));

const draft: GoalDraft = {
  id: "20000000-0000-7000-8000-000000000001",
  draftType: "creation",
  body: "元の目標",
  revision: 0,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const home: Home = {
  progressingGoals: [],
  creationDraft: draft,
  canCreateGoalDraft: false,
  progressingGoalLimit: 2,
  canStartProgressingGoal: true,
};

const session: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

const startedCycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: "50000000-0000-7000-8000-000000000001",
  sequenceNumber: 1,
  status: "active",
  goalVersion: {
    id: "30000000-0000-7000-8000-000000000002",
    versionNumber: 1,
    body: draft.body,
    createdAt: "2026-08-20T00:02:00.000Z",
  },
  startedAt: "2026-08-20T00:02:00.000Z",
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  plan: "",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};

const replayedCurrentCycleId = "40000000-0000-7000-8000-000000000002";
const startedGoal: Goal = {
  id: startedCycle.goalId ?? "",
  status: "active_cycle",
  revision: 1,
  currentVersion: startedCycle.goalVersion,
  currentWork: {
    kind: "active_cycle",
    cycleId: replayedCurrentCycleId,
    cycleSequenceNumber: 2,
  },
  nextCycleSequenceNumber: 3,
  cycleCount: 2,
  createdAt: "2026-08-20T00:02:00.000Z",
  terminalAt: null,
};

describe("NewGoalPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHome).mockResolvedValue(home);
    vi.mocked(getGoalDraft).mockResolvedValue({ draft });
    vi.mocked(saveGoalDraft).mockResolvedValue({ draft });
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(refineGoalDraft).mockResolvedValue({
      generationId: "30000000-0000-7000-8000-000000000001",
      sourceDraftRevision: draft.revision,
      suggestion: "整理された目標",
      contextChanged: false,
    });
    vi.mocked(adoptGoalDraft).mockResolvedValue({
      draft: {
        ...draft,
        body: "整理された目標",
        revision: 1,
        updatedAt: "2026-08-20T00:01:00.000Z",
      },
    });
    vi.mocked(startGoal).mockResolvedValue({
      goal: startedGoal,
      cycle: startedCycle,
      replayed: true,
    });
  });

  it("accepts 80 non-BMP code points and rejects the 81st", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
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

  it("keeps refinement separate until the user explicitly adopts it", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));

    expect(await screen.findByText("整理された目標")).toBeInTheDocument();
    expect(editor).toHaveValue("元の目標");
    expect(adoptGoalDraft).not.toHaveBeenCalled();
    expect(saveGoalDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));

    await waitFor(() =>
      expect(adoptGoalDraft).toHaveBeenCalledWith(
        draft.id,
        "30000000-0000-7000-8000-000000000001",
        draft.revision,
        session.csrfToken,
      ),
    );
    await waitFor(() => expect(editor).toHaveValue("整理された目標"));
  });

  it("retries an ambiguous Start response with the same operation and resolves the canonical workspace", async () => {
    vi.mocked(startGoal)
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({
        goal: startedGoal,
        cycle: startedCycle,
        replayed: true,
      });
    renderPage();
    const startButton = await screen.findByRole("button", {
      name: "この目標で始める",
    });

    fireEvent.click(startButton);

    expect(
      await screen.findByText(
        "目標を開始できませんでした。保存状態と進行中の目標を確認してください。",
      ),
    ).toBeInTheDocument();

    fireEvent.click(startButton);

    expect(await screen.findByText("現在のワークスペース")).toBeInTheDocument();
    expect(startGoal).toHaveBeenCalledTimes(2);
    const firstOptions = vi.mocked(startGoal).mock.calls[0]?.[2];
    const secondOptions = vi.mocked(startGoal).mock.calls[1]?.[2];
    expect(firstOptions).toEqual({
      operationId: expect.any(String),
      csrfToken: session.csrfToken,
    });
    expect(secondOptions?.operationId).toBe(firstOptions?.operationId);
    expect(startGoal).toHaveBeenLastCalledWith(
      draft.id,
      draft.revision,
      secondOptions,
    );
  });

  it("preserves a local draft on the exact revision conflict and reapplies it against the latest revision", async () => {
    const localBody = "この端末で変更した目標";
    const nextLocalBody = "競合解消後にもう一度変更した目標";
    const latestDraft: GoalDraft = {
      ...draft,
      body: "別の端末で変更された目標",
      revision: 1,
      updatedAt: "2026-08-20T00:03:00.000Z",
    };
    vi.mocked(saveGoalDraft)
      .mockRejectedValueOnce(
        new APIError(
          409,
          "GOAL_DRAFT_REVISION_CONFLICT",
          "conflict",
          "request-1",
        ),
      )
      .mockResolvedValueOnce({
        draft: { ...latestDraft, body: localBody, revision: 2 },
      })
      .mockResolvedValueOnce({
        draft: { ...latestDraft, body: nextLocalBody, revision: 3 },
      });
    vi.mocked(getGoalDraft)
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ draft: latestDraft });

    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    const retry = await screen.findByRole("button", { name: "再試行" });
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    expect(getGoalDraft).toHaveBeenCalledTimes(1);
    expect(getGoalDraft).toHaveBeenCalledWith(draft.id);

    fireEvent.click(retry);
    expect(
      await screen.findByText("別の更新が見つかりました"),
    ).toBeInTheDocument();
    expect(editor).toHaveValue(localBody);
    expect(getGoalDraft).toHaveBeenCalledTimes(2);
    expect(putBrowserDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: localBody,
        baseRevision: draft.revision,
      }),
    );
    expect(
      screen.getByRole("button", { name: "この端末の入力を復元" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "サーバーの内容を使用" }),
    ).toBeInTheDocument();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "この端末の入力を復元" }),
    );
    await waitFor(() =>
      expect(saveGoalDraft).toHaveBeenLastCalledWith(
        draft.id,
        localBody,
        latestDraft.revision,
        session.csrfToken,
      ),
    );
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");

    fireEvent.change(editor, { target: { value: nextLocalBody } });
    fireEvent.blur(editor);
    await waitFor(() =>
      expect(saveGoalDraft).toHaveBeenLastCalledWith(
        draft.id,
        nextLocalBody,
        2,
        session.csrfToken,
      ),
    );
  });

  it("isolates an in-flight creation draft save when the draft identity changes", async () => {
    let resolveDraftA!: (value: { draft: GoalDraft }) => void;
    const draftASave = new Promise<{ draft: GoalDraft }>((resolve) => {
      resolveDraftA = resolve;
    });
    const draftB: GoalDraft = {
      ...draft,
      id: "20000000-0000-7000-8000-000000000002",
      body: "新しい下書きB",
      updatedAt: "2026-08-20T00:04:00.000Z",
    };
    const draftABody = "下書きAの未完了入力";
    const draftBBody = "下書きBでの入力";
    vi.mocked(saveGoalDraft)
      .mockImplementationOnce(() => draftASave)
      .mockResolvedValueOnce({
        draft: { ...draftB, body: draftBBody, revision: 1 },
      });
    const cache = createCache();
    renderPage(cache);
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });

    fireEvent.change(editor, { target: { value: draftABody } });
    fireEvent.blur(editor);
    await waitFor(() =>
      expect(saveGoalDraft).toHaveBeenCalledWith(
        draft.id,
        draftABody,
        draft.revision,
        session.csrfToken,
      ),
    );

    act(() => {
      cache.setQueryData<Home>(userQueryKeys.home(session.user.id), {
        ...home,
        creationDraft: draftB,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "あなたの目標" })).toHaveValue(
        draftB.body,
      ),
    );
    const draftBEditor = screen.getByRole("textbox", { name: "あなたの目標" });

    await act(async () => {
      resolveDraftA({
        draft: { ...draft, body: draftABody, revision: 1 },
      });
    });

    expect(draftBEditor).toHaveValue(draftB.body);
    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id))
        ?.creationDraft,
    ).toEqual(draftB);
    expect(saveGoalDraft).not.toHaveBeenCalledWith(
      draftB.id,
      draftABody,
      expect.any(Number),
      session.csrfToken,
    );

    fireEvent.change(draftBEditor, { target: { value: draftBBody } });
    fireEvent.blur(draftBEditor);
    await waitFor(() =>
      expect(saveGoalDraft).toHaveBeenLastCalledWith(
        draftB.id,
        draftBBody,
        draftB.revision,
        session.csrfToken,
      ),
    );
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
        <MemoryRouter initialEntries={["/goals/new"]}>
          <Routes>
            <Route path="/goals/new" element={<NewGoalPage />} />
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
