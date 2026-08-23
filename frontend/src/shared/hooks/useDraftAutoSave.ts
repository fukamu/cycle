import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useForm, useWatch } from "react-hook-form";

import { APIError } from "../api/client";
import {
  AutoSaveCoordinator,
  type AutoSaveState,
} from "../autosave/autoSaveCoordinator";
import {
  type AutoSaveBrowserOperationQueue,
  useAutoSaveScopeRegistry,
} from "../autosave/AutoSaveScopeProvider";
import {
  type BrowserDraft,
  deleteBrowserDraft,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
} from "../drafts/browserDraftCache";
import { normalizeLineEndings } from "../text/semantics";

export type DraftSaveState = AutoSaveState;

export type SimpleDraftRevisionConflictCode =
  | "GOAL_DRAFT_REVISION_CONFLICT"
  | "GOAL_REVIEW_DRAFT_REVISION_CONFLICT";

type DraftSnapshot = {
  readonly body: string;
  readonly revision: number;
};

export type DraftLatestResolution<TSnapshot extends DraftSnapshot> =
  | { readonly kind: "accepted"; readonly snapshot: TSnapshot }
  | { readonly kind: "scope-moved"; readonly href: string };

type Input<TSnapshot extends DraftSnapshot> = {
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly initialBody: string;
  readonly initialRevision: number;
  readonly save: (
    body: string,
    revision: number,
    signal: AbortSignal,
  ) => Promise<{ readonly body: string; readonly revision: number }>;
  readonly revisionConflictCode: SimpleDraftRevisionConflictCode;
  readonly loadLatest: (signal: AbortSignal) => Promise<TSnapshot>;
  readonly acceptLatest?: (
    latest: TSnapshot,
  ) => DraftLatestResolution<TSnapshot>;
  readonly scopeMovedOnError?: (error: unknown) => string | null;
};

type ConflictSnapshot = {
  readonly body: string;
  readonly baseRevision: number;
};

const bodyKey = "body";

export function useDraftAutoSave<TSnapshot extends DraftSnapshot>(
  input: Input<TSnapshot>,
) {
  const registry = useAutoSaveScopeRegistry();
  const scopeKey = input.userId + ":" + input.subjectKey;
  const runtimeRef = useRef<{
    readonly scopeKey: string;
    readonly userId: string;
    readonly goalId: string | null;
    readonly subjectKey: string;
    readonly initialBody: string;
    readonly initialRevision: number;
    readonly revisionConflictCode: SimpleDraftRevisionConflictCode;
    save: Input<TSnapshot>["save"];
    loadLatest: Input<TSnapshot>["loadLatest"];
    acceptLatest: Input<TSnapshot>["acceptLatest"];
    scopeMovedOnError: Input<TSnapshot>["scopeMovedOnError"];
  } | null>(null);
  if (!runtimeRef.current || runtimeRef.current.scopeKey !== scopeKey) {
    runtimeRef.current = {
      scopeKey,
      userId: input.userId,
      goalId: input.goalId,
      subjectKey: input.subjectKey,
      initialBody: input.initialBody,
      initialRevision: input.initialRevision,
      revisionConflictCode: input.revisionConflictCode,
      save: input.save,
      loadLatest: input.loadLatest,
      acceptLatest: input.acceptLatest,
      scopeMovedOnError: input.scopeMovedOnError,
    };
  } else {
    runtimeRef.current.save = input.save;
    runtimeRef.current.loadLatest = input.loadLatest;
    runtimeRef.current.acceptLatest = input.acceptLatest;
    runtimeRef.current.scopeMovedOnError = input.scopeMovedOnError;
  }
  const runtime = runtimeRef.current;

  const lease = useMemo(() => registry.prepare(scopeKey), [registry, scopeKey]);
  const { control, reset, setValue } = useForm<{ body: string }>({
    defaultValues: { body: runtime.initialBody },
  });
  const body = useWatch({ control, name: "body" });
  const [revision, setRevision] = useState(runtime.initialRevision);
  const [recoveryConflict, setRecoveryConflict] = useState<BrowserDraft | null>(
    null,
  );
  const [revisionConflictActive, setRevisionConflictActive] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [browserCacheFailed, setBrowserCacheFailed] = useState(false);
  const [scopeMovedHref, setScopeMovedHref] = useState<string | null>(null);

  const revisionRef = useRef(runtime.initialRevision);
  const conflictSnapshotRef = useRef<ConflictSnapshot | undefined>(undefined);
  const attemptBaseRevisionRef = useRef(runtime.initialRevision);
  const lastCachedDraftRef = useRef<BrowserDraft | undefined>(undefined);
  const hasEditedRef = useRef(false);
  const mountedRef = useRef(false);
  const quiesceQueueRef = useRef<AutoSaveBrowserOperationQueue | undefined>(
    undefined,
  );
  const resolveRevisionConflictRef = useRef<
    (signal: AbortSignal) => Promise<void>
  >(async () => undefined);
  const markScopeMovedRef = useRef<(href: string) => void>(() => undefined);
  const queueBrowserOperation = useCallback<AutoSaveBrowserOperationQueue>(
    (operation) =>
      (quiesceQueueRef.current ?? lease.queueBrowserOperation)(operation),
    [lease],
  );

  const clearBrowserDraft = useCallback(async () => {
    try {
      const cleared = await lease.queueBrowserOperation(async () => {
        await deleteBrowserDraft(runtime.userId, runtime.subjectKey);
        return true;
      });
      if (cleared !== true) throw new Error("browser draft scope is inactive");
      lastCachedDraftRef.current = undefined;
      if (mountedRef.current && lease.isCurrent()) {
        setBrowserCacheFailed(false);
      }
      return true;
    } catch {
      if (mountedRef.current && lease.isCurrent()) {
        setBrowserCacheFailed(true);
      }
      return false;
    }
  }, [lease, runtime]);

  const coordinator = useMemo(() => {
    const own = {
      current: undefined as
        | AutoSaveCoordinator<
            typeof bodyKey,
            string,
            { readonly body: string; readonly revision: number }
          >
        | undefined,
    };
    const created = new AutoSaveCoordinator<
      typeof bodyKey,
      string,
      { readonly body: string; readonly revision: number }
    >({
      initialValues: new Map([[bodyKey, runtime.initialBody]]),
      initiallyHydrating: true,
      signal: lease.signal,
      isCurrent: lease.isCurrent,
      save: (entry, signal) => {
        const baseRevision = revisionRef.current;
        attemptBaseRevisionRef.current = baseRevision;
        return runtime.save(entry.value, baseRevision, signal);
      },
      savedValue: (result) => result.body,
      onSaved: (_entry, result) => {
        if (!lease.isCurrent()) return;
        revisionRef.current = result.revision;
        if (mountedRef.current) setRevision(result.revision);
        const current = own.current?.getCurrentValue(bodyKey);
        if (current === result.body && mountedRef.current)
          reset({ body: result.body });
      },
      onError: async (error, entry, signal) => {
        const movedHref = runtime.scopeMovedOnError?.(error);
        if (movedHref) {
          markScopeMovedRef.current(movedHref);
          return "handled";
        }
        if (
          !(error instanceof APIError) ||
          error.status !== 409 ||
          error.code !== runtime.revisionConflictCode
        )
          return "unhandled";

        const conflict = {
          body: entry.value,
          baseRevision: attemptBaseRevisionRef.current,
        };
        conflictSnapshotRef.current = conflict;
        const current = own.current?.getCurrentValue(bodyKey) ?? entry.value;
        own.current?.block(bodyKey, current, runtime.revisionConflictCode);
        if (mountedRef.current && lease.isCurrent()) {
          setRevisionConflictActive(true);
          setRecoveryConflict(null);
        }
        await resolveRevisionConflictRef.current(signal);
        return "handled";
      },
      persist: async (_key, value) => {
        const draft: BrowserDraft = {
          userId: runtime.userId,
          goalId: runtime.goalId,
          subjectKey: runtime.subjectKey,
          body: value,
          baseRevision:
            conflictSnapshotRef.current?.baseRevision ?? revisionRef.current,
          updatedAt: new Date().toISOString(),
        };
        const stored = await queueBrowserOperation(async () => {
          await putBrowserDraft(draft);
          return true;
        });
        if (stored !== true) throw new Error("browser draft scope is inactive");
        lastCachedDraftRef.current = draft;
      },
      clearPersisted: async () => {
        const expected = lastCachedDraftRef.current;
        if (!expected) return;
        await queueBrowserOperation(() =>
          deleteBrowserDraftIfUnchanged(
            expected.userId,
            expected.subjectKey,
            expected.body,
            expected.baseRevision,
          ),
        );
        if (lastCachedDraftRef.current === expected)
          lastCachedDraftRef.current = undefined;
      },
      onPersistenceStatus: (available) => {
        if (mountedRef.current && lease.isCurrent())
          setBrowserCacheFailed(!available);
      },
    });
    own.current = created;
    return created;
  }, [lease, queueBrowserOperation, reset, runtime]);

  const state = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getState,
    coordinator.getState,
  );
  const hydrationRunRef = useRef<{
    readonly coordinator: typeof coordinator;
    readonly token: symbol;
  } | null>(null);

  const markScopeMoved = useCallback(
    (href: string) => {
      if (!lease.isCurrent()) return;
      conflictSnapshotRef.current = undefined;
      const current = coordinator.getCurrentValue(bodyKey);
      coordinator.pause(true);
      if (current !== undefined)
        coordinator.block(bodyKey, current, "AUTOSAVE_SCOPE_MOVED");
      if (mountedRef.current) {
        setScopeMovedHref(href);
        setRevisionConflictActive(false);
        setRecoveryConflict(null);
        setResolvingConflict(false);
      }
    },
    [coordinator, lease],
  );
  markScopeMovedRef.current = markScopeMoved;

  const resolveRevisionConflict = useCallback(
    async (signal: AbortSignal) => {
      const conflict = conflictSnapshotRef.current;
      if (!conflict || resolvingConflict) return;
      if (mountedRef.current && lease.isCurrent()) setResolvingConflict(true);
      try {
        const loaded = await runtime.loadLatest(signal);
        if (
          signal.aborted ||
          !lease.isCurrent() ||
          conflictSnapshotRef.current !== conflict
        )
          return;
        const resolution: DraftLatestResolution<TSnapshot> =
          runtime.acceptLatest?.(loaded) ?? {
            kind: "accepted",
            snapshot: loaded,
          };
        if (conflictSnapshotRef.current !== conflict) return;
        if (resolution.kind === "scope-moved") {
          markScopeMoved(resolution.href);
          return;
        }
        const latest = resolution.snapshot;

        revisionRef.current = latest.revision;
        if (mountedRef.current) setRevision(latest.revision);
        coordinator.rebase(bodyKey, latest.body);
        const current = coordinator.getCurrentValue(bodyKey) ?? conflict.body;

        if (conflict.body === latest.body) {
          conflictSnapshotRef.current = undefined;
          setRevisionConflictActive(false);
          setRecoveryConflict(null);
          coordinator.unblock(bodyKey);
          if (current === latest.body && mountedRef.current)
            reset({ body: latest.body });
          return;
        }

        const localDraft: BrowserDraft = {
          userId: runtime.userId,
          goalId: runtime.goalId,
          subjectKey: runtime.subjectKey,
          body: current,
          baseRevision: conflict.baseRevision,
          updatedAt: new Date().toISOString(),
        };
        lastCachedDraftRef.current = localDraft;
        coordinator.block(bodyKey, current, runtime.revisionConflictCode);
        if (mountedRef.current) setRecoveryConflict(localDraft);
      } catch (error) {
        const movedHref = runtime.scopeMovedOnError?.(error);
        if (
          movedHref &&
          !signal.aborted &&
          lease.isCurrent() &&
          conflictSnapshotRef.current === conflict
        ) {
          markScopeMoved(movedHref);
          return;
        }
        // The local value remains blocked and recoverable. Manual retry only
        // repeats this latest-state fetch, never the stale PATCH.
      } finally {
        if (
          mountedRef.current &&
          lease.isCurrent() &&
          conflictSnapshotRef.current === conflict
        )
          setResolvingConflict(false);
      }
    },
    [coordinator, lease, markScopeMoved, reset, resolvingConflict, runtime],
  );
  resolveRevisionConflictRef.current = resolveRevisionConflict;

  useLayoutEffect(() => {
    mountedRef.current = true;
    lease.activate();
    if (!lease.isCurrent()) {
      mountedRef.current = false;
      return;
    }
    coordinator.attach();
    const unregister = lease.onQuiesce(async (lifecycle) => {
      quiesceQueueRef.current = lifecycle.queueBrowserOperation;
      try {
        await coordinator.quiesce(lifecycle.preserveDrafts);
      } finally {
        if (quiesceQueueRef.current === lifecycle.queueBrowserOperation)
          quiesceQueueRef.current = undefined;
      }
    });
    return () => {
      mountedRef.current = false;
      unregister();
      coordinator.detach();
    };
  }, [coordinator, lease]);

  useEffect(() => {
    let canceled = false;
    const run = { coordinator, token: Symbol("draft-hydration") };
    hydrationRunRef.current = run;
    void (async () => {
      try {
        const draft = await lease.queueBrowserOperation(() =>
          getBrowserDraft(runtime.userId, runtime.subjectKey),
        );
        if (canceled || !draft || hasEditedRef.current || !lease.isCurrent())
          return;

        const canonicalBody = normalizeLineEndings(draft.body);
        const canonicalDraft =
          canonicalBody === draft.body
            ? draft
            : { ...draft, body: canonicalBody };
        lastCachedDraftRef.current = draft;
        if (canonicalDraft !== draft) {
          const stored = await lease.queueBrowserOperation(async () => {
            await putBrowserDraft(canonicalDraft);
            return true;
          });
          if (stored !== true)
            throw new Error("browser draft scope is inactive");
          lastCachedDraftRef.current = canonicalDraft;
        }
        if (canceled || hasEditedRef.current || !lease.isCurrent()) return;

        if (canonicalDraft.baseRevision !== revisionRef.current) {
          conflictSnapshotRef.current = {
            body: canonicalBody,
            baseRevision: canonicalDraft.baseRevision,
          };
          coordinator.block(
            bodyKey,
            canonicalBody,
            runtime.revisionConflictCode,
          );
          setValue("body", canonicalBody);
          setRecoveryConflict(canonicalDraft);
          setRevisionConflictActive(true);
          return;
        }
        if (canonicalBody === coordinator.getSavedValue(bodyKey)) {
          coordinator.flush(bodyKey);
          return;
        }
        coordinator.edit(bodyKey, canonicalBody);
        setValue("body", canonicalBody);
      } catch {
        if (!canceled && lease.isCurrent()) setBrowserCacheFailed(true);
      } finally {
        const active = hydrationRunRef.current;
        if (active?.coordinator !== coordinator || active.token === run.token)
          coordinator.finishHydration();
      }
    })();
    return () => {
      canceled = true;
    };
  }, [coordinator, lease, runtime, setValue]);

  useEffect(() => {
    const handleOnline = () => {
      if (scopeMovedHref) return;
      if (revisionConflictActive && !recoveryConflict) {
        void resolveRevisionConflictRef.current(lease.signal);
        return;
      }
      coordinator.online();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [
    coordinator,
    lease.signal,
    recoveryConflict,
    revisionConflictActive,
    scopeMovedHref,
  ]);

  const setBody = useCallback(
    (value: string) => {
      if (revisionConflictActive || scopeMovedHref) return;
      hasEditedRef.current = true;
      coordinator.edit(bodyKey, value);
      setValue("body", value);
    },
    [coordinator, revisionConflictActive, scopeMovedHref, setValue],
  );

  const flush = useCallback(() => coordinator.flush(bodyKey), [coordinator]);

  const synchronize = useCallback(
    (nextBody: string, nextRevision: number) => {
      conflictSnapshotRef.current = undefined;
      setRevisionConflictActive(false);
      setRecoveryConflict(null);
      setResolvingConflict(false);
      setScopeMovedHref(null);
      revisionRef.current = nextRevision;
      coordinator.synchronize(bodyKey, nextBody);
      reset({ body: nextBody });
      setRevision(nextRevision);
      void clearBrowserDraft();
    },
    [clearBrowserDraft, coordinator, reset],
  );

  const pause = useCallback(() => coordinator.pause(), [coordinator]);

  const resume = useCallback(() => coordinator.resume(), [coordinator]);

  const discard = useCallback(async () => {
    conflictSnapshotRef.current = undefined;
    setRevisionConflictActive(false);
    setRecoveryConflict(null);
    setResolvingConflict(false);
    setScopeMovedHref(null);
    await coordinator.discard();
    return clearBrowserDraft();
  }, [clearBrowserDraft, coordinator]);

  const retry = useCallback(() => {
    if (scopeMovedHref) return;
    if (revisionConflictActive) {
      if (!recoveryConflict)
        void resolveRevisionConflictRef.current(lease.signal);
      return;
    }
    coordinator.retry();
  }, [
    coordinator,
    lease.signal,
    recoveryConflict,
    revisionConflictActive,
    scopeMovedHref,
  ]);

  const restoreRecovery = useCallback(() => {
    const draft = recoveryConflict;
    if (!draft) return;
    conflictSnapshotRef.current = undefined;
    setRevisionConflictActive(false);
    setRecoveryConflict(null);
    setResolvingConflict(false);
    hasEditedRef.current = true;
    setValue("body", draft.body);
    coordinator.unblock(bodyKey);
  }, [coordinator, recoveryConflict, setValue]);

  const discardRecovery = useCallback(() => {
    if (!recoveryConflict) return;
    const saved = coordinator.getSavedValue(bodyKey) ?? runtime.initialBody;
    conflictSnapshotRef.current = undefined;
    setRevisionConflictActive(false);
    setRecoveryConflict(null);
    setResolvingConflict(false);
    coordinator.synchronize(bodyKey, saved);
    reset({ body: saved });
    void clearBrowserDraft();
  }, [clearBrowserDraft, coordinator, recoveryConflict, reset, runtime]);

  return {
    body,
    setBody,
    revision,
    state,
    hydrating: coordinator.isHydrating(),
    retry,
    flush,
    synchronize,
    pause,
    resume,
    discard,
    recoveryConflict,
    revisionConflictActive,
    resolvingConflict,
    scopeMovedHref,
    restoreRecovery,
    discardRecovery,
    browserCacheFailed,
    isActiveScope: lease.isCurrent,
  };
}
