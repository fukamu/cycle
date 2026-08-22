import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  type BrowserDraft,
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../drafts/browserDraftCache";
import {
  autoSaveDebounceMs,
  autoSaveRetryDelay,
  browserDraftDebounceMs,
  isRetryableAutoSaveError,
  maxAutoSaveRetries,
} from "./autoSavePolicy";

export type SimpleSaveState = "dirty" | "saving" | "saved" | "failed";

type Input = {
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly initialBody: string;
  readonly initialRevision: number;
  readonly save: (
    body: string,
    revision: number,
  ) => Promise<{ readonly body: string; readonly revision: number }>;
};

export function useDraftAutoSave(input: Input) {
  const { goalId, initialBody, initialRevision, save, subjectKey, userId } =
    input;
  const { control, reset, setValue } = useForm<{ body: string }>({
    defaultValues: { body: initialBody },
  });
  const body = useWatch({ control, name: "body" });
  const [revision, setRevision] = useState(initialRevision);
  const [state, setState] = useState<SimpleSaveState>("saved");
  const [recoveryConflict, setRecoveryConflict] = useState<BrowserDraft | null>(
    null,
  );
  const [browserCacheFailed, setBrowserCacheFailed] = useState(false);

  const bodyRef = useRef(initialBody);
  const revisionRef = useRef(initialRevision);
  const savedBodyRef = useRef(initialBody);
  const saveRef = useRef(save);
  saveRef.current = save;
  const inFlightRef = useRef(false);
  const pausedRef = useRef(false);
  const disposedRef = useRef(false);
  const discardedRef = useRef(false);
  const mountedRef = useRef(true);
  const conflictRef = useRef(false);
  const hasEditedRef = useRef(false);
  const editVersionRef = useRef(0);
  const retryCountRef = useRef(0);
  const lastInputAtRef = useRef(0);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const browserTimerRef = useRef<number | undefined>(undefined);
  const runSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const browserQueueRef = useRef(Promise.resolve());

  const updateState = useCallback((next: SimpleSaveState) => {
    if (mountedRef.current) setState(next);
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

  const deleteCachedDraft = useCallback(
    () => queueBrowserOperation(() => deleteBrowserDraft(userId, subjectKey)),
    [queueBrowserOperation, subjectKey, userId],
  );

  const cacheDraft = useCallback(
    (draftBody: string, baseRevision: number) => {
      if (discardedRef.current) return Promise.resolve();
      return queueBrowserOperation(() =>
        putBrowserDraft({
          userId,
          goalId,
          subjectKey,
          body: draftBody,
          baseRevision,
          updatedAt: new Date().toISOString(),
        }),
      );
    },
    [goalId, queueBrowserOperation, subjectKey, userId],
  );

  const persistCurrentDraft = useCallback(() => {
    if (conflictRef.current || discardedRef.current) return Promise.resolve();
    return bodyRef.current === savedBodyRef.current
      ? deleteCachedDraft()
      : cacheDraft(bodyRef.current, revisionRef.current);
  }, [cacheDraft, deleteCachedDraft]);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
  }, []);

  const clearBrowserTimer = useCallback(() => {
    if (browserTimerRef.current !== undefined) {
      window.clearTimeout(browserTimerRef.current);
      browserTimerRef.current = undefined;
    }
  }, []);

  const scheduleSave = useCallback(
    (delay: number) => {
      clearSaveTimer();
      if (
        pausedRef.current ||
        disposedRef.current ||
        conflictRef.current ||
        bodyRef.current === savedBodyRef.current
      )
        return;
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = undefined;
        void runSaveRef.current();
      }, delay);
    },
    [clearSaveTimer],
  );

  const scheduleBrowserDraft = useCallback(() => {
    clearBrowserTimer();
    if (conflictRef.current) return;
    browserTimerRef.current = window.setTimeout(() => {
      browserTimerRef.current = undefined;
      void persistCurrentDraft();
    }, browserDraftDebounceMs);
  }, [clearBrowserTimer, persistCurrentDraft]);

  const saveDetached = useCallback(
    (snapshot: string, baseRevision: number) => {
      void saveRef
        .current(snapshot, baseRevision)
        .then((result) => {
          revisionRef.current = result.revision;
          savedBodyRef.current = result.body;
          if (bodyRef.current === snapshot) {
            bodyRef.current = result.body;
            return deleteCachedDraft();
          }
          return cacheDraft(bodyRef.current, result.revision);
        })
        .catch(() => undefined);
    },
    [cacheDraft, deleteCachedDraft],
  );

  const runSave = useCallback(async () => {
    if (
      pausedRef.current ||
      disposedRef.current ||
      conflictRef.current ||
      inFlightRef.current
    )
      return;
    if (bodyRef.current === savedBodyRef.current) {
      updateState("saved");
      clearBrowserTimer();
      void deleteCachedDraft();
      return;
    }

    const snapshot = bodyRef.current;
    const snapshotEditVersion = editVersionRef.current;
    const baseRevision = revisionRef.current;
    inFlightRef.current = true;
    updateState("saving");
    let result:
      | { readonly body: string; readonly revision: number }
      | undefined;
    let failure: unknown;
    try {
      result = await saveRef.current(snapshot, baseRevision);
      revisionRef.current = result.revision;
      savedBodyRef.current = result.body;
      retryCountRef.current = 0;
      if (editVersionRef.current === snapshotEditVersion) {
        bodyRef.current = result.body;
        if (mountedRef.current) {
          reset({ body: result.body });
          setRevision(result.revision);
        }
      } else if (mountedRef.current) {
        setRevision(result.revision);
      }

      clearBrowserTimer();
      if (bodyRef.current === result.body) {
        void deleteCachedDraft();
        updateState("saved");
      } else {
        void cacheDraft(bodyRef.current, result.revision);
        updateState("dirty");
      }
    } catch (cause) {
      failure = cause;
    } finally {
      inFlightRef.current = false;
    }

    if (result) {
      if (bodyRef.current !== savedBodyRef.current) {
        if (disposedRef.current)
          saveDetached(bodyRef.current, revisionRef.current);
        else if (!pausedRef.current && !conflictRef.current) scheduleSave(0);
      }
      return;
    }

    if (disposedRef.current || pausedRef.current || conflictRef.current) return;
    void persistCurrentDraft();
    if (editVersionRef.current !== snapshotEditVersion) {
      retryCountRef.current = 0;
      updateState("dirty");
      const elapsed = Date.now() - lastInputAtRef.current;
      scheduleSave(Math.max(0, autoSaveDebounceMs - elapsed));
      return;
    }
    if (
      isRetryableAutoSaveError(failure) &&
      retryCountRef.current < maxAutoSaveRetries
    ) {
      retryCountRef.current += 1;
      updateState("dirty");
      scheduleSave(autoSaveRetryDelay(retryCountRef.current));
      return;
    }
    updateState("failed");
  }, [
    cacheDraft,
    clearBrowserTimer,
    deleteCachedDraft,
    persistCurrentDraft,
    reset,
    saveDetached,
    scheduleSave,
    updateState,
  ]);
  runSaveRef.current = runSave;

  useEffect(() => {
    let canceled = false;
    void getBrowserDraft(userId, subjectKey)
      .then((draft) => {
        if (canceled || hasEditedRef.current || !draft) return;
        if (draft.baseRevision !== revisionRef.current) {
          conflictRef.current = true;
          bodyRef.current = draft.body;
          setValue("body", draft.body);
          setRecoveryConflict(draft);
          setState("failed");
          return;
        }
        if (draft.body === savedBodyRef.current) {
          void deleteCachedDraft();
          return;
        }
        bodyRef.current = draft.body;
        editVersionRef.current += 1;
        setValue("body", draft.body);
        setState("dirty");
        scheduleSave(autoSaveDebounceMs);
      })
      .catch(() => {
        if (!canceled) setBrowserCacheFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [deleteCachedDraft, scheduleSave, setValue, subjectKey, userId]);

  useEffect(() => {
    const handleOnline = () => {
      if (
        pausedRef.current ||
        conflictRef.current ||
        bodyRef.current === savedBodyRef.current
      )
        return;
      retryCountRef.current = 0;
      updateState("dirty");
      scheduleSave(0);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [scheduleSave, updateState]);

  useEffect(() => {
    mountedRef.current = true;
    disposedRef.current = false;
    return () => {
      mountedRef.current = false;
      disposedRef.current = true;
      clearSaveTimer();
      clearBrowserTimer();
      if (conflictRef.current || discardedRef.current) return;
      if (bodyRef.current !== savedBodyRef.current) {
        void cacheDraft(bodyRef.current, revisionRef.current);
        if (!pausedRef.current && !inFlightRef.current)
          saveDetached(bodyRef.current, revisionRef.current);
      }
    };
  }, [cacheDraft, clearBrowserTimer, clearSaveTimer, saveDetached]);

  const setBody = useCallback(
    (value: string) => {
      if (conflictRef.current) return;
      hasEditedRef.current = true;
      editVersionRef.current += 1;
      retryCountRef.current = 0;
      lastInputAtRef.current = Date.now();
      bodyRef.current = value;
      setValue("body", value);
      if (!inFlightRef.current)
        updateState(value === savedBodyRef.current ? "saved" : "dirty");
      scheduleBrowserDraft();
      scheduleSave(autoSaveDebounceMs);
    },
    [scheduleBrowserDraft, scheduleSave, setValue, updateState],
  );

  const flush = useCallback(() => {
    if (conflictRef.current || pausedRef.current) return;
    clearBrowserTimer();
    void persistCurrentDraft();
    clearSaveTimer();
    void runSaveRef.current();
  }, [clearBrowserTimer, clearSaveTimer, persistCurrentDraft]);

  const synchronize = useCallback(
    (nextBody: string, nextRevision: number) => {
      clearSaveTimer();
      clearBrowserTimer();
      conflictRef.current = false;
      discardedRef.current = false;
      setRecoveryConflict(null);
      bodyRef.current = nextBody;
      revisionRef.current = nextRevision;
      savedBodyRef.current = nextBody;
      retryCountRef.current = 0;
      editVersionRef.current += 1;
      reset({ body: nextBody });
      setRevision(nextRevision);
      setState("saved");
      void deleteCachedDraft();
    },
    [clearBrowserTimer, clearSaveTimer, deleteCachedDraft, reset],
  );

  const pause = useCallback(() => {
    pausedRef.current = true;
    clearSaveTimer();
  }, [clearSaveTimer]);

  const resume = useCallback(() => {
    pausedRef.current = false;
    discardedRef.current = false;
    retryCountRef.current = 0;
    if (!conflictRef.current && bodyRef.current !== savedBodyRef.current) {
      updateState("dirty");
      scheduleSave(0);
    }
  }, [scheduleSave, updateState]);

  const discard = useCallback(async () => {
    pausedRef.current = true;
    discardedRef.current = true;
    clearSaveTimer();
    clearBrowserTimer();
    conflictRef.current = false;
    setRecoveryConflict(null);
    await deleteCachedDraft();
  }, [clearBrowserTimer, clearSaveTimer, deleteCachedDraft]);

  const retry = useCallback(() => {
    if (conflictRef.current || pausedRef.current) return;
    retryCountRef.current = 0;
    updateState("dirty");
    scheduleSave(0);
  }, [scheduleSave, updateState]);

  const restoreRecovery = useCallback(() => {
    const draft = recoveryConflict;
    if (!draft) return;
    conflictRef.current = false;
    setRecoveryConflict(null);
    hasEditedRef.current = true;
    editVersionRef.current += 1;
    retryCountRef.current = 0;
    bodyRef.current = draft.body;
    setValue("body", draft.body);
    setState("dirty");
    void cacheDraft(draft.body, revisionRef.current);
    scheduleSave(0);
  }, [cacheDraft, recoveryConflict, scheduleSave, setValue]);

  const discardRecovery = useCallback(() => {
    if (!recoveryConflict) return;
    conflictRef.current = false;
    setRecoveryConflict(null);
    bodyRef.current = savedBodyRef.current;
    editVersionRef.current += 1;
    reset({ body: savedBodyRef.current });
    setState("saved");
    void deleteCachedDraft();
  }, [deleteCachedDraft, recoveryConflict, reset]);

  return {
    body,
    setBody,
    revision,
    state,
    retry,
    flush,
    synchronize,
    pause,
    resume,
    discard,
    recoveryConflict,
    restoreRecovery,
    discardRecovery,
    browserCacheFailed,
  };
}
