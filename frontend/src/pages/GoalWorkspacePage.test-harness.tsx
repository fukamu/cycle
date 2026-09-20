/* eslint-disable react-refresh/only-export-components -- This test-only harness intentionally shares fixtures, mocks, and render helpers across parallel test files. */

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthenticatedSessionTestProvider } from "../test/AuthenticatedSessionTestProvider";
import { createCurrentAuthenticatedRequestLease } from "../test/authenticatedRequestLease";
import { FirstUseGuideProvider } from "../features/first-use-guide";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import {
  GoalDeletionAdvisoryContext,
  type GoalDeletionAdvisoryRegistry,
  type GoalDeletionCleanupOutcome,
} from "../features/goal-deletion";
import { APIError } from "../shared/api/client";
import { cycleFrameTemplateCopy } from "../shared/copy/ja";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
} from "../shared/autosave/AutoSaveScopeProvider";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import type { Cycle, Goal, Session } from "../shared/api/schemas";
import { getCycle, getGoal, saveCycleFrame } from "../shared/api/workspace";
import {
  clearCycleDrafts,
  clearGoalDrafts,
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "../shared/drafts/browserDraftCache";
import { GoalWorkspacePage } from "./GoalWorkspacePage";

const goal: Goal = {
  id: "20000000-0000-7000-8000-000000000001",
  status: "active_cycle",
  revision: 0,
  currentVersion: {
    id: "30000000-0000-7000-8000-000000000001",
    versionNumber: 1,
    body: "目標",
    successSignal: null,
    createdAt: "2026-08-20T00:00:00.000Z",
  },
  currentWork: {
    kind: "active_cycle",
    cycleId: "40000000-0000-7000-8000-000000000001",
    cycleSequenceNumber: 1,
    reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
  },
  nextCycleSequenceNumber: 2,
  cycleCount: 1,
  createdAt: "2026-08-20T00:00:00.000Z",
  terminalAt: null,
};

const cycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: goal.id,
  sequenceNumber: 1,
  status: "active",
  goalVersion: goal.currentVersion,
  previousCompletedCycleAction: null,
  reviewDate: null,
  reviewScheduleRevision: 0,
  startedAt: "2026-08-20T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  plan: "自動保存前",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};

const completableCycle: Cycle = {
  ...cycle,
  plan: "計画",
  do: "実行",
  check: "評価",
  action: "改善",
  contentRevision: 4,
  frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
};

const currentCycleId = "40000000-0000-7000-8000-000000000002";
const replannedAt = "2026-09-16T00:00:00.000Z";
const replannedSourceCycle: Cycle = {
  ...cycle,
  status: "canceled",
  canceledAt: replannedAt,
  cancellationReason: "replanned",
};
const replannedSuccessorCycle: Cycle = {
  ...cycle,
  id: currentCycleId,
  sequenceNumber: 2,
  startedAt: replannedAt,
  plan: "",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};
const replannedGoal: Goal = {
  ...goal,
  revision: 1,
  currentWork: {
    kind: "active_cycle",
    cycleId: currentCycleId,
    cycleSequenceNumber: 2,
    reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
  },
  nextCycleSequenceNumber: 3,
  cycleCount: 2,
};
const cycleWithPreviousAction: Cycle = {
  ...cycle,
  sequenceNumber: 2,
  previousCompletedCycleAction: {
    cycleId: "40000000-0000-7000-8000-000000000009",
    cycleSequenceNumber: 1,
    goalVersionNumber: 1,
    action: "通知を切る\n30分集中する",
  },
};
const goalWithPreviousAction: Goal = {
  ...goal,
  currentWork: {
    kind: "active_cycle",
    cycleId: cycleWithPreviousAction.id,
    cycleSequenceNumber: cycleWithPreviousAction.sequenceNumber,
    reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
  },
  nextCycleSequenceNumber: 3,
  cycleCount: 2,
};
const reviewDraftId = "50000000-0000-7000-8000-000000000001";
const activeCycleReplay = {
  replayed: true,
  operation: "complete_cycle",
  resourceIds: { goalId: goal.id, cycleId: cycle.id },
  currentGoalState: "active_cycle",
  currentWorkspace: {
    kind: "active_cycle",
    cycleId: currentCycleId,
    cycleSequenceNumber: 2,
    reviewSchedule: { reviewDate: null, reviewScheduleRevision: 0 },
  },
} as const;
const goalReviewReplay = {
  replayed: true,
  operation: "complete_cycle",
  resourceIds: { goalId: goal.id, cycleId: cycle.id },
  currentGoalState: "goal_review",
  currentWorkspace: {
    kind: "goal_review",
    reviewDraftId,
    triggerCycleId: cycle.id,
    triggerCycleSequenceNumber: 1,
  },
} as const;
const terminalReplay = {
  replayed: true,
  operation: "complete_cycle",
  resourceIds: { goalId: goal.id, cycleId: cycle.id },
  currentGoalState: "ended",
  currentWorkspace: null,
} as const;

const session: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};
const otherUserId = "10000000-0000-7000-8000-000000000002";
const otherGoalId = "20000000-0000-7000-8000-000000000002";

const sessionLease = createCurrentAuthenticatedRequestLease(session.user.id);

function expandFrameTemplates() {
  const toggle = screen.getByRole("button", {
    name: cycleFrameTemplateCopy.toggle,
  });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  return toggle;
}

export function registerGoalWorkspacePageTestLifecycle() {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(getGoal).mockResolvedValue({ goal });
    vi.mocked(getCycle).mockResolvedValue({ cycle });
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraftIfUnchanged).mockImplementation(
      async (userId, subjectKey) => deleteBrowserDraft(userId, subjectKey),
    );
    vi.mocked(clearGoalDrafts).mockResolvedValue(undefined);
    vi.mocked(clearCycleDrafts).mockResolvedValue(undefined);
    vi.mocked(tombstoneDeletedGoalAndClearDrafts).mockResolvedValue(undefined);
    vi.mocked(saveCycleFrame).mockResolvedValue({
      cycleId: cycle.id,
      frame: "plan",
      content: "自動保存後",
      frameRevision: 1,
      contentRevision: 1,
      savedAt: "2026-08-20T00:01:00.000Z",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

async function confirmCycleCompletion() {
  fireEvent.click(await screen.findByRole("tab", { name: /A\s*Action/ }));
  fireEvent.click(screen.getByRole("button", { name: "サイクルを完了" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "サイクルを完了" }),
  );
}

async function invokeCycleTerminalCommand(
  command: "complete" | "terminate" | "delete",
) {
  if (command === "complete") {
    await confirmCycleCompletion();
    return;
  }
  fireEvent.click(await screen.findByText("目標の操作"));
  const label = command === "terminate" ? "目標を終了" : "目標を削除";
  fireEvent.click(screen.getByRole("button", { name: label }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
}

function CacheInspectingHome() {
  const cache = useQueryClient();
  const hasDeletedGoalCache =
    cache.getQueryData(userQueryKeys.goal(session.user.id, goal.id)) !==
      undefined ||
    cache.getQueryData(
      userQueryKeys.cycle(session.user.id, goal.id, cycle.id),
    ) !== undefined;
  return (
    <>
      <p>ホーム</p>
      <p>{hasDeletedGoalCache ? "Goal cache残存" : "Goal cache削除済み"}</p>
    </>
  );
}

function renderPage(
  cache: QueryClient,
  options: {
    readonly canonicalWorkspaceRoute?: boolean;
    readonly commandRouteSwitch?: boolean;
    readonly cleanupSwitchCycleId?: string;
    readonly goalDeletionAdvisory?: GoalDeletionAdvisoryHarness;
    readonly identityQuiesceControl?: boolean;
    readonly sameRouteSwitch?: boolean;
    readonly strictMode?: boolean;
    readonly switchCycleId?: string;
  } = {},
) {
  const goalDeletionAdvisory =
    options.goalDeletionAdvisory ?? createGoalDeletionAdvisoryHarness();
  const tree = (
    <QueryClientProvider client={cache}>
      <AutoSaveScopeProvider>
        <AuthenticatedSessionTestProvider
          lease={sessionLease}
          session={session}
        >
          <FirstUseGuideProvider>
            <GoalDeletionAdvisoryContext.Provider
              value={goalDeletionAdvisory.registry}
            >
              <MemoryRouter
                initialEntries={[
                  options.canonicalWorkspaceRoute
                    ? `/goals/${goal.id}/cycles/${cycle.id}`
                    : `/workspace/${goal.id}/cycles/${cycle.id}`,
                ]}
              >
                {options.identityQuiesceControl ? (
                  <IdentityQuiesceControl />
                ) : null}
                {options.commandRouteSwitch ? (
                  <Link to="/external">コマンド中に外部routeへ移動</Link>
                ) : null}
                {options.sameRouteSwitch ? (
                  <Link
                    to={`/workspace/${goal.id}/cycles/${cycle.id}?refresh=1`}
                  >
                    同じ画面を再表示
                  </Link>
                ) : null}
                {options.cleanupSwitchCycleId ? (
                  <Link
                    to={`/workspace/${goal.id}/cycles/${options.cleanupSwitchCycleId}`}
                  >
                    クリーンアップ中に別のCycleへ移動
                  </Link>
                ) : null}
                <PostCommitCleanupBoundary
                  runSessionOperation={async (_expectedUserId, operation) =>
                    operation(() => true)
                  }
                >
                  {options.switchCycleId ? (
                    <Link
                      to={`/workspace/${goal.id}/cycles/${options.switchCycleId}`}
                    >
                      別のCycleへ移動
                    </Link>
                  ) : null}
                  <Routes>
                    <Route
                      path="/workspace/:goalId/cycles/:cycleId"
                      element={<GoalWorkspacePage />}
                    />
                    <Route path="/" element={<CacheInspectingHome />} />
                    <Route
                      path="/goals/:goalId"
                      element={
                        options.canonicalWorkspaceRoute ? (
                          <GoalWorkspacePage />
                        ) : (
                          <p>現在の目標</p>
                        )
                      }
                    />
                    <Route
                      path="/goals/:goalId/cycles/:cycleId"
                      element={
                        options.canonicalWorkspaceRoute ? (
                          <GoalWorkspacePage />
                        ) : (
                          <p>現在のサイクル</p>
                        )
                      }
                    />
                    <Route
                      path="/goals/:goalId/review"
                      element={<p>現在の目標レビュー</p>}
                    />
                    <Route
                      path="/history/goals/:goalId"
                      element={<p>現在の目標履歴</p>}
                    />
                    <Route path="/external" element={<p>外部route</p>} />
                  </Routes>
                </PostCommitCleanupBoundary>
              </MemoryRouter>
            </GoalDeletionAdvisoryContext.Provider>
          </FirstUseGuideProvider>
        </AuthenticatedSessionTestProvider>
      </AutoSaveScopeProvider>
    </QueryClientProvider>
  );
  return render(options.strictMode ? <StrictMode>{tree}</StrictMode> : tree);
}

type GoalDeletionAdvisoryHarness = {
  readonly registry: GoalDeletionAdvisoryRegistry;
  readonly publish: ReturnType<
    typeof vi.fn<(deletedUserId: string, deletedGoalId: string) => void>
  >;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly dispatch: (deletedUserId: string, deletedGoalId: string) => void;
};

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
  const publish =
    vi.fn<(deletedUserId: string, deletedGoalId: string) => void>();
  const subscribe = vi.fn(
    (userId: string, goalId: string, listener: () => void) => {
      const key = keyOf(userId, goalId);
      const matching = listeners.get(key) ?? new Set();
      matching.add(listener);
      listeners.set(key, matching);
      return () => {
        matching.delete(listener);
        if (matching.size === 0) listeners.delete(key);
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
      const matching = listeners.get(keyOf(deletedUserId, deletedGoalId));
      for (const listener of [...(matching ?? [])]) listener();
    },
  };
}

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

function cycleRevisionConflict() {
  return new APIError(
    409,
    "CYCLE_REVISION_CONFLICT",
    "cycle revision conflict",
    "60000000-0000-7000-8000-000000000001",
  );
}

function deletedGoalError(requestId: string) {
  return new APIError(404, "GOAL_NOT_FOUND", "deleted", requestId);
}

function mockEchoingCycleSave() {
  let revision = 0;
  vi.mocked(saveCycleFrame).mockImplementation(
    async (_lease, _goalId, _cycleId, frame, body) => {
      revision += 1;
      return {
        cycleId: cycle.id,
        frame,
        content: body,
        frameRevision: revision,
        contentRevision: revision,
        savedAt: "2026-09-08T00:01:00.000Z",
      };
    },
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

export {
  activeCycleReplay,
  completableCycle,
  confirmCycleCompletion,
  createGoalDeletionAdvisoryHarness,
  currentCycleId,
  cycle,
  cycleRevisionConflict,
  cycleWithPreviousAction,
  deferred,
  deletedGoalError,
  expandFrameTemplates,
  goal,
  goalReviewReplay,
  goalWithPreviousAction,
  invokeCycleTerminalCommand,
  mockEchoingCycleSave,
  otherGoalId,
  otherUserId,
  renderPage,
  replannedGoal,
  replannedSourceCycle,
  replannedSuccessorCycle,
  reviewDraftId,
  session,
  sessionLease,
  terminalReplay,
};
