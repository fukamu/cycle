import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthenticatedSessionTestProvider } from "../test/AuthenticatedSessionTestProvider";
import { createCurrentAuthenticatedRequestLease } from "../test/authenticatedRequestLease";
import { AutoSaveScopeProvider } from "../shared/autosave/AutoSaveScopeProvider";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import { APIError } from "../shared/api/client";
import type {
  CurrentWork,
  Goal,
  GoalDraft,
  Home,
  Session,
} from "../shared/api/schemas";
import { createGoalDraft, getHome } from "../shared/api/workspace";
import {
  readSelectedCycleFrame,
  rememberSelectedCycleFrame,
} from "../shared/preferences/selectedFramePreference";
import { HomePage } from "./HomePage";

vi.mock("../shared/api/workspace", () => ({
  createGoalDraft: vi.fn(),
  getHome: vi.fn(),
}));
vi.mock("../features/app-referral/AppReferralPromotion", () => ({
  AppReferralPromotion: () => null,
}));

const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

const sessionLease = createCurrentAuthenticatedRequestLease(session.user.id);

const existingCreationDraft: GoalDraft = {
  id: "50000000-0000-7000-8000-000000000001",
  draftType: "creation",
  body: "別のタブで保存された目標",
  revision: 2,
  updatedAt: "2026-08-20T00:02:00.000Z",
};

type ActiveGoal = Goal & {
  readonly status: "active_cycle";
  readonly currentWork: Extract<CurrentWork, { kind: "active_cycle" }>;
};

const firstGoal = makeGoal({
  id: "10000000-0000-7000-8000-000000000001",
  body: "最初の目標",
  cycleId: "20000000-0000-7000-8000-000000000001",
});
const secondGoal: Goal = {
  ...makeGoal({
    id: "10000000-0000-7000-8000-000000000002",
    body: "二つ目の目標",
    cycleId: "20000000-0000-7000-8000-000000000002",
  }),
  status: "goal_review",
  currentWork: {
    kind: "goal_review",
    reviewDraftId: "30000000-0000-7000-8000-000000000002",
    triggerCycleId: "20000000-0000-7000-8000-000000000002",
    triggerCycleSequenceNumber: 1,
  },
};
const thirdGoal = makeGoal({
  id: "10000000-0000-7000-8000-000000000003",
  body: "三つ目の目標",
  cycleId: "20000000-0000-7000-8000-000000000003",
});

describe("HomePage progressing goal collection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(createGoalDraft).mockReset();
    vi.mocked(getHome).mockReset();
  });

  it("reconciles selected Frames against the current Active Cycles", async () => {
    rememberSelectedCycleFrame(firstGoal.currentWork.cycleId, "do");
    rememberSelectedCycleFrame(
      secondGoal.currentWork?.kind === "goal_review"
        ? secondGoal.currentWork.triggerCycleId
        : "",
      "check",
    );
    rememberSelectedCycleFrame(thirdGoal.currentWork.cycleId, "action");
    vi.mocked(getHome).mockResolvedValue({
      progressingGoals: [firstGoal, secondGoal],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: false,
    });

    renderHome();

    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.length).toBe(1));
    expect(
      readSelectedCycleFrame(firstGoal.currentWork.cycleId, "active"),
    ).toBe("do");
    expect(
      readSelectedCycleFrame(thirdGoal.currentWork.cycleId, "active"),
    ).toBe("plan");
  });

  it("renders two independently routed goal cards at the free limit", async () => {
    const user = userEvent.setup();
    const home: Home = {
      progressingGoals: [firstGoal, secondGoal],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: false,
    };
    vi.mocked(getHome).mockResolvedValue(home);

    renderHome();

    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    expect(getHome).toHaveBeenCalledWith(sessionLease, expect.any(AbortSignal));
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(
      within(cards[0]!).getByRole("heading", { name: "最初の目標" }),
    ).toBeInTheDocument();
    expect(
      within(cards[1]!).getByRole("heading", { name: "二つ目の目標" }),
    ).toBeInTheDocument();
    const activeCTA = screen.getByRole("link", { name: "Cycle 1を続ける" });
    const reviewCTA = screen.getByRole("link", { name: "目標を見直す" });
    expect(activeCTA).toHaveAttribute(
      "href",
      `/goals/${firstGoal.id}/cycles/${firstGoal.currentWork?.cycleId}`,
    );
    expect(reviewCTA).toHaveAttribute("href", `/goals/${secondGoal.id}/review`);
    await user.tab();
    expect(activeCTA).toHaveFocus();
    await user.tab();
    expect(reviewCTA).toHaveFocus();
  });

  it("keeps the collection contract usable at the paid boundary of three", async () => {
    vi.mocked(getHome).mockResolvedValue({
      progressingGoals: [firstGoal, secondGoal, thirdGoal],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 3,
      canStartProgressingGoal: false,
    });

    renderHome();

    expect(await screen.findByText("3 / 3")).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Cycle 1を続ける" })[1],
    ).toHaveAttribute(
      "href",
      `/goals/${thirdGoal.id}/cycles/${thirdGoal.currentWork?.cycleId}`,
    );
  });

  it("shows the existing load error instead of guessing an action for inconsistent current work", async () => {
    const cache = createCache();
    vi.mocked(getHome).mockResolvedValue({
      progressingGoals: [{ ...firstGoal, status: "goal_review" }],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: false,
    });

    renderHome(cache);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "読み込めませんでした。",
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "目標を見直す" }),
    ).not.toBeInTheDocument();
    expect(
      cache.getQueryData(userQueryKeys.goal(session.user.id, firstGoal.id)),
    ).toBeUndefined();
  });

  it("opens the existing draft after an exact create conflict and one canonical Home refetch", async () => {
    const emptyHome: Home = {
      progressingGoals: [],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: true,
    };
    const canonicalHome: Home = {
      ...emptyHome,
      creationDraft: existingCreationDraft,
      canCreateGoalDraft: false,
    };
    vi.mocked(getHome)
      .mockResolvedValueOnce(emptyHome)
      .mockResolvedValueOnce(canonicalHome);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-home-create-conflict",
      ),
    );
    const cache = createCache();

    renderHome(cache);
    fireEvent.click(
      await screen.findByRole("button", { name: "新しい目標を設定" }),
    );

    expect(await screen.findByText("新規目標route")).toBeInTheDocument();
    expect(createGoalDraft).toHaveBeenCalledOnce();
    expect(getHome).toHaveBeenCalledTimes(2);
    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
    ).toEqual(canonicalHome);
  });

  it("does not recover a different 409 as a creation-draft conflict", async () => {
    const emptyHome: Home = {
      progressingGoals: [],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: true,
    };
    vi.mocked(getHome).mockResolvedValueOnce(emptyHome);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_DRAFT_REVISION_CONFLICT",
        "different conflict",
        "request-home-other-conflict",
      ),
    );

    renderHome();
    fireEvent.click(
      await screen.findByRole("button", { name: "新しい目標を設定" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "目標の下書きを作成できませんでした。",
    );
    expect(createGoalDraft).toHaveBeenCalledOnce();
    expect(getHome).toHaveBeenCalledOnce();
    expect(screen.queryByText("新規目標route")).not.toBeInTheDocument();
  });

  it("does not publish or navigate a late conflict recovery after leaving Home", async () => {
    const emptyHome: Home = {
      progressingGoals: [],
      creationDraft: null,
      canCreateGoalDraft: true,
      progressingGoalLimit: 2,
      canStartProgressingGoal: true,
    };
    const canonicalHome: Home = {
      ...emptyHome,
      creationDraft: existingCreationDraft,
      canCreateGoalDraft: false,
    };
    const recovery = deferred<Home>();
    vi.mocked(getHome)
      .mockResolvedValueOnce(emptyHome)
      .mockReturnValueOnce(recovery.promise);
    vi.mocked(createGoalDraft).mockRejectedValueOnce(
      new APIError(
        409,
        "GOAL_CREATION_DRAFT_ALREADY_EXISTS",
        "conflict",
        "request-home-late-conflict",
      ),
    );
    const cache = createCache();

    renderHome(cache, true);
    fireEvent.click(
      await screen.findByRole("button", { name: "新しい目標を設定" }),
    );
    await waitFor(() => expect(getHome).toHaveBeenCalledTimes(2));

    await act(async () => {
      recovery.resolve(canonicalHome);
      queueMicrotask(() =>
        fireEvent.click(screen.getByRole("link", { name: "外部routeへ移動" })),
      );
    });
    await act(async () => undefined);

    expect(await screen.findByText("外部route")).toBeInTheDocument();
    expect(screen.queryByText("新規目標route")).not.toBeInTheDocument();
    expect(createGoalDraft).toHaveBeenCalledOnce();
    expect(
      cache.getQueryData<Home>(userQueryKeys.home(session.user.id)),
    ).toEqual(emptyHome);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeGoal({
  id,
  body,
  cycleId,
}: {
  readonly id: string;
  readonly body: string;
  readonly cycleId: string;
}): ActiveGoal {
  return {
    id,
    status: "active_cycle",
    revision: 0,
    currentVersion: {
      id: id.replace("10000000", "40000000"),
      versionNumber: 1,
      body,
      createdAt: "2026-08-20T00:00:00.000Z",
    },
    currentWork: {
      kind: "active_cycle",
      cycleId,
      cycleSequenceNumber: 1,
    },
    nextCycleSequenceNumber: 2,
    cycleCount: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    terminalAt: null,
  };
}

function createCache() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderHome(cache = createCache(), routeSwitch = false) {
  render(
    <QueryClientProvider client={cache}>
      <AutoSaveScopeProvider>
        <AuthenticatedSessionTestProvider
          lease={sessionLease}
          session={session}
        >
          <MemoryRouter>
            <PostCommitCleanupBoundary
              runSessionOperation={async (_expectedUserId, operation) =>
                operation(() => true)
              }
            >
              <Routes>
                <Route
                  path="/"
                  element={
                    <>
                      {routeSwitch ? (
                        <Link to="/external">外部routeへ移動</Link>
                      ) : null}
                      <HomePage />
                    </>
                  }
                />
                <Route path="/goals/new" element={<p>新規目標route</p>} />
                <Route path="/external" element={<p>外部route</p>} />
              </Routes>
            </PostCommitCleanupBoundary>
          </MemoryRouter>
        </AuthenticatedSessionTestProvider>
      </AutoSaveScopeProvider>
    </QueryClientProvider>,
  );
}
