import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import {
  useAuthenticatedRequestLease,
  useSession,
} from "../features/auth/sessionContext";
import {
  cacheCycleFrame,
  cacheReview,
  userQueryKeys,
} from "../features/goal-collection/goalCache";
import { APIError } from "../shared/api/client";
import { AutoSaveCoordinator } from "../shared/autosave/autoSaveCoordinator";
import {
  type AutoSaveBrowserOperationQueue,
  useAutoSaveScopeRegistry,
} from "../shared/autosave/AutoSaveScopeProvider";
import type { CurrentWork, Cycle, Frame, Goal } from "../shared/api/schemas";
import {
  completeCycle,
  deleteGoal,
  generateAction,
  getCycle,
  getGoal,
  refineAction,
  saveCycleFrame,
  terminateGoal,
} from "../shared/api/workspace";
import {
  DraftCacheWarning,
  DraftRecoveryNotice,
  PageError,
  PageLoading,
  SaveBadge,
} from "../shared/components/AsyncState";
import { usePostCommitCleanup } from "../shared/cleanup/postCommitCleanupContext";
import { ConfirmationDialog } from "../shared/components/ConfirmationDialog";
import { frameCopy } from "../shared/copy/ja";
import {
  type BrowserDraft,
  clearGoalDrafts,
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import {
  commandFingerprint,
  useCommandOperation,
} from "../shared/hooks/useCommandOperation";
import {
  formatActivePeriod,
  formatCompletedPeriod,
} from "../shared/date/format";
import {
  codePointCount,
  FRAME_TEXT_MAX_CODE_POINTS,
  hasNonWhitespace,
  normalizeBoundedTextInput,
  normalizeLineEndings,
} from "../shared/text/semantics";

const frames: readonly Frame[] = ["plan", "do", "check", "action"];
type Values = Record<Frame, string>;
type CycleSaveResult = Awaited<ReturnType<typeof saveCycleFrame>>;
type PersistedFrameSnapshot = {
  readonly body: string;
  readonly baseRevision: number;
};
type CycleRevisionConflict = {
  readonly failedSnapshot: string;
  readonly baseRevision: number;
};
type MovedWorkspace = {
  readonly currentWorkspace: CurrentWork | null;
};

function preferGoal(current: Goal | undefined, incoming: Goal): Goal {
  return current && current.revision >= incoming.revision ? current : incoming;
}

function preferCycle(current: Cycle | undefined, incoming: Cycle): Cycle {
  if (!current) return incoming;
  const currentTerminal = current.status !== "active";
  const incomingTerminal = incoming.status !== "active";
  if (currentTerminal !== incomingTerminal)
    return currentTerminal ? current : incoming;
  if (currentTerminal && current.status !== incoming.status) return current;
  return current.contentRevision >= incoming.contentRevision
    ? current
    : incoming;
}

function replayWorkspacePath(
  goalId: string,
  currentWorkspace: CurrentWork | null,
): string {
  if (currentWorkspace?.kind === "active_cycle")
    return `/goals/${goalId}/cycles/${currentWorkspace.cycleId}`;
  if (currentWorkspace?.kind === "goal_review")
    return `/goals/${goalId}/review`;
  return `/history/goals/${goalId}`;
}

function isCycleWorkspaceRecoveryError(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.status === 409 &&
    (error.code === "CYCLE_REVISION_CONFLICT" ||
      error.code === "GOAL_STATE_CONFLICT" ||
      error.code === "CYCLE_NOT_ACTIVE")
  );
}

type WorkspaceConfirmation =
  | { readonly kind: "replace-action" }
  | { readonly kind: "complete-cycle" }
  | { readonly kind: "terminate"; readonly outcome: "achieved" | "ended" }
  | { readonly kind: "delete" };

export function GoalWorkspacePage() {
  const session = useSession();
  const sessionLease = useAuthenticatedRequestLease();
  const userId = session.user.id;
  const { goalId, cycleId } = useParams();
  const goalQuery = useQuery({
    queryKey: userQueryKeys.goal(userId, goalId ?? ""),
    queryFn: ({ signal }) => getGoal(sessionLease, goalId ?? "", signal),
    enabled: Boolean(goalId),
  });
  const cycleQuery = useQuery({
    queryKey: userQueryKeys.cycle(userId, goalId ?? "", cycleId ?? ""),
    queryFn: ({ signal }) =>
      getCycle(sessionLease, goalId ?? "", cycleId ?? "", signal),
    enabled: Boolean(goalId && cycleId),
  });
  if (goalQuery.isPending || (cycleId && cycleQuery.isPending))
    return <PageLoading />;
  if (goalQuery.isError)
    return <PageError retry={() => void goalQuery.refetch()} />;
  const goal = goalQuery.data.goal;
  if (!cycleId) {
    if (goal.status === "goal_review")
      return <Navigate to={`/goals/${goal.id}/review`} replace />;
    if (
      goal.status === "active_cycle" &&
      goal.currentWork?.kind === "active_cycle"
    )
      return (
        <Navigate
          to={`/goals/${goal.id}/cycles/${goal.currentWork.cycleId}`}
          replace
        />
      );
    return <Navigate to={`/history/goals/${goal.id}`} replace />;
  }
  if (cycleQuery.isError)
    return <PageError retry={() => void cycleQuery.refetch()} />;
  if (!cycleQuery.data) return <PageLoading />;
  return (
    <CycleWorkspace
      key={`${userId}:${cycleQuery.data.cycle.id}`}
      goal={goal}
      initial={cycleQuery.data.cycle}
    />
  );
}

function CycleWorkspace({
  goal,
  initial,
}: {
  readonly goal: Goal;
  readonly initial: Cycle;
}) {
  const session = useSession();
  const sessionLease = useAuthenticatedRequestLease();
  const userId = session.user.id;
  const navigate = useNavigate();
  const cache = useQueryClient();
  const runPostCommitCleanup = usePostCommitCleanup();
  const cycle = initial;
  const generateOperation = useCommandOperation();
  const refineOperation = useCommandOperation();
  const completeOperation = useCommandOperation();
  const terminateOperation = useCommandOperation();
  const deleteOperation = useCommandOperation();
  const [values, setValues] = useState<Values>({
    plan: initial.plan,
    do: initial.do,
    check: initial.check,
    action: initial.action,
  });
  const [selected, setSelected] = useState<Frame>("plan");
  const [recoveryConflicts, setRecoveryConflicts] = useState<
    ReadonlyMap<Frame, BrowserDraft>
  >(new Map());
  const [movedWorkspace, setMovedWorkspace] = useState<
    MovedWorkspace | undefined
  >();
  const [browserCacheFailed, setBrowserCacheFailed] = useState(false);
  const [aiState, setAIState] = useState<"idle" | "generating" | "refining">(
    "idle",
  );
  const [pendingAction, setPendingAction] = useState(false);
  const [confirmation, setConfirmation] = useState<WorkspaceConfirmation>();
  const [error, setError] = useState<string>();
  const scopeRegistry = useAutoSaveScopeRegistry();
  const scopeKey = ["cycle", userId, goal.id, cycle.id].join(":");
  const lease = useMemo(
    () => scopeRegistry.prepare(scopeKey),
    [scopeKey, scopeRegistry],
  );
  const browserOperationQueueRef = useRef<AutoSaveBrowserOperationQueue>(
    lease.queueBrowserOperation,
  );
  const conflictsRef = useRef(new Map<Frame, BrowserDraft>());
  const movedWorkspaceRef = useRef<MovedWorkspace | undefined>(undefined);
  const cycleRevisionRefreshEpochRef = useRef(0);
  const cycleRevisionRefreshInFlightRef = useRef(new Map<Frame, object>());
  const cycleRevisionConflictsRef = useRef(
    new Map<Frame, CycleRevisionConflict>(),
  );
  const mountedRef = useRef(true);
  const cacheDisabledRef = useRef(false);
  const pendingActionRef = useRef(false);
  const deferredHydrationEditsRef = useRef(new Map<Frame, string>());
  const browserBaseRevisionsRef = useRef(new Map<Frame, number>());
  const editedFramesRef = useRef(new Set<Frame>());
  const initialValuesRef = useRef(values);
  const valuesRef = useRef(values);
  const csrfTokenRef = useRef(session.csrfToken);
  csrfTokenRef.current = session.csrfToken;
  const revisions = useRef({ ...initial.frameRevisions });
  const contentRevision = useRef(initial.contentRevision);
  const persistedFrameSnapshotsRef = useRef(
    new Map<Frame, PersistedFrameSnapshot>(),
  );
  const attemptRevisionsRef = useRef(new WeakMap<AbortSignal, number>());
  const recoverCycleRevisionConflictRef = useRef<
    (
      frame: Frame,
      failedSnapshot: string,
      baseRevision: number,
    ) => Promise<void>
  >(async () => undefined);
  const editable = cycle.status === "active";
  const isActivePage = useCallback(
    () => lease.isCurrent() && mountedRef.current,
    [lease],
  );

  const settleBrowserOperation = useCallback(
    async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
        if (lease.isCurrent() && mountedRef.current)
          setBrowserCacheFailed(false);
      } catch {
        if (lease.isCurrent() && mountedRef.current)
          setBrowserCacheFailed(true);
      }
    },
    [lease],
  );

  const persistFrameDraftRecord = useCallback(
    (frame: Frame, body: string, baseRevision: number): Promise<void> => {
      browserBaseRevisionsRef.current.set(frame, baseRevision);
      if (cacheDisabledRef.current) return Promise.resolve();
      const snapshot: PersistedFrameSnapshot = { body, baseRevision };
      return browserOperationQueueRef
        .current(async () => {
          await putBrowserDraft({
            userId,
            goalId: goal.id,
            subjectKey: "cycle:" + cycle.id + ":" + frame,
            body,
            baseRevision,
            updatedAt: new Date().toISOString(),
          });
          persistedFrameSnapshotsRef.current.set(frame, snapshot);
        })
        .then(() => undefined);
    },
    [cycle.id, goal.id, userId],
  );

  const clearFrameDraftRecord = useCallback(
    (frame: Frame): Promise<void> =>
      browserOperationQueueRef
        .current(async () => {
          if (deferredHydrationEditsRef.current.has(frame)) return;
          const expected = persistedFrameSnapshotsRef.current.get(frame);
          if (!expected) return;
          await deleteBrowserDraftIfUnchanged(
            userId,
            "cycle:" + cycle.id + ":" + frame,
            expected.body,
            expected.baseRevision,
          );
          if (persistedFrameSnapshotsRef.current.get(frame) === expected) {
            persistedFrameSnapshotsRef.current.delete(frame);
            if (
              browserBaseRevisionsRef.current.get(frame) ===
              expected.baseRevision
            )
              browserBaseRevisionsRef.current.delete(frame);
          }
        })
        .then(() => undefined),
    [cycle.id, userId],
  );

  const cacheFrameDraft = useCallback(
    (frame: Frame, body: string, baseRevision: number) =>
      settleBrowserOperation(() =>
        persistFrameDraftRecord(frame, body, baseRevision),
      ),
    [persistFrameDraftRecord, settleBrowserOperation],
  );

  const coordinatorRef = useRef<
    AutoSaveCoordinator<Frame, string, CycleSaveResult> | undefined
  >(undefined);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new AutoSaveCoordinator<
      Frame,
      string,
      CycleSaveResult
    >({
      initialValues: new Map(
        frames.map(
          (frame) => [frame, initialValuesRef.current[frame]] as const,
        ),
      ),
      initiallyHydrating: editable,
      signal: lease.signal,
      isCurrent: lease.isCurrent,
      save: (entry, signal) => {
        const baseRevision = revisions.current[entry.key];
        attemptRevisionsRef.current.set(signal, baseRevision);
        return saveCycleFrame(
          sessionLease,
          goal.id,
          cycle.id,
          entry.key,
          entry.value,
          baseRevision,
          csrfTokenRef.current,
          signal,
        );
      },
      savedValue: (result) => result.content,
      onSaved: (entry, result) => {
        revisions.current[entry.key] = Math.max(
          revisions.current[entry.key],
          result.frameRevision,
        );
        contentRevision.current = Math.max(
          contentRevision.current,
          result.contentRevision,
        );
        browserBaseRevisionsRef.current.delete(entry.key);
        if (valuesRef.current[entry.key] === entry.value) {
          valuesRef.current = {
            ...valuesRef.current,
            [entry.key]: result.content,
          };
          if (mountedRef.current) setValues(valuesRef.current);
        }
        cacheCycleFrame(cache, userId, goal.id, result);
      },
      onError: async (cause, entry, signal) => {
        if (!isCycleWorkspaceRecoveryError(cause)) return "unhandled";
        await recoverCycleRevisionConflictRef.current(
          entry.key,
          entry.value,
          attemptRevisionsRef.current.get(signal) ??
            revisions.current[entry.key],
        );
        return "handled";
      },
      persist: (frame, body) => {
        const baseRevision =
          browserBaseRevisionsRef.current.get(frame) ??
          revisions.current[frame];
        return persistFrameDraftRecord(frame, body, baseRevision);
      },
      clearPersisted: clearFrameDraftRecord,
      onPersistenceStatus: (available) => {
        if (lease.isCurrent() && mountedRef.current)
          setBrowserCacheFailed(!available);
      },
    });
  }
  const coordinator = coordinatorRef.current;
  const hydrationRunRef = useRef<{
    readonly coordinator: typeof coordinator;
    readonly token: symbol;
  } | null>(null);
  const saveState = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getState,
    coordinator.getState,
  );

  const recoverCycleRevisionConflict = useCallback(
    async (
      frame: Frame,
      failedSnapshot: string,
      baseRevision: number,
    ): Promise<void> => {
      if (
        !isActivePage() ||
        movedWorkspaceRef.current ||
        cycleRevisionRefreshInFlightRef.current.has(frame)
      )
        return;
      const refreshToken = {};
      cycleRevisionRefreshInFlightRef.current.set(frame, refreshToken);

      const conflict = cycleRevisionConflictsRef.current.get(frame) ?? {
        failedSnapshot,
        baseRevision,
      };
      cycleRevisionConflictsRef.current.set(frame, conflict);
      browserBaseRevisionsRef.current.set(frame, conflict.baseRevision);
      const refreshEpoch = ++cycleRevisionRefreshEpochRef.current;
      const isCurrentRefresh = () =>
        isActivePage() &&
        movedWorkspaceRef.current === undefined &&
        cycleRevisionRefreshEpochRef.current === refreshEpoch &&
        cycleRevisionConflictsRef.current.get(frame) === conflict;
      const localBeforeRefresh =
        coordinator.getCurrentValue(frame) ?? valuesRef.current[frame];
      coordinator.block(frame, localBeforeRefresh, "CYCLE_REVISION_CONFLICT");

      try {
        await cacheFrameDraft(frame, localBeforeRefresh, conflict.baseRevision);
        if (!isCurrentRefresh()) return;
        if (mountedRef.current) setError(undefined);

        let latestGoal = await getGoal(sessionLease, goal.id, lease.signal);
        if (!isCurrentRefresh()) return;
        const cachedGoal = cache.getQueryData<{ readonly goal: Goal }>(
          userQueryKeys.goal(userId, goal.id),
        );
        const goalBeforeCycle = preferGoal(cachedGoal?.goal, latestGoal.goal);
        const currentWork = goalBeforeCycle.currentWork;
        const currentCycleId =
          currentWork?.kind === "active_cycle" ? currentWork.cycleId : cycle.id;
        const latestCycle = await getCycle(
          sessionLease,
          goal.id,
          currentCycleId,
          lease.signal,
        );
        if (!isCurrentRefresh()) return;
        const cachedCycleBeforeConfirmation = cache.getQueryData<{
          readonly cycle: Cycle;
        }>(userQueryKeys.cycle(userId, goal.id, latestCycle.cycle.id));
        const cycleBeforeGoalConfirmation = preferCycle(
          cachedCycleBeforeConfirmation?.cycle,
          latestCycle.cycle,
        );
        if (
          cycleBeforeGoalConfirmation.status !== "active" &&
          currentWork?.kind === "active_cycle" &&
          currentWork.cycleId === cycleBeforeGoalConfirmation.id
        ) {
          const confirmedGoal = await getGoal(
            sessionLease,
            goal.id,
            lease.signal,
          );
          if (!isCurrentRefresh()) return;
          latestGoal = {
            goal: preferGoal(latestGoal.goal, confirmedGoal.goal),
          };
        }

        if (!isCurrentRefresh()) return;

        let canonicalGoal = latestGoal.goal;
        cache.setQueryData<{ readonly goal: Goal }>(
          userQueryKeys.goal(userId, goal.id),
          (current) => {
            canonicalGoal = preferGoal(current?.goal, canonicalGoal);
            return current?.goal === canonicalGoal
              ? current
              : { goal: canonicalGoal };
          },
        );
        let canonicalCycle = cycleBeforeGoalConfirmation;
        cache.setQueryData<{ readonly cycle: Cycle }>(
          userQueryKeys.cycle(userId, goal.id, latestCycle.cycle.id),
          (current) => {
            canonicalCycle = preferCycle(current?.cycle, canonicalCycle);
            return current?.cycle === canonicalCycle
              ? current
              : { cycle: canonicalCycle };
          },
        );

        const canonicalWorkspace = canonicalGoal.currentWork;
        if (
          canonicalGoal.status !== "active_cycle" ||
          canonicalWorkspace?.kind !== "active_cycle" ||
          canonicalWorkspace.cycleId !== cycle.id ||
          canonicalCycle.id !== cycle.id ||
          canonicalCycle.status !== "active"
        ) {
          const nextMovedWorkspace: MovedWorkspace = {
            currentWorkspace: canonicalWorkspace,
          };
          const runtimeConflicts = new Map(cycleRevisionConflictsRef.current);
          movedWorkspaceRef.current = nextMovedWorkspace;
          coordinator.fail("CYCLE_WORKSPACE_MOVED");
          coordinator.pause(true);
          cycleRevisionRefreshEpochRef.current += 1;
          for (const candidate of frames) {
            const explicitConflict = conflictsRef.current.get(candidate);
            const runtimeConflict = runtimeConflicts.get(candidate);
            const current =
              coordinator.getCurrentValue(candidate) ??
              valuesRef.current[candidate];
            const saved =
              coordinator.getSavedValue(candidate) ??
              initialValuesRef.current[candidate];
            if (current !== saved || explicitConflict || runtimeConflict)
              void cacheFrameDraft(
                candidate,
                current,
                explicitConflict?.baseRevision ??
                  runtimeConflict?.baseRevision ??
                  revisions.current[candidate],
              );
          }
          cacheDisabledRef.current = true;
          coordinator.setPersistenceEnabled(false);
          cycleRevisionConflictsRef.current.clear();
          if (mountedRef.current) {
            setMovedWorkspace(nextMovedWorkspace);
            setError(undefined);
          }
          return;
        }

        const serverCycle = canonicalCycle;
        const previousValues = Object.fromEntries(
          frames.map((candidate) => [
            candidate,
            coordinator.getCurrentValue(candidate) ??
              valuesRef.current[candidate],
          ]),
        ) as Values;
        const previousSaved = Object.fromEntries(
          frames.map((candidate) => [
            candidate,
            coordinator.getSavedValue(candidate) ??
              initialValuesRef.current[candidate],
          ]),
        ) as Values;
        const previousRevisions = { ...revisions.current };
        let nextValues = { ...previousValues };
        const nextConflicts = new Map(conflictsRef.current);

        for (const candidate of frames) {
          const serverBody = serverCycle[candidate];
          const localBody = previousValues[candidate];
          const serverRevision = serverCycle.frameRevisions[candidate];
          const runtimeConflict =
            cycleRevisionConflictsRef.current.get(candidate);
          const existingConflict = nextConflicts.get(candidate);
          const hadLocalChange =
            localBody !== previousSaved[candidate] ||
            existingConflict !== undefined ||
            runtimeConflict !== undefined;

          revisions.current[candidate] = serverRevision;

          if (runtimeConflict) {
            cycleRevisionConflictsRef.current.delete(candidate);
            coordinator.rebase(candidate, serverBody);
            if (
              serverBody === runtimeConflict.failedSnapshot ||
              localBody === serverBody
            ) {
              browserBaseRevisionsRef.current.set(candidate, serverRevision);
              nextConflicts.delete(candidate);
              if (localBody === serverBody) {
                nextValues = { ...nextValues, [candidate]: serverBody };
                coordinator.synchronize(candidate, serverBody);
              } else {
                coordinator.unblock(candidate);
              }
            } else {
              browserBaseRevisionsRef.current.set(
                candidate,
                runtimeConflict.baseRevision,
              );
              const draft: BrowserDraft = {
                userId,
                goalId: goal.id,
                subjectKey: "cycle:" + cycle.id + ":" + candidate,
                body: localBody,
                baseRevision: runtimeConflict.baseRevision,
                updatedAt: new Date().toISOString(),
              };
              nextConflicts.set(candidate, draft);
              coordinator.block(
                candidate,
                localBody,
                "CYCLE_REVISION_CONFLICT",
              );
              void cacheFrameDraft(
                candidate,
                localBody,
                runtimeConflict.baseRevision,
              );
            }
            continue;
          }

          coordinator.rebase(candidate, serverBody);
          if (existingConflict) {
            browserBaseRevisionsRef.current.set(
              candidate,
              existingConflict.baseRevision,
            );
            coordinator.block(candidate, localBody, "CYCLE_REVISION_CONFLICT");
            continue;
          }
          if (!hadLocalChange) {
            browserBaseRevisionsRef.current.set(candidate, serverRevision);
            nextValues = { ...nextValues, [candidate]: serverBody };
            coordinator.synchronize(candidate, serverBody);
          } else if (serverBody !== previousSaved[candidate]) {
            browserBaseRevisionsRef.current.set(
              candidate,
              previousRevisions[candidate],
            );
            const draft: BrowserDraft = {
              userId,
              goalId: goal.id,
              subjectKey: "cycle:" + cycle.id + ":" + candidate,
              body: localBody,
              baseRevision: previousRevisions[candidate],
              updatedAt: new Date().toISOString(),
            };
            nextConflicts.set(candidate, draft);
            coordinator.block(candidate, localBody, "CYCLE_REVISION_CONFLICT");
            void cacheFrameDraft(
              candidate,
              localBody,
              previousRevisions[candidate],
            );
          } else if (localBody === serverBody) {
            browserBaseRevisionsRef.current.set(candidate, serverRevision);
            nextValues = { ...nextValues, [candidate]: serverBody };
            coordinator.synchronize(candidate, serverBody);
          } else {
            browserBaseRevisionsRef.current.set(candidate, serverRevision);
            coordinator.unblock(candidate);
          }
        }

        valuesRef.current = nextValues;
        conflictsRef.current = nextConflicts;
        contentRevision.current = Math.max(
          contentRevision.current,
          serverCycle.contentRevision,
        );
        if (mountedRef.current) {
          setValues(nextValues);
          setRecoveryConflicts(new Map(nextConflicts));
          setError(undefined);
        }
      } catch {
        if (!isCurrentRefresh()) return;
        await cacheFrameDraft(
          frame,
          coordinator.getCurrentValue(frame) ?? valuesRef.current[frame],
          conflict.baseRevision,
        );
        if (!isCurrentRefresh()) return;
        if (mountedRef.current)
          setError(
            "最新の内容を取得できませんでした。入力は保持されています。再試行してください。",
          );
      } finally {
        if (cycleRevisionRefreshInFlightRef.current.get(frame) === refreshToken)
          cycleRevisionRefreshInFlightRef.current.delete(frame);
      }
    },
    [
      cache,
      cacheFrameDraft,
      coordinator,
      cycle.id,
      goal.id,
      isActivePage,
      lease.signal,
      sessionLease,
      userId,
    ],
  );
  recoverCycleRevisionConflictRef.current = recoverCycleRevisionConflict;

  useLayoutEffect(() => {
    lease.activate();
    coordinator.attach();
    const unregister = lease.onQuiesce(
      async ({ preserveDrafts, queueBrowserOperation }) => {
        const previousQueue = browserOperationQueueRef.current;
        browserOperationQueueRef.current = queueBrowserOperation;
        try {
          await coordinator.quiesce(preserveDrafts);
        } finally {
          browserOperationQueueRef.current = previousQueue;
        }
      },
    );
    return () => {
      unregister();
      coordinator.detach();
    };
  }, [coordinator, lease]);

  useEffect(() => {
    mountedRef.current = true;
    const refreshes = cycleRevisionRefreshInFlightRef.current;
    return () => {
      mountedRef.current = false;
      cycleRevisionRefreshEpochRef.current += 1;
      refreshes.clear();
    };
  }, []);

  useEffect(() => {
    if (!editable) return;
    const run = { coordinator, token: Symbol("cycle-hydration") };
    hydrationRunRef.current = run;
    let canceled = false;
    void Promise.all(
      frames.map(async (frame) => {
        try {
          return {
            frame,
            draft: await lease.queueBrowserOperation(() =>
              getBrowserDraft(userId, `cycle:${cycle.id}:${frame}`),
            ),
          };
        } catch {
          return { frame, failed: true as const };
        }
      }),
    )
      .then((results) => {
        if (canceled || !isActivePage() || hydrationRunRef.current !== run)
          return;
        let nextValues = valuesRef.current;
        const nextConflicts = new Map(conflictsRef.current);
        let cacheReadFailed = false;
        for (const item of results) {
          if ("failed" in item) {
            cacheReadFailed = true;
            continue;
          }
          const { draft: loadedDraft, frame } = item;
          if (!loadedDraft) continue;
          persistedFrameSnapshotsRef.current.set(frame, {
            body: loadedDraft.body,
            baseRevision: loadedDraft.baseRevision,
          });
          if (editedFramesRef.current.has(frame)) {
            browserBaseRevisionsRef.current.set(
              frame,
              revisions.current[frame],
            );
            continue;
          }
          browserBaseRevisionsRef.current.set(frame, loadedDraft.baseRevision);
          const canonicalBody = normalizeLineEndings(loadedDraft.body);
          const draft =
            canonicalBody === loadedDraft.body
              ? loadedDraft
              : { ...loadedDraft, body: canonicalBody };
          if (canonicalBody !== loadedDraft.body)
            void cacheFrameDraft(
              frame,
              canonicalBody,
              loadedDraft.baseRevision,
            );
          nextValues = { ...nextValues, [frame]: draft.body };
          if (draft.baseRevision === revisions.current[frame]) {
            if (
              draft.body !==
              (coordinator.getSavedValue(frame) ??
                initialValuesRef.current[frame])
            ) {
              if (pendingActionRef.current)
                deferredHydrationEditsRef.current.set(frame, draft.body);
              else coordinator.edit(frame, draft.body);
            } else coordinator.synchronize(frame, draft.body);
          } else {
            nextConflicts.set(frame, draft);
            coordinator.block(frame, draft.body, "CYCLE_REVISION_CONFLICT");
          }
        }
        valuesRef.current = nextValues;
        conflictsRef.current = nextConflicts;
        if (mountedRef.current) {
          setValues(nextValues);
          setRecoveryConflicts(new Map(nextConflicts));
        }
        if (cacheReadFailed && mountedRef.current) setBrowserCacheFailed(true);
      })
      .finally(() => {
        const active = hydrationRunRef.current;
        if (active?.coordinator !== coordinator || active.token === run.token)
          coordinator.finishHydration();
      });
    return () => {
      canceled = true;
    };
  }, [
    cacheFrameDraft,
    coordinator,
    cycle.id,
    editable,
    isActivePage,
    lease,
    userId,
  ]);

  useEffect(() => {
    const handleOnline = () => {
      if (movedWorkspaceRef.current) return;
      if (cycleRevisionConflictsRef.current.size) {
        for (const [frame, conflict] of cycleRevisionConflictsRef.current)
          void recoverCycleRevisionConflict(
            frame,
            conflict.failedSnapshot,
            conflict.baseRevision,
          );
        return;
      }
      coordinator.online();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [coordinator, recoverCycleRevisionConflict]);

  function change(frame: Frame, value: string) {
    if (
      movedWorkspaceRef.current ||
      conflictsRef.current.has(frame) ||
      pendingActionRef.current
    )
      return;
    const normalizedValue = normalizeBoundedTextInput(
      value,
      FRAME_TEXT_MAX_CODE_POINTS,
    );
    if (normalizedValue === null) return;
    editedFramesRef.current.add(frame);
    valuesRef.current = { ...valuesRef.current, [frame]: normalizedValue };
    setValues(valuesRef.current);
    coordinator.edit(frame, normalizedValue);
  }

  function flush(frame: Frame) {
    if (
      movedWorkspaceRef.current ||
      conflictsRef.current.has(frame) ||
      pendingActionRef.current
    )
      return;
    coordinator.flush(frame);
  }

  function selectFrame(frame: Frame) {
    if (frame === selected) return;
    flush(selected);
    setSelected(frame);
  }

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    frame: Frame,
  ) {
    const index = frames.indexOf(frame);
    let next: Frame | undefined;
    if (event.key === "ArrowRight") next = frames[(index + 1) % frames.length];
    else if (event.key === "ArrowLeft")
      next = frames[(index - 1 + frames.length) % frames.length];
    else if (event.key === "Home") next = frames[0];
    else if (event.key === "End") next = frames.at(-1);
    if (!next) return;
    event.preventDefault();
    selectFrame(next);
    window.setTimeout(() => document.getElementById(`tab-${next}`)?.focus(), 0);
  }

  function retrySave() {
    if (movedWorkspaceRef.current || conflictsRef.current.size) return;
    if (cycleRevisionConflictsRef.current.size) {
      for (const [frame, conflict] of cycleRevisionConflictsRef.current)
        void recoverCycleRevisionConflict(
          frame,
          conflict.failedSnapshot,
          conflict.baseRevision,
        );
      return;
    }
    coordinator.retry();
  }

  function restoreRecovery(frame: Frame) {
    if (movedWorkspaceRef.current) return;
    const draft = conflictsRef.current.get(frame);
    if (!draft) return;
    const nextConflicts = new Map(conflictsRef.current);
    nextConflicts.delete(frame);
    conflictsRef.current = nextConflicts;
    setRecoveryConflicts(new Map(nextConflicts));
    editedFramesRef.current.add(frame);
    browserBaseRevisionsRef.current.set(frame, revisions.current[frame]);
    if (
      draft.body ===
      (coordinator.getSavedValue(frame) ?? initialValuesRef.current[frame])
    )
      coordinator.synchronize(frame, draft.body);
    else coordinator.unblock(frame);
  }

  function discardRecovery(frame: Frame) {
    if (movedWorkspaceRef.current) return;
    if (!conflictsRef.current.has(frame)) return;
    const nextConflicts = new Map(conflictsRef.current);
    nextConflicts.delete(frame);
    conflictsRef.current = nextConflicts;
    setRecoveryConflicts(new Map(nextConflicts));
    const saved =
      coordinator.getSavedValue(frame) ?? initialValuesRef.current[frame];
    valuesRef.current = {
      ...valuesRef.current,
      [frame]: saved,
    };
    setValues(valuesRef.current);
    browserBaseRevisionsRef.current.set(frame, revisions.current[frame]);
    coordinator.synchronize(frame, saved);
  }

  function pauseSaves() {
    cycleRevisionRefreshEpochRef.current += 1;
    cycleRevisionRefreshInFlightRef.current.clear();
    coordinator.pause(true);
  }

  function resumeSaves() {
    if (movedWorkspaceRef.current) return;
    pendingActionRef.current = false;
    setPendingAction(false);
    cacheDisabledRef.current = false;
    coordinator.setPersistenceEnabled(true);
    coordinator.resume();
    const deferredHydrationEdits = new Map(deferredHydrationEditsRef.current);
    for (const [frame, body] of deferredHydrationEdits) {
      browserBaseRevisionsRef.current.set(frame, revisions.current[frame]);
      editedFramesRef.current.add(frame);
      coordinator.edit(frame, body);
      deferredHydrationEditsRef.current.delete(frame);
    }
    if (cycleRevisionConflictsRef.current.size) {
      for (const [frame, conflict] of cycleRevisionConflictsRef.current)
        void recoverCycleRevisionConflict(
          frame,
          conflict.failedSnapshot,
          conflict.baseRevision,
        );
    }
  }

  function applyAI(
    action: string,
    actionRevision: number,
    nextContentRevision: number,
  ) {
    editedFramesRef.current.add("action");
    valuesRef.current = { ...valuesRef.current, action };
    setValues(valuesRef.current);
    revisions.current.action = Math.max(
      revisions.current.action,
      actionRevision,
    );
    contentRevision.current = Math.max(
      contentRevision.current,
      nextContentRevision,
    );
    cacheCycleFrame(cache, userId, goal.id, {
      cycleId: cycle.id,
      frame: "action",
      content: action,
      frameRevision: actionRevision,
      contentRevision: nextContentRevision,
    });
    cycleRevisionConflictsRef.current.delete("action");
    const nextConflicts = new Map(conflictsRef.current);
    nextConflicts.delete("action");
    conflictsRef.current = nextConflicts;
    setRecoveryConflicts(new Map(nextConflicts));
    coordinator.synchronize("action", action);
  }
  const allPDC = [values.plan, values.do, values.check].every(hasNonWhitespace);
  const allFrames = allPDC && hasNonWhitespace(values.action);
  const aiReady =
    saveState.kind === "saved" && aiState === "idle" && !pendingAction;
  function requestAI(kind: "generating" | "refining") {
    if (
      !isActivePage() ||
      pendingActionRef.current ||
      movedWorkspaceRef.current ||
      saveState.kind !== "saved" ||
      aiState !== "idle" ||
      (kind === "generating" ? !allPDC : !allFrames)
    )
      return;
    if (kind === "generating" && hasNonWhitespace(values.action)) {
      setConfirmation({ kind: "replace-action" });
      return;
    }
    void runAI(kind, false);
  }
  async function runAI(
    kind: "generating" | "refining",
    confirmReplace: boolean,
  ) {
    if (
      !isActivePage() ||
      pendingActionRef.current ||
      movedWorkspaceRef.current
    )
      return;
    const sourcePDC = JSON.stringify([
      valuesRef.current.plan,
      valuesRef.current.do,
      valuesRef.current.check,
    ]);
    setAIState(kind);
    setError(undefined);
    try {
      const expectedContentRevision = contentRevision.current;
      const result =
        kind === "generating"
          ? await generateOperation.invoke(
              commandFingerprint("action_generate", {
                goalId: goal.id,
                cycleId: cycle.id,
                expectedContentRevision,
                confirmReplace,
              }),
              (operationId) =>
                generateAction(
                  sessionLease,
                  goal.id,
                  cycle.id,
                  expectedContentRevision,
                  confirmReplace,
                  {
                    operationId,
                    csrfToken: session.csrfToken,
                  },
                ),
            )
          : await refineOperation.invoke(
              commandFingerprint("action_refine", {
                goalId: goal.id,
                cycleId: cycle.id,
                expectedContentRevision,
              }),
              (operationId) =>
                refineAction(
                  sessionLease,
                  goal.id,
                  cycle.id,
                  expectedContentRevision,
                  {
                    operationId,
                    csrfToken: session.csrfToken,
                  },
                ),
            );
      if (!isActivePage()) return;
      if (
        result.action === undefined ||
        result.actionRevision === undefined ||
        result.contentRevision === undefined
      )
        throw new Error("invalid AI response");
      applyAI(result.action, result.actionRevision, result.contentRevision);
      if (
        result.contextChanged ||
        sourcePDC !==
          JSON.stringify([
            valuesRef.current.plan,
            valuesRef.current.do,
            valuesRef.current.check,
          ])
      )
        setError(
          "AI処理中にP/D/Cが変更されています。必要に応じて再生成してください。",
        );
    } catch {
      if (isActivePage())
        setError("AI処理を完了できませんでした。現在のAは保持されています。");
    } finally {
      if (isActivePage()) setAIState("idle");
    }
  }

  function startTerminalCommand(): boolean {
    if (
      !isActivePage() ||
      pendingActionRef.current ||
      movedWorkspaceRef.current
    )
      return false;
    pendingActionRef.current = true;
    setPendingAction(true);
    setError(undefined);
    pauseSaves();
    return true;
  }

  async function finish() {
    if (!allFrames || !aiReady || !startTerminalCommand()) return;
    try {
      const expectedGoalRevision = goal.revision;
      const expectedContentRevision = contentRevision.current;
      const result = await completeOperation.invoke(
        commandFingerprint("cycle_complete", {
          goalId: goal.id,
          cycleId: cycle.id,
          expectedContentRevision,
          expectedGoalRevision,
        }),
        (operationId) =>
          completeCycle(
            sessionLease,
            goal.id,
            cycle.id,
            expectedGoalRevision,
            expectedContentRevision,
            {
              operationId,
              csrfToken: session.csrfToken,
            },
          ),
      );
      if (!isActivePage()) return;
      void runPostCommitCleanup({
        expectedUserId: userId,
        cleanup: async () => {
          for (const frame of frames)
            await deleteBrowserDraft(userId, "cycle:" + cycle.id + ":" + frame);
        },
        onSuccess: async (identityIsCurrent) => {
          await cache.invalidateQueries({
            queryKey: userQueryKeys.root(userId),
            refetchType: "none",
          });
          if (!identityIsCurrent()) return;
          if ("goal" in result) {
            cacheReview(cache, userId, {
              goal: result.goal,
              reviewDraft: result.reviewDraft,
              triggerCycle: result.completedCycle,
            });
            navigate(`/goals/${goal.id}/review`, { replace: true });
            return;
          }
          await cache
            .refetchQueries({
              queryKey: userQueryKeys.goal(userId, goal.id),
              exact: true,
            })
            .catch(() => undefined);
          if (!identityIsCurrent()) return;
          navigate(replayWorkspacePath(goal.id, result.currentWorkspace), {
            replace: true,
          });
        },
        pendingMessage: "この端末のサイクル下書きを削除しています…",
        failureMessage:
          "サイクルは完了しましたが、この端末の復旧用保存を削除できませんでした。",
        retryLabel: "端末データの削除を再試行",
      });
    } catch {
      if (!isActivePage()) return;
      resumeSaves();
      setError("サイクルを完了できませんでした。入力内容を確認してください。");
    }
  }

  async function terminate(outcome: "achieved" | "ended") {
    const wording = outcome === "achieved" ? "達成として終了" : "終了";
    if (
      saveState.kind !== "saved" ||
      aiState !== "idle" ||
      !startTerminalCommand()
    )
      return;
    try {
      const expectedContentRevision = contentRevision.current;
      await terminateOperation.invoke(
        commandFingerprint("goal_terminate", {
          goalId: goal.id,
          outcome,
          expectedGoalRevision: goal.revision,
          expectedState: "active_cycle",
          activeCycleId: cycle.id,
          expectedCycleContentRevision: expectedContentRevision,
        }),
        (operationId) =>
          terminateGoal(
            sessionLease,
            goal.id,
            outcome,
            goal.revision,
            "active_cycle",
            {
              operationId,
              csrfToken: session.csrfToken,
            },
            { id: cycle.id, revision: expectedContentRevision },
          ),
      );
      if (!isActivePage()) return;
      void runPostCommitCleanup({
        expectedUserId: userId,
        cleanup: () => clearGoalDrafts(userId, goal.id),
        onSuccess: async (identityIsCurrent) => {
          await cache.invalidateQueries({
            queryKey: userQueryKeys.root(userId),
            refetchType: "none",
          });
          if (!identityIsCurrent()) return;
          navigate("/", { replace: true });
        },
        pendingMessage: "この端末の目標下書きを削除しています…",
        failureMessage:
          "目標の終了は完了しましたが、この端末の復旧用保存を削除できませんでした。",
        retryLabel: "端末データの削除を再試行",
      });
    } catch {
      if (!isActivePage()) return;
      resumeSaves();
      setError(`目標を${wording}できませんでした。`);
    }
  }

  async function remove() {
    if (!startTerminalCommand()) return;
    try {
      await deleteOperation.invoke(
        commandFingerprint("goal_delete", {
          goalId: goal.id,
          expectedGoalRevision: goal.revision,
        }),
        (operationId) =>
          deleteGoal(sessionLease, goal.id, goal.revision, {
            operationId,
            csrfToken: session.csrfToken,
          }),
      );
      if (!isActivePage()) return;
      void runPostCommitCleanup({
        expectedUserId: userId,
        cleanup: () => clearGoalDrafts(userId, goal.id),
        onSuccess: async (identityIsCurrent) => {
          await cache.invalidateQueries({
            queryKey: userQueryKeys.root(userId),
            refetchType: "none",
          });
          if (!identityIsCurrent()) return;
          navigate("/", { replace: true });
        },
        pendingMessage: "この端末の目標下書きを削除しています…",
        failureMessage:
          "目標は削除されましたが、この端末の復旧用保存を削除できませんでした。",
        retryLabel: "端末データの削除を再試行",
      });
    } catch {
      if (!isActivePage()) return;
      resumeSaves();
      setError("目標を削除できませんでした。");
    }
  }
  const copy = frameCopy[selected];
  const selectedConflict = recoveryConflicts.get(selected);
  const workspaceMoved = movedWorkspace !== undefined;
  const end = cycle.completedAt ?? cycle.canceledAt;
  return (
    <main className="page editor-page">
      <header className="goal-context">
        <span className="eyebrow">目標</span>
        <h1>{cycle.goalVersion.body}</h1>
        <p>
          Goal v{cycle.goalVersion.versionNumber} · Cycle {cycle.sequenceNumber}
        </p>
        <p>
          {end
            ? formatCompletedPeriod(cycle.startedAt, end)
            : formatActivePeriod(cycle.startedAt)}
        </p>
      </header>
      <div className="frame-tabs" role="tablist" aria-label="PDCAフレーム">
        {frames.map((frame) => (
          <button
            key={frame}
            id={`tab-${frame}`}
            role="tab"
            aria-selected={selected === frame}
            aria-controls="frame-panel"
            tabIndex={selected === frame ? 0 : -1}
            onClick={() => selectFrame(frame)}
            onKeyDown={(event) => handleTabKeyDown(event, frame)}
          >
            <span>{frameCopy[frame].label}</span>
            <small>
              {frameCopy[frame].name}
              {recoveryConflicts.has(frame) ? " · 要確認" : ""}
            </small>
          </button>
        ))}
      </div>
      <section
        id="frame-panel"
        className="editor-card"
        role="tabpanel"
        aria-labelledby={`tab-${selected}`}
      >
        {!workspaceMoved && selectedConflict && (
          <DraftRecoveryNotice
            onRestore={() => restoreRecovery(selected)}
            onDiscard={() => discardRecovery(selected)}
          />
        )}
        {movedWorkspace && (
          <div className="draft-notice draft-notice--conflict" role="alert">
            <div>
              <strong>現在の作業状態が更新されました</strong>
              <p>この端末の入力は保持されています。</p>
            </div>
            <div className="button-row">
              <Link
                className="button button--primary"
                replace
                to={replayWorkspacePath(
                  goal.id,
                  movedWorkspace.currentWorkspace,
                )}
              >
                現在の作業へ移動
              </Link>
            </div>
          </div>
        )}
        {browserCacheFailed && <DraftCacheWarning />}
        <div className="frame-title">
          <span aria-hidden="true">{copy.label}</span>
          <h2>
            <label htmlFor="cycle-frame-editor">{copy.name}</label>
          </h2>
        </div>
        <p className="frame-guide" id="cycle-frame-guide">
          {copy.guide}
        </p>
        <textarea
          id="cycle-frame-editor"
          aria-label={`${copy.label} — ${copy.name}`}
          aria-describedby="cycle-frame-guide"
          aria-readonly={
            workspaceMoved ||
            !editable ||
            Boolean(selectedConflict) ||
            pendingAction ||
            (selected === "action" && aiState !== "idle")
          }
          value={values[selected]}
          placeholder={copy.placeholder}
          readOnly={
            workspaceMoved ||
            !editable ||
            Boolean(selectedConflict) ||
            pendingAction ||
            (selected === "action" && aiState !== "idle")
          }
          onChange={(event) => change(selected, event.target.value)}
          onBlur={() => flush(selected)}
        />
        <div className="editor-meta">
          {editable && !workspaceMoved ? (
            <SaveBadge
              state={saveState}
              retry={recoveryConflicts.size ? undefined : retrySave}
            />
          ) : (
            <span className="read-only-badge">読み取り専用</span>
          )}
          <span>
            {codePointCount(values[selected])} / {FRAME_TEXT_MAX_CODE_POINTS}
          </span>
        </div>
        {editable && !workspaceMoved && selected === "action" && (
          <div className="action-controls">
            <button
              className="button button--secondary"
              type="button"
              disabled={!allPDC || !aiReady}
              onClick={() => requestAI("generating")}
            >
              {aiState === "generating"
                ? "生成しています…"
                : "アクションを生成"}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={!allFrames || !aiReady}
              onClick={() => requestAI("refining")}
            >
              {aiState === "refining" ? "推敲しています…" : "AIで推敲"}
            </button>
            <button
              className="button button--primary"
              type="button"
              disabled={!allFrames || !aiReady || pendingAction}
              onClick={() => setConfirmation({ kind: "complete-cycle" })}
            >
              サイクルを完了
            </button>
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </section>
      {editable && !workspaceMoved && (
        <details className="goal-actions">
          <summary>目標の操作</summary>
          <div className="button-row">
            <button
              type="button"
              disabled={
                saveState.kind !== "saved" ||
                aiState !== "idle" ||
                pendingAction
              }
              onClick={() =>
                setConfirmation({ kind: "terminate", outcome: "achieved" })
              }
            >
              目標を達成として終了
            </button>
            <button
              type="button"
              disabled={
                saveState.kind !== "saved" ||
                aiState !== "idle" ||
                pendingAction
              }
              onClick={() =>
                setConfirmation({ kind: "terminate", outcome: "ended" })
              }
            >
              目標を終了
            </button>
            <button
              className="danger-link"
              type="button"
              disabled={pendingAction}
              onClick={() => setConfirmation({ kind: "delete" })}
            >
              目標を削除
            </button>
          </div>
        </details>
      )}
      {confirmation?.kind === "replace-action" && (
        <ConfirmationDialog
          title="現在のAを置き換えますか？"
          confirmLabel="AIで置き換える"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            setConfirmation(undefined);
            void runAI("generating", true);
          }}
        >
          <p>現在のAをAI生成結果で置き換えます。</p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "complete-cycle" && (
        <ConfirmationDialog
          title="サイクルを完了しますか？"
          confirmLabel="サイクルを完了"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            setConfirmation(undefined);
            void finish();
          }}
        >
          <p>このサイクルを完了し、目標の見直しへ進みます。</p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "terminate" && (
        <ConfirmationDialog
          title={`目標を${
            confirmation.outcome === "achieved" ? "達成として終了" : "終了"
          }しますか？`}
          confirmLabel={
            confirmation.outcome === "achieved" ? "目標を達成" : "目標を終了"
          }
          confirmTone="danger"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            const { outcome } = confirmation;
            setConfirmation(undefined);
            void terminate(outcome);
          }}
        >
          <p>現在のCycleはCanceledの読み取り専用履歴として残ります。</p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "delete" && (
        <ConfirmationDialog
          title="目標を削除しますか？"
          confirmLabel="目標を削除"
          confirmTone="danger"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            setConfirmation(undefined);
            void remove();
          }}
        >
          <p>
            この目標とすべてのCycle履歴を完全に削除します。この操作は取り消せません。
          </p>
        </ConfirmationDialog>
      )}
    </main>
  );
}
