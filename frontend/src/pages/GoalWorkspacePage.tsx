import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import {
  cacheCycleFrame,
  cacheReview,
  userQueryKeys,
} from "../features/goal-collection/goalCache";
import { APIError } from "../shared/api/client";
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
import { ConfirmationDialog } from "../shared/components/ConfirmationDialog";
import { frameCopy } from "../shared/copy/ja";
import {
  type BrowserDraft,
  clearGoalDrafts,
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import {
  autoSaveDebounceMs,
  autoSaveRetryDelay,
  browserDraftDebounceMs,
  isRetryableAutoSaveError,
  maxAutoSaveRetries,
} from "../shared/hooks/autoSavePolicy";
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
type SaveState = "dirty" | "saving" | "saved" | "failed";
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

function isCycleRevisionConflict(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.status === 409 &&
    error.code === "CYCLE_REVISION_CONFLICT"
  );
}

type WorkspaceConfirmation =
  | { readonly kind: "replace-action" }
  | { readonly kind: "complete-cycle" }
  | { readonly kind: "terminate"; readonly outcome: "achieved" | "ended" }
  | { readonly kind: "delete" };

export function GoalWorkspacePage() {
  const session = useSession();
  const userId = session.user.id;
  const { goalId, cycleId } = useParams();
  const goalQuery = useQuery({
    queryKey: userQueryKeys.goal(userId, goalId ?? ""),
    queryFn: () => getGoal(goalId ?? ""),
    enabled: Boolean(goalId),
  });
  const cycleQuery = useQuery({
    queryKey: userQueryKeys.cycle(userId, goalId ?? "", cycleId ?? ""),
    queryFn: () => getCycle(goalId ?? "", cycleId ?? ""),
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
      key={cycleQuery.data.cycle.id}
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
  const userId = session.user.id;
  const navigate = useNavigate();
  const cache = useQueryClient();
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
  const [saveState, setSaveState] = useState<SaveState>("saved");
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
  const pending = useRef(new Map<Frame, string>());
  const conflictsRef = useRef(new Map<Frame, BrowserDraft>());
  const movedWorkspaceRef = useRef<MovedWorkspace | undefined>(undefined);
  const cycleRevisionRefreshEpochRef = useRef(0);
  const cycleRevisionRefreshInFlightRef = useRef(new Map<Frame, object>());
  const cycleRevisionConflictsRef = useRef(
    new Map<Frame, CycleRevisionConflict>(),
  );
  const saveInFlightRef = useRef(false);
  const savesPausedRef = useRef(false);
  const disposedRef = useRef(false);
  const mountedRef = useRef(true);
  const cacheDisabledRef = useRef(false);
  const editedFramesRef = useRef(new Set<Frame>());
  const inputVersionRef = useRef(0);
  const frameEditVersionsRef = useRef<Record<Frame, number>>({
    plan: 0,
    do: 0,
    check: 0,
    action: 0,
  });
  const retryCountRef = useRef(0);
  const lastInputAtRef = useRef(0);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const browserTimersRef = useRef(new Map<Frame, number>());
  const pumpRef = useRef<() => Promise<void>>(async () => undefined);
  const drainDetachedRef = useRef<() => Promise<void>>(async () => undefined);
  const browserQueueRef = useRef(Promise.resolve());
  const valuesRef = useRef(values);
  const savedValuesRef = useRef<Values>({ ...values });
  const revisions = useRef({ ...initial.frameRevisions });
  const contentRevision = useRef(initial.contentRevision);
  const editable = cycle.status === "active";

  const updateSaveState = useCallback((next: SaveState) => {
    if (mountedRef.current) setSaveState(next);
  }, []);

  const queueBrowserOperation = useCallback(
    (operation: () => Promise<void>): Promise<void> => {
      const settled = browserQueueRef.current.then(operation).then(
        () => {
          if (mountedRef.current) setBrowserCacheFailed(false);
        },
        () => {
          if (mountedRef.current) setBrowserCacheFailed(true);
        },
      );
      browserQueueRef.current = settled;
      return settled;
    },
    [],
  );

  const deleteFrameDraft = useCallback(
    (frame: Frame) =>
      queueBrowserOperation(() =>
        deleteBrowserDraft(userId, `cycle:${cycle.id}:${frame}`),
      ),
    [cycle.id, queueBrowserOperation, userId],
  );

  const cacheFrameDraft = useCallback(
    (frame: Frame, body: string, baseRevision: number) => {
      if (cacheDisabledRef.current) return Promise.resolve();
      return queueBrowserOperation(() =>
        putBrowserDraft({
          userId,
          goalId: goal.id,
          subjectKey: `cycle:${cycle.id}:${frame}`,
          body,
          baseRevision,
          updatedAt: new Date().toISOString(),
        }),
      );
    },
    [cycle.id, goal.id, queueBrowserOperation, userId],
  );

  const clearGoalDraftCache = useCallback(
    () => queueBrowserOperation(() => clearGoalDrafts(userId, goal.id)),
    [goal.id, queueBrowserOperation, userId],
  );

  const persistFrameDraft = useCallback(
    (frame: Frame) => {
      if (conflictsRef.current.has(frame) || cacheDisabledRef.current)
        return Promise.resolve();
      return valuesRef.current[frame] === savedValuesRef.current[frame]
        ? deleteFrameDraft(frame)
        : cacheFrameDraft(
            frame,
            valuesRef.current[frame],
            revisions.current[frame],
          );
    },
    [cacheFrameDraft, deleteFrameDraft],
  );

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
  }, []);

  const clearBrowserTimer = useCallback((frame: Frame) => {
    const timer = browserTimersRef.current.get(frame);
    if (timer !== undefined) window.clearTimeout(timer);
    browserTimersRef.current.delete(frame);
  }, []);

  const hasSavablePending = useCallback(
    () =>
      Array.from(pending.current.keys()).some(
        (frame) =>
          !conflictsRef.current.has(frame) &&
          !cycleRevisionConflictsRef.current.has(frame),
      ),
    [],
  );

  const schedulePump = useCallback(
    (delay: number) => {
      clearSaveTimer();
      if (
        !editable ||
        savesPausedRef.current ||
        disposedRef.current ||
        !hasSavablePending()
      )
        return;
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = undefined;
        void pumpRef.current();
      }, delay);
    },
    [clearSaveTimer, editable, hasSavablePending],
  );

  const scheduleBrowserDraft = useCallback(
    (frame: Frame) => {
      clearBrowserTimer(frame);
      if (conflictsRef.current.has(frame) || cacheDisabledRef.current) return;
      const timer = window.setTimeout(() => {
        browserTimersRef.current.delete(frame);
        void persistFrameDraft(frame);
      }, browserDraftDebounceMs);
      browserTimersRef.current.set(frame, timer);
    },
    [clearBrowserTimer, persistFrameDraft],
  );

  const firstPendingEntry = useCallback(():
    | readonly [Frame, string]
    | undefined => {
    for (const entry of pending.current) {
      if (
        !conflictsRef.current.has(entry[0]) &&
        !cycleRevisionConflictsRef.current.has(entry[0])
      )
        return entry;
    }
    return undefined;
  }, []);

  const recoverCycleRevisionConflict = useCallback(
    async (
      frame: Frame,
      failedSnapshot: string,
      baseRevision: number,
    ): Promise<void> => {
      if (
        disposedRef.current ||
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
      const refreshEpoch = ++cycleRevisionRefreshEpochRef.current;
      const isCurrentRefresh = () =>
        !disposedRef.current &&
        movedWorkspaceRef.current === undefined &&
        cycleRevisionRefreshEpochRef.current === refreshEpoch &&
        cycleRevisionConflictsRef.current.get(frame) === conflict;
      const localBeforeRefresh = valuesRef.current[frame];
      pending.current.set(frame, localBeforeRefresh);
      clearBrowserTimer(frame);

      try {
        await cacheFrameDraft(frame, localBeforeRefresh, conflict.baseRevision);
        if (!isCurrentRefresh()) return;
        if (mountedRef.current) setError(undefined);

        let latestGoal = await getGoal(goal.id);
        if (!isCurrentRefresh()) return;
        const cachedGoal = cache.getQueryData<{ readonly goal: Goal }>(
          userQueryKeys.goal(userId, goal.id),
        );
        const goalBeforeCycle = preferGoal(cachedGoal?.goal, latestGoal.goal);
        const currentWork = goalBeforeCycle.currentWork;
        const currentCycleId =
          currentWork?.kind === "active_cycle" ? currentWork.cycleId : cycle.id;
        const latestCycle = await getCycle(goal.id, currentCycleId);
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
          const confirmedGoal = await getGoal(goal.id);
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
          savesPausedRef.current = true;
          clearSaveTimer();
          retryCountRef.current = 0;
          cycleRevisionRefreshEpochRef.current += 1;
          for (const candidate of frames) {
            clearBrowserTimer(candidate);
            const explicitConflict = conflictsRef.current.get(candidate);
            const runtimeConflict = runtimeConflicts.get(candidate);
            if (
              pending.current.has(candidate) ||
              valuesRef.current[candidate] !==
                savedValuesRef.current[candidate] ||
              explicitConflict ||
              runtimeConflict
            )
              void cacheFrameDraft(
                candidate,
                valuesRef.current[candidate],
                explicitConflict?.baseRevision ??
                  runtimeConflict?.baseRevision ??
                  revisions.current[candidate],
              );
          }
          cacheDisabledRef.current = true;
          cycleRevisionConflictsRef.current.clear();
          if (mountedRef.current) {
            setMovedWorkspace(nextMovedWorkspace);
            setError(undefined);
          }
          updateSaveState("failed");
          return;
        }

        const serverCycle = canonicalCycle;
        const previousValues = valuesRef.current;
        const previousSaved = savedValuesRef.current;
        const previousRevisions = { ...revisions.current };
        let nextValues = { ...previousValues };
        const nextSaved = { ...previousSaved };
        const nextConflicts = new Map(conflictsRef.current);

        for (const candidate of frames) {
          const serverBody = serverCycle[candidate];
          const localBody = previousValues[candidate];
          const serverRevision = serverCycle.frameRevisions[candidate];
          const runtimeConflict =
            cycleRevisionConflictsRef.current.get(candidate);
          const existingConflict = nextConflicts.get(candidate);
          const hadLocalChange =
            pending.current.has(candidate) ||
            localBody !== previousSaved[candidate] ||
            existingConflict !== undefined;

          revisions.current[candidate] = serverRevision;
          nextSaved[candidate] = serverBody;

          if (runtimeConflict) {
            cycleRevisionConflictsRef.current.delete(candidate);
            if (
              serverBody === runtimeConflict.failedSnapshot ||
              localBody === serverBody
            ) {
              nextConflicts.delete(candidate);
              if (localBody === serverBody) {
                pending.current.delete(candidate);
                nextValues = { ...nextValues, [candidate]: serverBody };
                void deleteFrameDraft(candidate);
              } else {
                pending.current.set(candidate, localBody);
                void cacheFrameDraft(candidate, localBody, serverRevision);
              }
            } else {
              const draft: BrowserDraft = {
                userId,
                goalId: goal.id,
                subjectKey: `cycle:${cycle.id}:${candidate}`,
                body: localBody,
                baseRevision: runtimeConflict.baseRevision,
                updatedAt: new Date().toISOString(),
              };
              nextConflicts.set(candidate, draft);
              pending.current.set(candidate, localBody);
              void cacheFrameDraft(
                candidate,
                localBody,
                runtimeConflict.baseRevision,
              );
            }
            continue;
          }

          if (existingConflict) continue;
          if (!hadLocalChange) {
            pending.current.delete(candidate);
            nextValues = { ...nextValues, [candidate]: serverBody };
            void deleteFrameDraft(candidate);
          } else if (serverBody !== previousSaved[candidate]) {
            const draft: BrowserDraft = {
              userId,
              goalId: goal.id,
              subjectKey: `cycle:${cycle.id}:${candidate}`,
              body: localBody,
              baseRevision: previousRevisions[candidate],
              updatedAt: new Date().toISOString(),
            };
            nextConflicts.set(candidate, draft);
            pending.current.set(candidate, localBody);
            void cacheFrameDraft(
              candidate,
              localBody,
              previousRevisions[candidate],
            );
          } else if (localBody === serverBody) {
            pending.current.delete(candidate);
            void deleteFrameDraft(candidate);
          } else {
            pending.current.set(candidate, localBody);
            void cacheFrameDraft(candidate, localBody, serverRevision);
          }
        }

        valuesRef.current = nextValues;
        savedValuesRef.current = nextSaved;
        contentRevision.current = Math.max(
          contentRevision.current,
          serverCycle.contentRevision,
        );
        conflictsRef.current = nextConflicts;
        retryCountRef.current = 0;
        if (mountedRef.current) {
          setValues(nextValues);
          setRecoveryConflicts(new Map(nextConflicts));
          setError(undefined);
        }
        if (nextConflicts.size || cycleRevisionConflictsRef.current.size)
          updateSaveState("failed");
        else if (hasSavablePending()) {
          updateSaveState("dirty");
          schedulePump(0);
        } else updateSaveState("saved");
      } catch {
        if (!isCurrentRefresh()) return;
        await cacheFrameDraft(
          frame,
          valuesRef.current[frame],
          conflict.baseRevision,
        );
        if (!isCurrentRefresh()) return;
        if (mountedRef.current)
          setError(
            "最新の内容を取得できませんでした。入力は保持されています。再試行してください。",
          );
        updateSaveState("failed");
      } finally {
        if (cycleRevisionRefreshInFlightRef.current.get(frame) === refreshToken)
          cycleRevisionRefreshInFlightRef.current.delete(frame);
      }
    },
    [
      cache,
      cacheFrameDraft,
      clearBrowserTimer,
      clearSaveTimer,
      cycle.id,
      deleteFrameDraft,
      goal.id,
      hasSavablePending,
      schedulePump,
      updateSaveState,
      userId,
    ],
  );

  const drainDetached = useCallback(async () => {
    if (!editable || savesPausedRef.current || cacheDisabledRef.current) return;
    for (;;) {
      const entry = firstPendingEntry();
      if (!entry) return;
      const [frame, body] = entry;
      pending.current.delete(frame);
      try {
        const result = await saveCycleFrame(
          goal.id,
          cycle.id,
          frame,
          body,
          revisions.current[frame],
          session.csrfToken,
        );
        revisions.current[frame] = Math.max(
          revisions.current[frame],
          result.frameRevision,
        );
        contentRevision.current = Math.max(
          contentRevision.current,
          result.contentRevision,
        );
        savedValuesRef.current = {
          ...savedValuesRef.current,
          [frame]: result.content,
        };
        cacheCycleFrame(cache, userId, goal.id, result);
        if (pending.current.has(frame))
          void cacheFrameDraft(
            frame,
            pending.current.get(frame) ?? "",
            result.frameRevision,
          );
        else void deleteFrameDraft(frame);
      } catch {
        if (!pending.current.has(frame)) pending.current.set(frame, body);
        void persistFrameDraft(frame);
        return;
      }
    }
  }, [
    cache,
    cacheFrameDraft,
    cycle.id,
    deleteFrameDraft,
    editable,
    firstPendingEntry,
    goal.id,
    persistFrameDraft,
    session.csrfToken,
    userId,
  ]);
  drainDetachedRef.current = drainDetached;

  const pump = useCallback(async () => {
    if (
      saveInFlightRef.current ||
      savesPausedRef.current ||
      disposedRef.current
    )
      return;
    const entry = firstPendingEntry();
    if (!editable || !entry) {
      updateSaveState(
        conflictsRef.current.size || cycleRevisionConflictsRef.current.size
          ? "failed"
          : "saved",
      );
      return;
    }
    const [frame, body] = entry;
    const snapshotInputVersion = inputVersionRef.current;
    const snapshotFrameVersion = frameEditVersionsRef.current[frame];
    const snapshotRevision = revisions.current[frame];
    pending.current.delete(frame);
    saveInFlightRef.current = true;
    updateSaveState("saving");
    let result: Awaited<ReturnType<typeof saveCycleFrame>> | undefined;
    let failure: unknown;
    let cycleConflictHandled = false;
    try {
      result = await saveCycleFrame(
        goal.id,
        cycle.id,
        frame,
        body,
        snapshotRevision,
        session.csrfToken,
      );
      revisions.current[frame] = Math.max(
        revisions.current[frame],
        result.frameRevision,
      );
      contentRevision.current = Math.max(
        contentRevision.current,
        result.contentRevision,
      );
      savedValuesRef.current = {
        ...savedValuesRef.current,
        [frame]: result.content,
      };
      if (frameEditVersionsRef.current[frame] === snapshotFrameVersion) {
        valuesRef.current = { ...valuesRef.current, [frame]: result.content };
        if (mountedRef.current) setValues(valuesRef.current);
      }
      cacheCycleFrame(cache, userId, goal.id, result);
      if (!pending.current.has(frame)) void deleteFrameDraft(frame);
      else
        void cacheFrameDraft(
          frame,
          pending.current.get(frame) ?? "",
          result.frameRevision,
        );
      retryCountRef.current = 0;
    } catch (cause) {
      if (!pending.current.has(frame)) pending.current.set(frame, body);
      failure = cause;
      if (isCycleRevisionConflict(cause)) {
        await recoverCycleRevisionConflict(frame, body, snapshotRevision);
        cycleConflictHandled = true;
      }
    } finally {
      saveInFlightRef.current = false;
    }

    if (result) {
      if (disposedRef.current) void drainDetachedRef.current();
      else if (hasSavablePending()) {
        updateSaveState("dirty");
        schedulePump(0);
      } else
        updateSaveState(
          conflictsRef.current.size || cycleRevisionConflictsRef.current.size
            ? "failed"
            : "saved",
        );
      return;
    }

    if (cycleConflictHandled) return;
    if (disposedRef.current || savesPausedRef.current) return;
    void persistFrameDraft(frame);
    if (inputVersionRef.current !== snapshotInputVersion) {
      retryCountRef.current = 0;
      updateSaveState("dirty");
      const elapsed = Date.now() - lastInputAtRef.current;
      schedulePump(Math.max(0, autoSaveDebounceMs - elapsed));
      return;
    }
    if (
      isRetryableAutoSaveError(failure) &&
      retryCountRef.current < maxAutoSaveRetries
    ) {
      retryCountRef.current += 1;
      updateSaveState("dirty");
      schedulePump(autoSaveRetryDelay(retryCountRef.current));
      return;
    }
    updateSaveState("failed");
  }, [
    cache,
    cacheFrameDraft,
    cycle.id,
    deleteFrameDraft,
    editable,
    firstPendingEntry,
    goal.id,
    hasSavablePending,
    persistFrameDraft,
    recoverCycleRevisionConflict,
    schedulePump,
    session.csrfToken,
    updateSaveState,
    userId,
  ]);
  pumpRef.current = pump;

  useEffect(() => {
    if (!editable) return;
    let canceled = false;
    void Promise.all(
      frames.map(async (frame) => {
        try {
          return {
            frame,
            draft: await getBrowserDraft(userId, `cycle:${cycle.id}:${frame}`),
          };
        } catch {
          return { frame, failed: true as const };
        }
      }),
    ).then((results) => {
      if (canceled) return;
      let nextValues = valuesRef.current;
      const nextConflicts = new Map(conflictsRef.current);
      let cacheReadFailed = false;
      for (const item of results) {
        if ("failed" in item) {
          cacheReadFailed = true;
          continue;
        }
        const { draft: loadedDraft, frame } = item;
        if (!loadedDraft || editedFramesRef.current.has(frame)) continue;
        const canonicalBody = normalizeLineEndings(loadedDraft.body);
        const draft =
          canonicalBody === loadedDraft.body
            ? loadedDraft
            : { ...loadedDraft, body: canonicalBody };
        if (canonicalBody !== loadedDraft.body)
          void cacheFrameDraft(frame, canonicalBody, loadedDraft.baseRevision);
        nextValues = { ...nextValues, [frame]: draft.body };
        frameEditVersionsRef.current[frame] += 1;
        if (draft.baseRevision === revisions.current[frame]) {
          if (draft.body !== savedValuesRef.current[frame])
            pending.current.set(frame, draft.body);
          else void deleteFrameDraft(frame);
        } else {
          nextConflicts.set(frame, draft);
        }
      }
      valuesRef.current = nextValues;
      conflictsRef.current = nextConflicts;
      setValues(nextValues);
      setRecoveryConflicts(new Map(nextConflicts));
      if (cacheReadFailed) setBrowserCacheFailed(true);
      if (nextConflicts.size) setSaveState("failed");
      else if (hasSavablePending()) {
        setSaveState("dirty");
        schedulePump(autoSaveDebounceMs);
      }
    });
    return () => {
      canceled = true;
    };
  }, [
    cacheFrameDraft,
    cycle.id,
    deleteFrameDraft,
    editable,
    hasSavablePending,
    schedulePump,
    userId,
  ]);

  useEffect(() => {
    const handleOnline = () => {
      if (savesPausedRef.current) return;
      retryCountRef.current = 0;
      if (cycleRevisionConflictsRef.current.size) {
        for (const [frame, conflict] of cycleRevisionConflictsRef.current)
          void recoverCycleRevisionConflict(
            frame,
            conflict.failedSnapshot,
            conflict.baseRevision,
          );
        return;
      }
      if (!hasSavablePending()) return;
      updateSaveState("dirty");
      schedulePump(0);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [
    hasSavablePending,
    recoverCycleRevisionConflict,
    schedulePump,
    updateSaveState,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    disposedRef.current = false;
    const pendingDrafts = pending.current;
    return () => {
      mountedRef.current = false;
      disposedRef.current = true;
      cycleRevisionRefreshEpochRef.current += 1;
      clearSaveTimer();
      for (const frame of frames) {
        clearBrowserTimer(frame);
        if (pendingDrafts.has(frame)) void persistFrameDraft(frame);
      }
      if (
        !cacheDisabledRef.current &&
        !savesPausedRef.current &&
        !saveInFlightRef.current &&
        hasSavablePending()
      )
        void drainDetachedRef.current();
    };
  }, [clearBrowserTimer, clearSaveTimer, hasSavablePending, persistFrameDraft]);

  function change(frame: Frame, value: string) {
    if (movedWorkspaceRef.current || conflictsRef.current.has(frame)) return;
    const normalizedValue = normalizeBoundedTextInput(
      value,
      FRAME_TEXT_MAX_CODE_POINTS,
    );
    if (normalizedValue === null) return;
    editedFramesRef.current.add(frame);
    inputVersionRef.current += 1;
    frameEditVersionsRef.current[frame] += 1;
    retryCountRef.current = 0;
    lastInputAtRef.current = Date.now();
    valuesRef.current = { ...valuesRef.current, [frame]: normalizedValue };
    setValues(valuesRef.current);
    if (normalizedValue === savedValuesRef.current[frame])
      pending.current.delete(frame);
    else pending.current.set(frame, normalizedValue);
    if (!saveInFlightRef.current)
      setSaveState(
        conflictsRef.current.size || cycleRevisionConflictsRef.current.size
          ? "failed"
          : pending.current.size
            ? "dirty"
            : "saved",
      );
    scheduleBrowserDraft(frame);
    schedulePump(autoSaveDebounceMs);
  }

  function flush(frame: Frame) {
    if (
      movedWorkspaceRef.current ||
      conflictsRef.current.has(frame) ||
      savesPausedRef.current
    )
      return;
    clearBrowserTimer(frame);
    void persistFrameDraft(frame);
    clearSaveTimer();
    void pumpRef.current();
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
    if (
      movedWorkspaceRef.current ||
      savesPausedRef.current ||
      conflictsRef.current.size
    )
      return;
    retryCountRef.current = 0;
    if (cycleRevisionConflictsRef.current.size) {
      for (const [frame, conflict] of cycleRevisionConflictsRef.current)
        void recoverCycleRevisionConflict(
          frame,
          conflict.failedSnapshot,
          conflict.baseRevision,
        );
      return;
    }
    setSaveState("dirty");
    schedulePump(0);
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
    inputVersionRef.current += 1;
    frameEditVersionsRef.current[frame] += 1;
    retryCountRef.current = 0;
    if (draft.body === savedValuesRef.current[frame]) {
      pending.current.delete(frame);
      void deleteFrameDraft(frame);
    } else {
      pending.current.set(frame, draft.body);
      void cacheFrameDraft(frame, draft.body, revisions.current[frame]);
    }
    setSaveState(
      nextConflicts.size || cycleRevisionConflictsRef.current.size
        ? "failed"
        : pending.current.size
          ? "dirty"
          : "saved",
    );
    schedulePump(0);
  }

  function discardRecovery(frame: Frame) {
    if (movedWorkspaceRef.current) return;
    if (!conflictsRef.current.has(frame)) return;
    const nextConflicts = new Map(conflictsRef.current);
    nextConflicts.delete(frame);
    conflictsRef.current = nextConflicts;
    setRecoveryConflicts(new Map(nextConflicts));
    valuesRef.current = {
      ...valuesRef.current,
      [frame]: savedValuesRef.current[frame],
    };
    frameEditVersionsRef.current[frame] += 1;
    pending.current.delete(frame);
    setValues(valuesRef.current);
    void deleteFrameDraft(frame);
    setSaveState(
      nextConflicts.size || cycleRevisionConflictsRef.current.size
        ? "failed"
        : pending.current.size
          ? "dirty"
          : "saved",
    );
    if (hasSavablePending()) schedulePump(0);
  }

  function pauseSaves() {
    savesPausedRef.current = true;
    cycleRevisionRefreshEpochRef.current += 1;
    clearSaveTimer();
    cycleRevisionRefreshInFlightRef.current.clear();
  }

  function resumeSaves() {
    if (movedWorkspaceRef.current) return;
    savesPausedRef.current = false;
    cacheDisabledRef.current = false;
    retryCountRef.current = 0;
    if (cycleRevisionConflictsRef.current.size) {
      setSaveState("failed");
      for (const [frame, conflict] of cycleRevisionConflictsRef.current)
        void recoverCycleRevisionConflict(
          frame,
          conflict.failedSnapshot,
          conflict.baseRevision,
        );
      return;
    }
    if (conflictsRef.current.size) {
      setSaveState("failed");
      return;
    }
    if (hasSavablePending()) {
      setSaveState("dirty");
      schedulePump(0);
    } else setSaveState("saved");
  }

  async function finalizeDraftCache(scope: "cycle" | "goal") {
    cacheDisabledRef.current = true;
    cycleRevisionRefreshEpochRef.current += 1;
    pending.current.clear();
    conflictsRef.current.clear();
    cycleRevisionConflictsRef.current.clear();
    for (const frame of frames) clearBrowserTimer(frame);
    if (scope === "goal") {
      await clearGoalDraftCache();
      return;
    }
    for (const frame of frames) await deleteFrameDraft(frame);
  }

  function applyAI(
    action: string,
    actionRevision: number,
    nextContentRevision: number,
  ) {
    valuesRef.current = { ...valuesRef.current, action };
    savedValuesRef.current = { ...savedValuesRef.current, action };
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
    pending.current.delete("action");
    const nextConflicts = new Map(conflictsRef.current);
    nextConflicts.delete("action");
    conflictsRef.current = nextConflicts;
    setRecoveryConflicts(new Map(nextConflicts));
    clearBrowserTimer("action");
    void deleteFrameDraft("action");
    setSaveState(
      nextConflicts.size || cycleRevisionConflictsRef.current.size
        ? "failed"
        : pending.current.size
          ? "dirty"
          : "saved",
    );
  }
  const allPDC = [values.plan, values.do, values.check].every(hasNonWhitespace);
  const allFrames = allPDC && hasNonWhitespace(values.action);
  const aiReady = saveState === "saved" && aiState === "idle";
  function requestAI(kind: "generating" | "refining") {
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
                refineAction(goal.id, cycle.id, expectedContentRevision, {
                  operationId,
                  csrfToken: session.csrfToken,
                }),
            );
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
      setError("AI処理を完了できませんでした。現在のAは保持されています。");
    } finally {
      setAIState("idle");
    }
  }
  async function finish() {
    setPendingAction(true);
    setError(undefined);
    pauseSaves();
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
      await cache.invalidateQueries({
        queryKey: userQueryKeys.root(userId),
        refetchType: "none",
      });
      if ("goal" in result) {
        cacheReview(cache, userId, {
          goal: result.goal,
          reviewDraft: result.reviewDraft,
          triggerCycle: result.completedCycle,
        });
        await finalizeDraftCache("cycle");
        navigate(`/goals/${goal.id}/review`, { replace: true });
        return;
      }
      await finalizeDraftCache("cycle");
      await cache
        .refetchQueries({
          queryKey: userQueryKeys.goal(userId, goal.id),
          exact: true,
        })
        .catch(() => undefined);
      navigate(replayWorkspacePath(goal.id, result.currentWorkspace), {
        replace: true,
      });
    } catch {
      resumeSaves();
      setError("サイクルを完了できませんでした。入力内容を確認してください。");
      setPendingAction(false);
    }
  }
  async function terminate(outcome: "achieved" | "ended") {
    const wording = outcome === "achieved" ? "達成として終了" : "終了";
    setPendingAction(true);
    setError(undefined);
    pauseSaves();
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
      await finalizeDraftCache("goal");
      await cache.invalidateQueries({
        queryKey: userQueryKeys.root(userId),
        refetchType: "none",
      });
      navigate("/", { replace: true });
    } catch {
      resumeSaves();
      setError(`目標を${wording}できませんでした。`);
      setPendingAction(false);
    }
  }
  async function remove() {
    setPendingAction(true);
    setError(undefined);
    pauseSaves();
    try {
      await deleteOperation.invoke(
        commandFingerprint("goal_delete", {
          goalId: goal.id,
          expectedGoalRevision: goal.revision,
        }),
        (operationId) =>
          deleteGoal(goal.id, goal.revision, {
            operationId,
            csrfToken: session.csrfToken,
          }),
      );
      await finalizeDraftCache("goal");
      await cache.invalidateQueries({
        queryKey: userQueryKeys.root(userId),
        refetchType: "none",
      });
      navigate("/", { replace: true });
    } catch {
      resumeSaves();
      setError("目標を削除できませんでした。");
      setPendingAction(false);
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
            (selected === "action" && aiState !== "idle")
          }
          value={values[selected]}
          placeholder={copy.placeholder}
          readOnly={
            workspaceMoved ||
            !editable ||
            Boolean(selectedConflict) ||
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
                saveState !== "saved" || aiState !== "idle" || pendingAction
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
                saveState !== "saved" || aiState !== "idle" || pendingAction
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
