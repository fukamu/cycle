/* eslint-disable react-refresh/only-export-components -- This test-only harness shares fixtures and render helpers across parallel Review suites. */

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
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
  FirstUseGuideProvider,
  useFirstUseGuideControls,
} from "../features/first-use-guide";
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
  getReview,
  refineReview,
  saveReview,
  terminateGoal,
} from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import { GoalWorkspacePage } from "./GoalWorkspacePage";
import { GoalReviewPage } from "./GoalReviewPage";

const goal: Goal = {
  id: "20000000-0000-7000-8000-000000000001",
  status: "goal_review",
  revision: 2,
  currentVersion: {
    id: "30000000-0000-7000-8000-000000000001",
    versionNumber: 1,
    body: "現在の目標",
    successSignal: null,
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
  successSignal: null,
  revision: 0,
  updatedAt: "2026-08-20T00:01:00.000Z",
};

const triggerCycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: goal.id,
  sequenceNumber: 1,
  status: "completed",
  goalVersion: goal.currentVersion,
  previousCompletedCycleAction: null,
  reviewDate: null,
  reviewScheduleRevision: 0,
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
  previousCompletedCycleAction: {
    cycleId: triggerCycle.id,
    cycleSequenceNumber: triggerCycle.sequenceNumber,
    goalVersionNumber: triggerCycle.goalVersion.versionNumber,
    action: triggerCycle.action,
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
    reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
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
    reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
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

function FirstUseGuideReplayControl() {
  const controls = useFirstUseGuideControls();
  if (!controls.canReplay) return null;
  return (
    <button type="button" onClick={controls.replayCurrentGuide}>
      はじめてガイドを再表示
    </button>
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

function expectDescribedBy(element: HTMLElement, descriptionId: string) {
  expect(element.getAttribute("aria-describedby")?.split(/\s+/)).toContain(
    descriptionId,
  );
}

function expectNotDescribedBy(element: HTMLElement, descriptionId: string) {
  expect(element.getAttribute("aria-describedby")?.split(/\s+/)).not.toContain(
    descriptionId,
  );
}

export function registerGoalReviewPageTestLifecycle() {
  beforeEach(() => {
    window.localStorage.clear();
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
}

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
  guideReplayControl = false,
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
            <FirstUseGuideProvider>
              {guideReplayControl ? <FirstUseGuideReplayControl /> : null}
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
            </FirstUseGuideProvider>
          </AuthenticatedSessionTestProvider>
        </GoalDeletionAdvisoryContext.Provider>
      </AutoSaveScopeProvider>
    </QueryClientProvider>,
  );
}

export {
  activeGoalAfterReview,
  activeReviewTransportKey,
  continuedGoal,
  createCache,
  deferred,
  deletedGoalError,
  expectBefore,
  expectDescribedBy,
  expectNotDescribedBy,
  goal,
  goalDeletionAdvisoryHarness,
  invokeReviewTerminalCommand,
  newerReview,
  newerReviewDraft,
  newerReviewGoal,
  newerTriggerCycle,
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
  triggerCycle,
};
