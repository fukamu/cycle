import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  Home,
  Session,
} from "../shared/api/schemas";
import { APIError, type AuthenticatedRequestLease } from "../shared/api/client";
import {
  adoptGoalDraft,
  createGoalDraft,
  discardGoalDraft,
  getGoalDraft,
  getHome,
  refineGoalDraft,
  saveGoalDraft,
  startGoal,
} from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import { HomePage } from "./HomePage";
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
  deleteBrowserDraftIfUnchanged: vi.fn(),
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

const sessionLease = createCurrentAuthenticatedRequestLease(session.user.id);

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

describe("NewGoalPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHome).mockResolvedValue(home);
    vi.mocked(getGoalDraft).mockResolvedValue({ draft });
    vi.mocked(saveGoalDraft).mockResolvedValue({ draft });
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraftIfUnchanged).mockResolvedValue(undefined);
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

  it("converges an exact creation conflict through canonical Home without resending POST", async () => {
    const emptyHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    const existingDraft: GoalDraft = {
      ...draft,
      id: "20000000-0000-7000-8000-000000000010",
      body: "別のタブで保存された目標",
      revision: 3,
      updatedAt: "2026-08-20T00:10:00.000Z",
    };
    const canonicalHome: Home = {
      ...home,
      creationDraft: existingDraft,
    };
    vi.mocked(getHome)
      .mockReset()
      .mockResolvedValueOnce(emptyHome)
      .mockResolvedValueOnce(canonicalHome);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-create-conflict",
        { draftId: "details-must-not-be-used" },
      ),
    );
    const cache = createCache();

    renderPage(cache);
    fireEvent.click(
      await screen.findByRole("button", { name: "下書きを作成" }),
    );

    expect(
      await screen.findByRole("textbox", { name: "あなたの目標" }),
    ).toHaveValue(existingDraft.body);
    expect(createGoalDraft).toHaveBeenCalledOnce();
    expect(createGoalDraft).toHaveBeenCalledWith(
      sessionLease,
      "",
      session.csrfToken,
    );
    expect(getHome).toHaveBeenCalledTimes(2);
    expect(getGoalDraft).not.toHaveBeenCalled();
    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
    ).toEqual(canonicalHome);
  });

  it("does not converge or resend POST when canonical Home has no creation draft", async () => {
    const emptyHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    vi.mocked(getHome)
      .mockReset()
      .mockResolvedValueOnce(emptyHome)
      .mockResolvedValueOnce(emptyHome);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-create-missing",
      ),
    );

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "下書きを作成" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "下書きを作成できませんでした。時間をおいて再試行してください。",
    );
    expect(createGoalDraft).toHaveBeenCalledOnce();
    expect(getHome).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("textbox", { name: "あなたの目標" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the original conflict when canonical Home recovery fails", async () => {
    const emptyHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    const conflict = new APIError(
      409,
      "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
      "conflict",
      "request-create-fetch-failure",
    );
    vi.mocked(getHome)
      .mockReset()
      .mockResolvedValueOnce(emptyHome)
      .mockRejectedValueOnce(new Error("canonical Home unavailable"));
    vi.mocked(createGoalDraft).mockRejectedValueOnce(conflict);
    const cache = createCache();

    renderPage(cache);
    fireEvent.click(
      await screen.findByRole("button", { name: "下書きを作成" }),
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(createGoalDraft).toHaveBeenCalledOnce();
    expect(getHome).toHaveBeenCalledTimes(2);
    expect(cache.getMutationCache().getAll()).toHaveLength(1);
    expect(cache.getMutationCache().getAll()[0]?.state.error).toBe(conflict);
  });

  it("cancels an older in-flight Home query before canonical conflict recovery", async () => {
    const emptyHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    const staleHome: Home = {
      ...emptyHome,
      canStartProgressingGoal: false,
    };
    const canonicalDraft: GoalDraft = {
      ...draft,
      id: "20000000-0000-7000-8000-000000000012",
      body: "競合後の canonical Home",
    };
    const canonicalHome: Home = {
      ...home,
      creationDraft: canonicalDraft,
    };
    const olderRefetch = deferred<Home>();
    vi.mocked(getHome)
      .mockReset()
      .mockResolvedValueOnce(emptyHome)
      .mockReturnValueOnce(olderRefetch.promise)
      .mockResolvedValueOnce(canonicalHome);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-create-deduplication",
      ),
    );
    const cache = createCache();

    renderPage(cache);
    await screen.findByRole("button", { name: "下書きを作成" });
    const olderRequest = cache.fetchQuery({
      queryKey: userQueryKeys.home(session.user.id),
      queryFn: ({ signal }) => getHome(sessionLease, signal),
      staleTime: 0,
      retry: false,
    });
    void olderRequest.catch(() => undefined);
    await waitFor(() => expect(getHome).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "下書きを作成" }));

    expect(
      await screen.findByRole("textbox", { name: "あなたの目標" }),
    ).toHaveValue(canonicalDraft.body);
    expect(getHome).toHaveBeenCalledTimes(3);
    expect(vi.mocked(getHome).mock.calls[1]?.[1]?.aborted).toBe(true);
    expect(createGoalDraft).toHaveBeenCalledOnce();

    await act(async () => olderRefetch.resolve(staleHome));
    await olderRequest.catch(() => undefined);
    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
    ).toEqual(canonicalHome);
  });

  it("preserves a newer Home publication while conflict recovery is in flight", async () => {
    const emptyHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    const olderDraft: GoalDraft = {
      ...draft,
      id: "20000000-0000-7000-8000-000000000013",
      body: "遅れて届いた revision 3",
      revision: 3,
    };
    const newerDraft: GoalDraft = {
      ...olderDraft,
      body: "先に公開された revision 4",
      revision: 4,
    };
    const olderHome: Home = { ...home, creationDraft: olderDraft };
    const newerHome: Home = { ...home, creationDraft: newerDraft };
    const recovery = deferred<Home>();
    vi.mocked(getHome)
      .mockReset()
      .mockResolvedValueOnce(emptyHome)
      .mockReturnValueOnce(recovery.promise);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-create-newer-home",
      ),
    );
    const cache = createCache();

    renderPage(cache);
    fireEvent.click(
      await screen.findByRole("button", { name: "下書きを作成" }),
    );
    await waitFor(() => expect(getHome).toHaveBeenCalledTimes(2));

    act(() => {
      cache.setQueryData(userQueryKeys.home(session.user.id), newerHome);
    });
    expect(
      await screen.findByRole("textbox", { name: "あなたの目標" }),
    ).toHaveValue(newerDraft.body);

    await act(async () => recovery.resolve(olderHome));
    await waitFor(() =>
      expect(cache.getMutationCache().getAll()[0]?.state.status).toBe(
        "success",
      ),
    );

    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
    ).toEqual(newerHome);
    expect(screen.getByRole("textbox", { name: "あなたの目標" })).toHaveValue(
      newerDraft.body,
    );
    expect(createGoalDraft).toHaveBeenCalledOnce();
  });

  it("does not overwrite a recreated Home query with the same update count", async () => {
    const homeQueryKey = userQueryKeys.home(session.user.id);
    const emptyHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    const olderDraft: GoalDraft = {
      ...draft,
      id: "20000000-0000-7000-8000-000000000014",
      body: "remove前のqueryへ届いた revision 3",
      revision: 3,
    };
    const recreatedDraft: GoalDraft = {
      ...olderDraft,
      body: "再作成queryの revision 4",
      revision: 4,
    };
    const olderHome: Home = { ...home, creationDraft: olderDraft };
    const recreatedHome: Home = { ...home, creationDraft: recreatedDraft };
    const recovery = deferred<Home>();
    vi.mocked(getHome)
      .mockReset()
      .mockResolvedValueOnce(emptyHome)
      .mockReturnValueOnce(recovery.promise);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-create-home-query-aba",
      ),
    );
    const cache = createCache();

    renderPage(cache);
    const createButton = await screen.findByRole("button", {
      name: "下書きを作成",
    });
    const originalQuery = cache
      .getQueryCache()
      .find({ queryKey: homeQueryKey, exact: true });
    const originalUpdateCount = originalQuery?.state.dataUpdateCount;

    fireEvent.click(createButton);
    await waitFor(() => expect(getHome).toHaveBeenCalledTimes(2));

    act(() => {
      cache.removeQueries({ queryKey: homeQueryKey, exact: true });
      cache.setQueryData(homeQueryKey, recreatedHome);
    });
    const recreatedQuery = cache
      .getQueryCache()
      .find({ queryKey: homeQueryKey, exact: true });
    expect(recreatedQuery).not.toBe(originalQuery);
    expect(recreatedQuery?.state.dataUpdateCount).toBe(originalUpdateCount);

    await act(async () => recovery.resolve(olderHome));
    await waitFor(() =>
      expect(cache.getMutationCache().getAll()[0]?.state.status).toBe(
        "success",
      ),
    );

    expect(cache.getQueryData<Home>(homeQueryKey)).toEqual(recreatedHome);
    expect(createGoalDraft).toHaveBeenCalledOnce();
  });

  it("does not publish a late conflict recovery after the identity lease changes", async () => {
    const emptyHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    const canonicalHome: Home = {
      ...home,
      creationDraft: {
        ...draft,
        id: "20000000-0000-7000-8000-000000000011",
        body: "切替後に届いた別User向け下書き",
      },
    };
    const recovery = deferred<Home>();
    let identityIsCurrent = true;
    const requestController = new AbortController();
    const changingLease: AuthenticatedRequestLease = {
      expectedUserId: session.user.id,
      signal: requestController.signal,
      isCurrent: () => identityIsCurrent,
    };
    vi.mocked(getHome)
      .mockReset()
      .mockResolvedValueOnce(emptyHome)
      .mockReturnValueOnce(recovery.promise);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-create-identity",
      ),
    );
    const cache = createCache();

    renderPage(cache, false, false, false, changingLease);
    fireEvent.click(
      await screen.findByRole("button", { name: "下書きを作成" }),
    );
    await waitFor(() => expect(getHome).toHaveBeenCalledTimes(2));

    identityIsCurrent = false;
    await act(async () => recovery.resolve(canonicalHome));
    await act(async () => undefined);

    expect(createGoalDraft).toHaveBeenCalledOnce();
    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
    ).toEqual(emptyHome);
    expect(
      screen.queryByRole("textbox", { name: "あなたの目標" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
        sessionLease,
        draft.id,
        "30000000-0000-7000-8000-000000000001",
        draft.revision,
        session.csrfToken,
      ),
    );
    await waitFor(() => expect(editor).toHaveValue("整理された目標"));
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late Goal Refine settlement after identity quiescence: %s",
    async (settlement) => {
      const completion =
        deferred<Awaited<ReturnType<typeof refineGoalDraft>>>();
      vi.mocked(refineGoalDraft).mockReturnValue(completion.promise);
      const cache = createCache();
      renderPage(cache, false, true);
      const editor = await screen.findByRole("textbox", {
        name: "あなたの目標",
      });
      const cachedHome = cache.getQueryData<Home>(
        userQueryKeys.home(session.user.id),
      );

      fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
      await waitFor(() => expect(refineGoalDraft).toHaveBeenCalledOnce());
      fireEvent.click(
        screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
      );
      expect(await screen.findByText("切替準備完了")).toBeInTheDocument();

      await act(async () => {
        if (settlement === "resolve") {
          completion.resolve({
            generationId: "30000000-0000-7000-8000-000000000009",
            sourceDraftRevision: draft.revision,
            suggestion: "切替後に届いた提案",
            contextChanged: false,
          });
        } else {
          completion.reject(new Error("late failure"));
        }
      });
      await act(async () => undefined);

      expect(screen.getByRole("textbox", { name: "あなたの目標" })).toBe(
        editor,
      );
      expect(editor).toHaveValue(draft.body);
      expect(
        cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
      ).toBe(cachedHome);
      expect(screen.queryByText("切替後に届いた提案")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
      expect(
        screen.queryByText("現在のワークスペース"),
      ).not.toBeInTheDocument();
    },
  );

  it("ignores a late adoption from a replaced creation-draft generation", async () => {
    const completion = deferred<Awaited<ReturnType<typeof adoptGoalDraft>>>();
    const replacementDraft: GoalDraft = {
      ...draft,
      id: "20000000-0000-7000-8000-000000000008",
      body: "採用待ちの間に届いた新しい下書きB",
      updatedAt: "2026-08-20T00:08:00.000Z",
    };
    vi.mocked(adoptGoalDraft).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache);

    fireEvent.click(
      await screen.findByRole("button", { name: "AIで目標を整える" }),
    );
    expect(await screen.findByText("整理された目標")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));
    await waitFor(() => expect(adoptGoalDraft).toHaveBeenCalledOnce());

    act(() => {
      cache.setQueryData<Home>(userQueryKeys.home(session.user.id), {
        ...home,
        creationDraft: replacementDraft,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "あなたの目標" })).toHaveValue(
        replacementDraft.body,
      ),
    );
    const replacementEditor = screen.getByRole("textbox", {
      name: "あなたの目標",
    });

    await act(async () =>
      completion.resolve({
        draft: {
          ...draft,
          body: "旧下書きAへの遅延採用結果",
          revision: 1,
          updatedAt: "2026-08-20T00:10:00.000Z",
        },
      }),
    );
    await act(async () => undefined);

    expect(screen.getByRole("textbox", { name: "あなたの目標" })).toBe(
      replacementEditor,
    );
    expect(replacementEditor).toHaveValue(replacementDraft.body);
    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id))
        ?.creationDraft,
    ).toEqual(replacementDraft);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late adoption after identity quiescence: %s",
    async (settlement) => {
      const completion = deferred<Awaited<ReturnType<typeof adoptGoalDraft>>>();
      vi.mocked(adoptGoalDraft).mockReturnValue(completion.promise);
      const cache = createCache();
      renderPage(cache, false, true);
      const editor = await screen.findByRole("textbox", {
        name: "あなたの目標",
      });
      const cachedHome = cache.getQueryData<Home>(
        userQueryKeys.home(session.user.id),
      );

      fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));
      expect(await screen.findByText("整理された目標")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));
      await waitFor(() => expect(adoptGoalDraft).toHaveBeenCalledOnce());
      fireEvent.click(
        screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
      );
      expect(await screen.findByText("切替準備完了")).toBeInTheDocument();

      await act(async () => {
        if (settlement === "resolve") {
          completion.resolve({
            draft: {
              ...draft,
              body: "切替後に届いた採用結果",
              revision: 1,
              updatedAt: "2026-08-20T00:10:00.000Z",
            },
          });
        } else {
          completion.reject(new Error("late failure"));
        }
      });
      await act(async () => undefined);

      expect(screen.getByRole("textbox", { name: "あなたの目標" })).toBe(
        editor,
      );
      expect(editor).toHaveValue(draft.body);
      expect(
        cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
      ).toBe(cachedHome);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("ホーム")).not.toBeInTheDocument();
      expect(
        screen.queryByText("現在のワークスペース"),
      ).not.toBeInTheDocument();
    },
  );

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
    const firstOptions = vi.mocked(startGoal).mock.calls[0]?.[3];
    const secondOptions = vi.mocked(startGoal).mock.calls[1]?.[3];
    expect(firstOptions).toEqual({
      operationId: expect.any(String),
      csrfToken: session.csrfToken,
    });
    expect(secondOptions?.operationId).toBe(firstOptions?.operationId);
    expect(startGoal).toHaveBeenLastCalledWith(
      sessionLease,
      draft.id,
      draft.revision,
      secondOptions,
    );
  });

  it("rejects input while Start is pending and restores editing after failure", async () => {
    const request = deferred<Awaited<ReturnType<typeof startGoal>>>();
    vi.mocked(startGoal).mockImplementationOnce(() => request.promise);
    const user = userEvent.setup();
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });

    await user.click(screen.getByRole("button", { name: "この目標で始める" }));
    await waitFor(() => expect(startGoal).toHaveBeenCalledOnce());

    expect(editor).toHaveAttribute("readonly");
    await user.type(editor, "command中の追記");
    expect(editor).toHaveValue(draft.body);

    await act(async () => request.reject(new TypeError("network")));

    expect(
      await screen.findByText(
        "目標を開始できませんでした。保存状態と進行中の目標を確認してください。",
      ),
    ).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");
    expect(editor).toHaveValue(draft.body);

    await user.type(editor, "失敗後の追記");
    expect(editor).toHaveValue(draft.body + "失敗後の追記");
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
    expect(getGoalDraft).toHaveBeenCalledWith(
      sessionLease,
      draft.id,
      expect.any(AbortSignal),
    );

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
        sessionLease,
        draft.id,
        localBody,
        latestDraft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("保存済み")).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");

    fireEvent.change(editor, { target: { value: nextLocalBody } });
    fireEvent.blur(editor);
    await waitFor(() =>
      expect(saveGoalDraft).toHaveBeenLastCalledWith(
        sessionLease,
        draft.id,
        nextLocalBody,
        2,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
  });

  it("preserves a local draft and links Home when the creation scope has ended", async () => {
    const localBody = "終了済みscopeでコピーする入力";
    const canonicalHome: Home = {
      ...home,
      creationDraft: null,
      canCreateGoalDraft: true,
    };
    let homeLoads = 0;
    vi.mocked(getHome)
      .mockReset()
      .mockImplementation(async () => {
        homeLoads += 1;
        return homeLoads === 1 ? home : canonicalHome;
      });
    vi.mocked(saveGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_DRAFT_REVISION_CONFLICT",
        "conflict",
        "request-creation-moved",
      ),
    );
    vi.mocked(getGoalDraft).mockRejectedValueOnce(
      new APIError(
        404,
        "GOAL_DRAFT_NOT_FOUND",
        "not found",
        "request-creation-latest",
      ),
    );

    renderPage(createCache(), true);
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    const resolver = await screen.findByRole("link", {
      name: "現在のホームを開いてください",
    });
    expect(resolver).toHaveAttribute("href", "/");
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "再試行" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下書きを破棄" })).toBeDisabled();
    await waitFor(() =>
      expect(putBrowserDraft).toHaveBeenCalledWith(
        expect.objectContaining({ body: localBody }),
      ),
    );
    expect(deleteBrowserDraft).not.toHaveBeenCalled();

    fireEvent.click(resolver);
    expect(
      await screen.findByRole("heading", { name: "目標から、次の一歩へ。" }),
    ).toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(2);
    for (const [lease, signal] of vi.mocked(getHome).mock.calls) {
      expect(lease).toBe(sessionLease);
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    expect(screen.queryByText("目標の設定を続ける")).not.toBeInTheDocument();
  });

  it("moves directly on the exact ended-draft PATCH error without fetching the stale draft", async () => {
    const localBody = "直接終了を検知した端末入力";
    vi.mocked(saveGoalDraft).mockRejectedValueOnce(
      new APIError(
        404,
        "GOAL_DRAFT_NOT_FOUND",
        "not found",
        "request-direct-creation-moved",
      ),
    );

    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });
    fireEvent.change(editor, { target: { value: localBody } });
    fireEvent.blur(editor);

    expect(
      await screen.findByRole("link", {
        name: "現在のホームを開いてください",
      }),
    ).toHaveAttribute("href", "/");
    expect(editor).toHaveValue(localBody);
    expect(editor).toHaveAttribute("readonly");
    expect(getGoalDraft).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "再試行" }),
    ).not.toBeInTheDocument();
  });

  it("keeps abandon disabled until browser draft hydration finishes", async () => {
    const browserRead = deferred<Awaited<ReturnType<typeof getBrowserDraft>>>();
    vi.mocked(getBrowserDraft).mockReturnValueOnce(browserRead.promise);

    renderPage();
    await screen.findByRole("textbox", { name: "あなたの目標" });
    const abandon = screen.getByRole("button", { name: "下書きを破棄" });
    expect(abandon).toBeDisabled();

    fireEvent.click(abandon);
    expect(discardGoalDraft).not.toHaveBeenCalled();

    await act(async () => browserRead.resolve(null));
    expect(abandon).toBeEnabled();
  });

  it("retries only browser cleanup after Start succeeds", async () => {
    vi.mocked(deleteBrowserDraft)
      .mockRejectedValueOnce(new Error("indexeddb unavailable"))
      .mockResolvedValueOnce(undefined);

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "この目標で始める" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "目標は開始されましたが、このブラウザの下書きを削除できませんでした。",
    );
    expect(startGoal).toHaveBeenCalledOnce();
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "ブラウザデータの削除を再試行" }),
    );

    expect(await screen.findByText("現在のワークスペース")).toBeInTheDocument();
    expect(startGoal).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).toHaveBeenCalledTimes(2);
  });

  it("does not publish Start cleanup success into a replacement route generation", async () => {
    const cleanupGate = deferred<void>();
    vi.mocked(deleteBrowserDraft)
      .mockImplementationOnce(async () => cleanupGate.promise)
      .mockResolvedValue(undefined);
    const cache = createCache();
    const invalidateQueries = vi.spyOn(cache, "invalidateQueries");
    renderPage(cache, false, false, true);

    fireEvent.click(
      await screen.findByRole("button", { name: "この目標で始める" }),
    );
    await waitFor(() => expect(startGoal).toHaveBeenCalledOnce());
    await waitFor(() => expect(deleteBrowserDraft).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("ブラウザに残る下書きを削除しています…"),
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
      cache.getQueryData(userQueryKeys.goal(session.user.id, startedGoal.id)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(
        userQueryKeys.cycle(session.user.id, startedGoal.id, startedCycle.id),
      ),
    ).toBeUndefined();
    expect(startGoal).toHaveBeenCalledOnce();
  });

  it("retries only browser cleanup after Creation abandon succeeds", async () => {
    vi.mocked(deleteBrowserDraft)
      .mockRejectedValueOnce(new Error("indexeddb unavailable"))
      .mockResolvedValueOnce(undefined);

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "下書きを破棄" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "下書きを破棄" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "下書きは破棄されましたが、このブラウザの下書きを削除できませんでした。",
    );
    expect(discardGoalDraft).toHaveBeenCalledOnce();
    expect(screen.queryByText("ホーム")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "ブラウザデータの削除を再試行" }),
    );

    expect(await screen.findByText("ホーム")).toBeInTheDocument();
    expect(discardGoalDraft).toHaveBeenCalledOnce();
    expect(deleteBrowserDraft).toHaveBeenCalledTimes(2);
  });

  it("ignores a Start completion from a replaced draft generation and preserves the new local input", async () => {
    const completion = deferred<Awaited<ReturnType<typeof startGoal>>>();
    const replacementDraft: GoalDraft = {
      ...draft,
      id: "20000000-0000-7000-8000-000000000009",
      body: "新しい下書き",
      updatedAt: "2026-08-20T00:09:00.000Z",
    };
    const replacementBody = "新しい世代の端末入力";
    vi.mocked(startGoal).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache);

    fireEvent.click(
      await screen.findByRole("button", { name: "この目標で始める" }),
    );
    await waitFor(() => expect(startGoal).toHaveBeenCalledOnce());

    act(() => {
      cache.setQueryData<Home>(userQueryKeys.home(session.user.id), {
        ...home,
        creationDraft: replacementDraft,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "あなたの目標" })).toHaveValue(
        replacementDraft.body,
      ),
    );
    const replacementEditor = screen.getByRole("textbox", {
      name: "あなたの目標",
    });
    fireEvent.change(replacementEditor, { target: { value: replacementBody } });
    vi.mocked(deleteBrowserDraft).mockClear();

    await act(async () =>
      completion.resolve({
        goal: startedGoal,
        cycle: startedCycle,
        replayed: true,
      }),
    );
    await act(async () => undefined);

    expect(replacementEditor).toHaveValue(replacementBody);
    expect(screen.getByRole("textbox", { name: "あなたの目標" })).toBe(
      replacementEditor,
    );
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
  });

  it("ignores a Start completion after identity quiescence begins and before remount", async () => {
    const completion = deferred<Awaited<ReturnType<typeof startGoal>>>();
    vi.mocked(startGoal).mockReturnValue(completion.promise);
    const cache = createCache();
    renderPage(cache, false, true);

    fireEvent.click(
      await screen.findByRole("button", { name: "この目標で始める" }),
    );
    await waitFor(() => expect(startGoal).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "異なるUserへの切替を模擬" }),
    );
    expect(await screen.findByText("切替準備完了")).toBeInTheDocument();
    vi.mocked(deleteBrowserDraft).mockClear();

    await act(async () =>
      completion.resolve({
        goal: startedGoal,
        cycle: startedCycle,
        replayed: true,
      }),
    );
    await act(async () => undefined);

    expect(screen.getByRole("textbox", { name: "あなたの目標" })).toHaveValue(
      draft.body,
    );
    expect(screen.queryByText("現在のワークスペース")).not.toBeInTheDocument();
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, startedGoal.id)),
    ).toBeUndefined();
    expect(deleteBrowserDraft).not.toHaveBeenCalled();
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
        sessionLease,
        draft.id,
        draftABody,
        draft.revision,
        session.csrfToken,
        expect.any(AbortSignal),
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
      sessionLease,
      draftB.id,
      draftABody,
      expect.any(Number),
      session.csrfToken,
      expect.any(AbortSignal),
    );

    fireEvent.change(draftBEditor, { target: { value: draftBBody } });
    fireEvent.blur(draftBEditor);
    await waitFor(() =>
      expect(saveGoalDraft).toHaveBeenLastCalledWith(
        sessionLease,
        draftB.id,
        draftBBody,
        draftB.revision,
        session.csrfToken,
        expect.any(AbortSignal),
      ),
    );
  });
});

function createCache() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function renderPage(
  cache = createCache(),
  realCanonicalRoutes = false,
  identityQuiesceControl = false,
  cleanupRouteSwitch = false,
  requestLease = sessionLease,
) {
  return render(
    <QueryClientProvider client={cache}>
      <AutoSaveScopeProvider>
        {identityQuiesceControl ? <IdentityQuiesceControl /> : null}
        <AuthenticatedSessionTestProvider
          lease={requestLease}
          session={session}
        >
          <MemoryRouter initialEntries={["/goals/new"]}>
            {cleanupRouteSwitch ? (
              <Link to="/external">クリーンアップ中に別routeへ移動</Link>
            ) : null}
            <PostCommitCleanupBoundary
              runSessionOperation={async (_expectedUserId, operation) =>
                operation(() => true)
              }
            >
              <Routes>
                <Route
                  path="/"
                  element={realCanonicalRoutes ? <HomePage /> : <p>ホーム</p>}
                />
                <Route path="/goals/new" element={<NewGoalPage />} />
                <Route
                  path="/goals/:goalId"
                  element={<p>現在のワークスペース</p>}
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
