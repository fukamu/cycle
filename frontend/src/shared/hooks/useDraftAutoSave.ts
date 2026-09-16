import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
import {
  normalizeLineEndings,
  normalizeSuccessSignal,
  successSignalInputValue,
} from "../text/semantics";

export type DraftSaveState = AutoSaveState;

export type SimpleDraftRevisionConflictCode =
  | "GOAL_DRAFT_REVISION_CONFLICT"
  | "GOAL_REVIEW_DRAFT_REVISION_CONFLICT";

type DraftSnapshot = {
  readonly body: string;
  readonly successSignal: string | null;
  readonly revision: number;
};

export type GoalDraftEditorContent = {
  readonly body: string;
  readonly successSignal: string;
};

export type DraftLatestResolution<TSnapshot extends DraftSnapshot> =
  | { readonly kind: "accepted"; readonly snapshot: TSnapshot }
  | { readonly kind: "scope-moved"; readonly href: string };

type Input<TSnapshot extends DraftSnapshot> = {
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly initialBody: string;
  readonly initialSuccessSignal: string | null;
  readonly initialRevision: number;
  readonly save: (
    content: GoalDraftEditorContent,
    revision: number,
    signal: AbortSignal,
  ) => Promise<DraftSnapshot>;
  readonly revisionConflictCode: SimpleDraftRevisionConflictCode;
  readonly loadLatest: (signal: AbortSignal) => Promise<TSnapshot>;
  readonly acceptLatest?: (
    latest: TSnapshot,
  ) => DraftLatestResolution<TSnapshot>;
  readonly scopeMovedOnError?: (error: unknown) => string | null;
};

type ConflictSnapshot = {
  readonly content: GoalDraftEditorContent;
  readonly baseRevision: number;
};

export type DraftScopeMovedOptions = {
  readonly preserveUnsaved?: boolean;
};

const contentKey = "content";

const editorContent = (
  snapshot: Pick<DraftSnapshot, "body" | "successSignal">,
): GoalDraftEditorContent => ({
  body: snapshot.body,
  successSignal: successSignalInputValue(snapshot.successSignal),
});

const contentEqual = (
  left: GoalDraftEditorContent,
  right: GoalDraftEditorContent,
) => left.body === right.body && left.successSignal === right.successSignal;

const canonicalContentEqual = (
  left: GoalDraftEditorContent,
  right: GoalDraftEditorContent,
) =>
  left.body === right.body &&
  normalizeSuccessSignal(left.successSignal) ===
    normalizeSuccessSignal(right.successSignal);

const browserDraftContent = (
  draft: BrowserDraft,
  fallbackSuccessSignal: string,
): GoalDraftEditorContent => ({
  body: normalizeLineEndings(draft.body),
  successSignal: Object.hasOwn(draft, "successSignal")
    ? normalizeLineEndings(successSignalInputValue(draft.successSignal ?? null))
    : fallbackSuccessSignal,
});

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
    readonly initialSuccessSignal: string | null;
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
      initialSuccessSignal: input.initialSuccessSignal,
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
  const initialContent = useMemo(
    () =>
      editorContent({
        body: runtime.initialBody,
        successSignal: runtime.initialSuccessSignal,
      }),
    [runtime],
  );

  const lease = useMemo(() => registry.prepare(scopeKey), [registry, scopeKey]);
  const [content, setContent] = useState(initialContent);
  const [revision, setRevision] = useState(runtime.initialRevision);
  const [recoveryConflict, setRecoveryConflict] = useState<BrowserDraft | null>(
    null,
  );
  const [revisionConflictActive, setRevisionConflictActive] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [browserCacheFailed, setBrowserCacheFailed] = useState(false);
  const [scopeMovedHref, setScopeMovedHref] = useState<string | null>(null);
  const scopeMovedHrefRef = useRef<string | null>(null);

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
            typeof contentKey,
            GoalDraftEditorContent,
            DraftSnapshot
          >
        | undefined,
    };
    const created = new AutoSaveCoordinator<
      typeof contentKey,
      GoalDraftEditorContent,
      DraftSnapshot
    >({
      initialValues: new Map([[contentKey, initialContent]]),
      initiallyHydrating: true,
      signal: lease.signal,
      isCurrent: lease.isCurrent,
      save: (entry, signal) => {
        const baseRevision = revisionRef.current;
        attemptBaseRevisionRef.current = baseRevision;
        return runtime.save(entry.value, baseRevision, signal);
      },
      savedValue: editorContent,
      onSaved: (_entry, result) => {
        if (!lease.isCurrent()) return;
        revisionRef.current = result.revision;
        if (mountedRef.current) setRevision(result.revision);
        const savedContent = editorContent(result);
        const current = own.current?.getCurrentValue(contentKey);
        if (
          current !== undefined &&
          contentEqual(current, savedContent) &&
          mountedRef.current
        )
          setContent(savedContent);
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
          content: entry.value,
          baseRevision: attemptBaseRevisionRef.current,
        };
        conflictSnapshotRef.current = conflict;
        const current = own.current?.getCurrentValue(contentKey) ?? entry.value;
        own.current?.block(contentKey, current, runtime.revisionConflictCode);
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
          body: value.body,
          successSignal: value.successSignal,
          baseRevision:
            conflictSnapshotRef.current?.baseRevision ?? revisionRef.current,
          updatedAt: new Date().toISOString(),
        };
        const stored = await queueBrowserOperation(async () => {
          await putBrowserDraft(draft);
          lastCachedDraftRef.current = draft;
          return true;
        });
        if (stored !== true) throw new Error("browser draft scope is inactive");
      },
      clearPersisted: async () => {
        const cleared = await queueBrowserOperation(async () => {
          const expected = lastCachedDraftRef.current;
          if (!expected) return true;
          await deleteBrowserDraftIfUnchanged(
            expected.userId,
            expected.subjectKey,
            expected.body,
            expected.baseRevision,
            expected.successSignal,
          );
          if (lastCachedDraftRef.current === expected)
            lastCachedDraftRef.current = undefined;
          return true;
        });
        if (cleared !== true)
          throw new Error("browser draft scope is inactive");
      },
      onPersistenceStatus: (available) => {
        if (mountedRef.current && lease.isCurrent())
          setBrowserCacheFailed(!available);
      },
      equals: contentEqual,
    });
    own.current = created;
    return created;
  }, [initialContent, lease, queueBrowserOperation, runtime]);

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
    async (
      href: string,
      options: DraftScopeMovedOptions = {},
    ): Promise<void> => {
      if (!lease.isCurrent()) return;
      const preserveUnsaved = options.preserveUnsaved ?? true;
      const conflict = conflictSnapshotRef.current;
      conflictSnapshotRef.current = undefined;
      const current = coordinator.getCurrentValue(contentKey);
      const saved = coordinator.getSavedValue(contentKey) ?? initialContent;
      const shouldPreserve =
        preserveUnsaved &&
        current !== undefined &&
        (!contentEqual(current, saved) ||
          conflict !== undefined ||
          coordinator.needsDraftPreservation(contentKey));
      scopeMovedHrefRef.current = href;
      coordinator.pause(true);
      coordinator.fail("AUTOSAVE_SCOPE_MOVED");
      coordinator.setPersistenceEnabled(false);
      if (current !== undefined)
        coordinator.block(contentKey, current, "AUTOSAVE_SCOPE_MOVED");
      if (mountedRef.current) {
        setScopeMovedHref(href);
        setRevisionConflictActive(false);
        setRecoveryConflict(null);
        setResolvingConflict(false);
      }
      try {
        if (shouldPreserve) {
          const draft: BrowserDraft = {
            userId: runtime.userId,
            goalId: runtime.goalId,
            subjectKey: runtime.subjectKey,
            body: current.body,
            successSignal: current.successSignal,
            baseRevision: conflict?.baseRevision ?? revisionRef.current,
            updatedAt: new Date().toISOString(),
          };
          const stored = await queueBrowserOperation(async () => {
            await putBrowserDraft(draft);
            return true;
          });
          if (stored !== true)
            throw new Error("browser draft scope is inactive");
          lastCachedDraftRef.current = draft;
        } else {
          const cleared = await lease.queueBrowserOperation(async () => {
            await deleteBrowserDraft(runtime.userId, runtime.subjectKey);
            return true;
          });
          if (cleared !== true)
            throw new Error("browser draft scope is inactive");
          lastCachedDraftRef.current = undefined;
        }
        if (mountedRef.current && lease.isCurrent())
          setBrowserCacheFailed(false);
      } catch {
        if (mountedRef.current && lease.isCurrent())
          setBrowserCacheFailed(true);
      }
    },
    [coordinator, initialContent, lease, queueBrowserOperation, runtime],
  );
  markScopeMovedRef.current = (href) => {
    void markScopeMoved(href);
  };

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
        const latestContent = editorContent(latest);
        coordinator.rebase(contentKey, latestContent);
        const current =
          coordinator.getCurrentValue(contentKey) ?? conflict.content;

        if (canonicalContentEqual(conflict.content, latestContent)) {
          conflictSnapshotRef.current = undefined;
          setRevisionConflictActive(false);
          setRecoveryConflict(null);
          coordinator.unblock(contentKey);
          if (
            canonicalContentEqual(current, latestContent) &&
            mountedRef.current
          )
            setContent(latestContent);
          return;
        }

        const localDraft: BrowserDraft = {
          userId: runtime.userId,
          goalId: runtime.goalId,
          subjectKey: runtime.subjectKey,
          body: current.body,
          successSignal: current.successSignal,
          baseRevision: conflict.baseRevision,
          updatedAt: new Date().toISOString(),
        };
        lastCachedDraftRef.current = localDraft;
        coordinator.block(contentKey, current, runtime.revisionConflictCode);
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
    [coordinator, lease, markScopeMoved, resolvingConflict, runtime],
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
    const unregisterPreserve = lease.onPreserve(() =>
      coordinator.preserveDrafts(),
    );
    const unregisterQuiesce = lease.onQuiesce(async (lifecycle) => {
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
      unregisterPreserve();
      unregisterQuiesce();
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
        if (
          canceled ||
          !draft ||
          hasEditedRef.current ||
          !lease.isCurrent() ||
          scopeMovedHrefRef.current !== null
        )
          return;

        const hydratedContent = browserDraftContent(
          draft,
          initialContent.successSignal,
        );
        const canonicalDraft: BrowserDraft = {
          ...draft,
          body: hydratedContent.body,
          successSignal: hydratedContent.successSignal,
        };
        lastCachedDraftRef.current = draft;
        if (
          canonicalDraft.body !== draft.body ||
          !Object.hasOwn(draft, "successSignal") ||
          canonicalDraft.successSignal !== draft.successSignal
        ) {
          const stored = await lease.queueBrowserOperation(async () => {
            await putBrowserDraft(canonicalDraft);
            return true;
          });
          if (stored !== true)
            throw new Error("browser draft scope is inactive");
          lastCachedDraftRef.current = canonicalDraft;
        }
        if (
          canceled ||
          hasEditedRef.current ||
          !lease.isCurrent() ||
          scopeMovedHrefRef.current !== null
        )
          return;

        if (canonicalDraft.baseRevision !== revisionRef.current) {
          conflictSnapshotRef.current = {
            content: hydratedContent,
            baseRevision: canonicalDraft.baseRevision,
          };
          coordinator.block(
            contentKey,
            hydratedContent,
            runtime.revisionConflictCode,
          );
          setContent(hydratedContent);
          setRecoveryConflict(canonicalDraft);
          setRevisionConflictActive(true);
          return;
        }
        const saved = coordinator.getSavedValue(contentKey);
        if (saved !== undefined && contentEqual(hydratedContent, saved)) {
          coordinator.flush(contentKey);
          return;
        }
        coordinator.edit(contentKey, hydratedContent);
        setContent(hydratedContent);
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
  }, [coordinator, initialContent.successSignal, lease, runtime]);

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
      const next = { ...content, body: value };
      coordinator.edit(contentKey, next);
      setContent(next);
    },
    [content, coordinator, revisionConflictActive, scopeMovedHref],
  );

  const setSuccessSignal = useCallback(
    (value: string) => {
      if (revisionConflictActive || scopeMovedHref) return;
      hasEditedRef.current = true;
      const next = { ...content, successSignal: value };
      coordinator.edit(contentKey, next);
      setContent(next);
    },
    [content, coordinator, revisionConflictActive, scopeMovedHref],
  );

  const flush = useCallback(() => coordinator.flush(contentKey), [coordinator]);

  const synchronize = useCallback(
    (nextContent: GoalDraftEditorContent, nextRevision: number) => {
      conflictSnapshotRef.current = undefined;
      setRevisionConflictActive(false);
      setRecoveryConflict(null);
      setResolvingConflict(false);
      setScopeMovedHref(null);
      scopeMovedHrefRef.current = null;
      revisionRef.current = nextRevision;
      coordinator.setPersistenceEnabled(true);
      coordinator.synchronize(contentKey, nextContent);
      setContent(nextContent);
      setRevision(nextRevision);
      void clearBrowserDraft();
    },
    [clearBrowserDraft, coordinator],
  );

  const pause = useCallback(() => coordinator.pause(), [coordinator]);

  const resume = useCallback(() => coordinator.resume(), [coordinator]);

  const discard = useCallback(async () => {
    conflictSnapshotRef.current = undefined;
    setRevisionConflictActive(false);
    setRecoveryConflict(null);
    setResolvingConflict(false);
    setScopeMovedHref(null);
    scopeMovedHrefRef.current = null;
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
    setContent(browserDraftContent(draft, initialContent.successSignal));
    coordinator.unblock(contentKey);
  }, [coordinator, initialContent.successSignal, recoveryConflict]);

  const discardRecovery = useCallback(() => {
    if (!recoveryConflict) return;
    const saved = coordinator.getSavedValue(contentKey) ?? initialContent;
    conflictSnapshotRef.current = undefined;
    setRevisionConflictActive(false);
    setRecoveryConflict(null);
    setResolvingConflict(false);
    coordinator.synchronize(contentKey, saved);
    setContent(saved);
    void clearBrowserDraft();
  }, [clearBrowserDraft, coordinator, initialContent, recoveryConflict]);

  return {
    body: content.body,
    setBody,
    successSignal: content.successSignal,
    setSuccessSignal,
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
    markScopeMoved,
    restoreRecovery,
    discardRecovery,
    browserCacheFailed,
    isActiveScope: () =>
      lease.isCurrent() && scopeMovedHrefRef.current === null,
  };
}
