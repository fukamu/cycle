import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import {
  cacheCycleFrame,
  cacheReview,
  userQueryKeys,
} from "../features/goal-collection/goalCache";
import type { Cycle, Frame, Goal } from "../shared/api/schemas";
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
  formatActivePeriod,
  formatCompletedPeriod,
} from "../shared/date/format";

const frames: readonly Frame[] = ["plan", "do", "check", "action"];
type Values = Record<Frame, string>;
type SaveState = "dirty" | "saving" | "saved" | "failed";
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
    if (goal.status === "active_cycle" && goal.currentWork?.cycleId)
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
  const [browserCacheFailed, setBrowserCacheFailed] = useState(false);
  const [aiState, setAIState] = useState<"idle" | "generating" | "refining">(
    "idle",
  );
  const [pendingAction, setPendingAction] = useState(false);
  const [confirmation, setConfirmation] = useState<WorkspaceConfirmation>();
  const [error, setError] = useState<string>();
  const pending = useRef(new Map<Frame, string>());
  const conflictsRef = useRef(new Map<Frame, BrowserDraft>());
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
        (frame) => !conflictsRef.current.has(frame),
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
      if (!conflictsRef.current.has(entry[0])) return entry;
    }
    return undefined;
  }, []);

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
      updateSaveState(conflictsRef.current.size ? "failed" : "saved");
      return;
    }
    const [frame, body] = entry;
    const snapshotInputVersion = inputVersionRef.current;
    const snapshotFrameVersion = frameEditVersionsRef.current[frame];
    pending.current.delete(frame);
    saveInFlightRef.current = true;
    updateSaveState("saving");
    let result: Awaited<ReturnType<typeof saveCycleFrame>> | undefined;
    let failure: unknown;
    try {
      result = await saveCycleFrame(
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
    } finally {
      saveInFlightRef.current = false;
    }

    if (result) {
      if (disposedRef.current) void drainDetachedRef.current();
      else if (hasSavablePending()) {
        updateSaveState("dirty");
        schedulePump(0);
      } else updateSaveState(conflictsRef.current.size ? "failed" : "saved");
      return;
    }

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
        const { draft, frame } = item;
        if (!draft || editedFramesRef.current.has(frame)) continue;
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
    cycle.id,
    deleteFrameDraft,
    editable,
    hasSavablePending,
    schedulePump,
    userId,
  ]);

  useEffect(() => {
    const handleOnline = () => {
      if (savesPausedRef.current || !hasSavablePending()) return;
      retryCountRef.current = 0;
      updateSaveState("dirty");
      schedulePump(0);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [hasSavablePending, schedulePump, updateSaveState]);

  useEffect(() => {
    mountedRef.current = true;
    disposedRef.current = false;
    const pendingDrafts = pending.current;
    return () => {
      mountedRef.current = false;
      disposedRef.current = true;
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
    if (Array.from(value).length > 200) return;
    if (conflictsRef.current.has(frame)) return;
    editedFramesRef.current.add(frame);
    inputVersionRef.current += 1;
    frameEditVersionsRef.current[frame] += 1;
    retryCountRef.current = 0;
    lastInputAtRef.current = Date.now();
    valuesRef.current = { ...valuesRef.current, [frame]: value };
    setValues(valuesRef.current);
    if (value === savedValuesRef.current[frame]) pending.current.delete(frame);
    else pending.current.set(frame, value);
    if (!saveInFlightRef.current)
      setSaveState(
        conflictsRef.current.size
          ? "failed"
          : pending.current.size
            ? "dirty"
            : "saved",
      );
    scheduleBrowserDraft(frame);
    schedulePump(autoSaveDebounceMs);
  }

  function flush(frame: Frame) {
    if (conflictsRef.current.has(frame) || savesPausedRef.current) return;
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
    if (conflictsRef.current.size || savesPausedRef.current) return;
    retryCountRef.current = 0;
    setSaveState("dirty");
    schedulePump(0);
  }

  function restoreRecovery(frame: Frame) {
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
      nextConflicts.size ? "failed" : pending.current.size ? "dirty" : "saved",
    );
    schedulePump(0);
  }

  function discardRecovery(frame: Frame) {
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
      nextConflicts.size ? "failed" : pending.current.size ? "dirty" : "saved",
    );
    if (hasSavablePending()) schedulePump(0);
  }

  function pauseSaves() {
    savesPausedRef.current = true;
    clearSaveTimer();
  }

  function resumeSaves() {
    savesPausedRef.current = false;
    cacheDisabledRef.current = false;
    retryCountRef.current = 0;
    if (hasSavablePending()) {
      setSaveState("dirty");
      schedulePump(0);
    }
  }

  async function finalizeDraftCache() {
    cacheDisabledRef.current = true;
    pending.current.clear();
    conflictsRef.current.clear();
    for (const frame of frames) clearBrowserTimer(frame);
    await clearGoalDraftCache();
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
      nextConflicts.size ? "failed" : pending.current.size ? "dirty" : "saved",
    );
  }
  const allPDC = [values.plan, values.do, values.check].every((value) =>
    value.trim(),
  );
  const allFrames = allPDC && values.action.trim();
  const aiReady = saveState === "saved" && aiState === "idle";
  function requestAI(kind: "generating" | "refining") {
    if (kind === "generating" && values.action.trim()) {
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
      const result =
        kind === "generating"
          ? await generateAction(
              goal.id,
              cycle.id,
              contentRevision.current,
              confirmReplace,
              session.csrfToken,
            )
          : await refineAction(
              goal.id,
              cycle.id,
              contentRevision.current,
              session.csrfToken,
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
      const result = await completeCycle(
        goal.id,
        cycle.id,
        goal.revision,
        contentRevision.current,
        session.csrfToken,
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
      }
      await finalizeDraftCache();
      navigate(`/goals/${goal.id}/review`, { replace: true });
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
      await terminateGoal(
        goal.id,
        outcome,
        goal.revision,
        "active_cycle",
        session.csrfToken,
        { id: cycle.id, revision: contentRevision.current },
      );
      await finalizeDraftCache();
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
      await deleteGoal(goal.id, goal.revision, session.csrfToken);
      await finalizeDraftCache();
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
        {selectedConflict && (
          <DraftRecoveryNotice
            onRestore={() => restoreRecovery(selected)}
            onDiscard={() => discardRecovery(selected)}
          />
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
            !editable ||
            Boolean(selectedConflict) ||
            (selected === "action" && aiState !== "idle")
          }
          value={values[selected]}
          maxLength={200}
          placeholder={copy.placeholder}
          readOnly={
            !editable ||
            Boolean(selectedConflict) ||
            (selected === "action" && aiState !== "idle")
          }
          onChange={(event) => change(selected, event.target.value)}
          onBlur={() => flush(selected)}
        />
        <div className="editor-meta">
          {editable ? (
            <SaveBadge
              state={saveState}
              retry={recoveryConflicts.size ? undefined : retrySave}
            />
          ) : (
            <span className="read-only-badge">読み取り専用</span>
          )}
          <span>{Array.from(values[selected]).length} / 200</span>
        </div>
        {editable && selected === "action" && (
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
      {editable && (
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
