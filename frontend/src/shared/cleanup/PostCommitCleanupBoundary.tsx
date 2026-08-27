import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { flushSync } from "react-dom";
import { useLocation } from "react-router-dom";

import { useAutoSaveScopeRegistry } from "../autosave/AutoSaveScopeProvider";
import {
  PostCommitCleanupContext,
  PostCommitRouteOwnershipContext,
  type CapturePostCommitRouteOwnership,
  type PostCommitCleanupTask,
  type PostCommitRouteOwnershipToken,
  type PostCommitSessionOperationRunner,
  type RunPostCommitCleanup,
} from "./postCommitCleanupContext";

type CleanupEntry = {
  readonly task: PostCommitCleanupTask;
  identityIsCurrent: () => boolean;
  ownershipStarted: boolean;
  releaseOwnership: (() => void) | undefined;
  readonly resolveCompletion: () => void;
};

type CleanupState = {
  readonly kind: "quiescing" | "pending" | "failed";
  readonly entry: CleanupEntry;
};

type CleanupAttemptResult = {
  readonly succeeded: boolean;
  readonly retainTerminal: boolean;
};

type PostCommitCleanupBoundaryProps = PropsWithChildren<{
  readonly runSessionOperation: PostCommitSessionOperationRunner;
}>;

export function PostCommitCleanupBoundary({
  children,
  runSessionOperation,
}: PostCommitCleanupBoundaryProps) {
  const location = useLocation();
  const routeGenerationRef = useRef({
    generation: 0,
    locationKey: location.key,
  });
  useLayoutEffect(() => {
    const current = routeGenerationRef.current;
    if (current.locationKey === location.key) return;
    routeGenerationRef.current = {
      generation: current.generation + 1,
      locationKey: location.key,
    };
  }, [location.key]);
  const captureRouteOwnership =
    useCallback<CapturePostCommitRouteOwnership>(() => {
      const generation = routeGenerationRef.current.generation;
      return Object.freeze({
        isCurrent: () => routeGenerationRef.current.generation === generation,
      }) as PostCommitRouteOwnershipToken;
    }, []);
  const registry = useAutoSaveScopeRegistry();
  const activeEntryRef = useRef<CleanupEntry | undefined>(undefined);
  const queuedEntriesRef = useRef<CleanupEntry[]>([]);
  const attemptRef = useRef<Promise<CleanupAttemptResult> | undefined>(
    undefined,
  );
  const retainTerminalRef = useRef(false);
  const attemptCleanupRef = useRef<(entry: CleanupEntry) => void>(
    () => undefined,
  );
  const startOwnershipRef = useRef<(entry: CleanupEntry) => void>(
    () => undefined,
  );
  const [cleanupState, setCleanupState] = useState<CleanupState>();

  const attemptCleanup = useCallback(
    (entry: CleanupEntry) => {
      if (attemptRef.current || activeEntryRef.current !== entry) return;

      const attempt = (async () => {
        try {
          const identityIsCurrent = entry.identityIsCurrent;
          const publicationIsCurrent = () =>
            identityIsCurrent() &&
            (entry.task.routeOwnership?.isCurrent() ?? true);
          if (identityIsCurrent()) {
            // Keep the route mounted until quiesce snapshots every active callback.
            // Replacing children first would let their layout-effect cleanup
            // unregister callbacks before the browser-operation tail is fenced.
            await registry.quiesce({ preserveDrafts: true });
          }
          setCleanupState({ kind: "pending", entry });
          await entry.task.cleanup();
          if (publicationIsCurrent()) {
            await entry.task.onSuccess(publicationIsCurrent);
          }
          return {
            succeeded: true,
            retainTerminal:
              Boolean(entry.task.retainTerminalOnSuccess) &&
              publicationIsCurrent(),
          };
        } catch {
          setCleanupState({ kind: "failed", entry });
          return { succeeded: false, retainTerminal: false };
        }
      })();
      attemptRef.current = attempt;
      void attempt.then((result) => {
        if (attemptRef.current !== attempt) return;
        attemptRef.current = undefined;
        if (!result.succeeded) return;

        retainTerminalRef.current ||= result.retainTerminal;
        if (retainTerminalRef.current) return;

        entry.releaseOwnership?.();
        entry.releaseOwnership = undefined;
        const nextEntry = queuedEntriesRef.current.shift();
        if (nextEntry) {
          activeEntryRef.current = nextEntry;
          flushSync(() => {
            setCleanupState({ kind: "quiescing", entry: nextEntry });
          });
          startOwnershipRef.current(nextEntry);
          entry.resolveCompletion();
          return;
        }

        activeEntryRef.current = undefined;
        setCleanupState(undefined);
        entry.resolveCompletion();
      });
    },
    [registry],
  );
  attemptCleanupRef.current = attemptCleanup;

  const startOwnership = useCallback(
    (entry: CleanupEntry) => {
      if (entry.task.sessionOwnership) {
        entry.identityIsCurrent = entry.task.sessionOwnership.isCurrent;
        entry.ownershipStarted = true;
        attemptCleanupRef.current(entry);
        return;
      }
      if (entry.ownershipStarted) {
        attemptCleanupRef.current(entry);
        return;
      }

      entry.ownershipStarted = true;
      void runSessionOperation(
        entry.task.expectedUserId,
        (identityIsCurrent) => {
          entry.identityIsCurrent = identityIsCurrent;
          return new Promise<void>((resolve) => {
            entry.releaseOwnership = resolve;
            attemptCleanupRef.current(entry);
          });
        },
      ).catch(() => {
        if (activeEntryRef.current !== entry) return;
        entry.ownershipStarted = false;
        setCleanupState({ kind: "failed", entry });
      });
    },
    [runSessionOperation],
  );
  startOwnershipRef.current = startOwnership;

  const runPostCommitCleanup = useCallback<RunPostCommitCleanup>(
    (task) =>
      new Promise<void>((resolveCompletion) => {
        const entry: CleanupEntry = {
          task,
          identityIsCurrent: () => false,
          ownershipStarted: false,
          releaseOwnership: undefined,
          resolveCompletion,
        };
        if (activeEntryRef.current) {
          queuedEntriesRef.current.push(entry);
          return;
        }
        activeEntryRef.current = entry;
        flushSync(() => {
          setCleanupState({ kind: "quiescing", entry });
        });
        startOwnership(entry);
      }),
    [startOwnership],
  );

  if (cleanupState?.kind === "pending" || cleanupState?.kind === "failed") {
    return (
      <main className="page settings-page">
        <header className="page-heading">
          <p className="eyebrow">CLEANUP</p>
          <h1>処理を完了しています</h1>
        </header>
        <section className="settings-card">
          {cleanupState.kind === "pending" ? (
            <p role="status" aria-live="polite">
              {cleanupState.entry.task.pendingMessage}
            </p>
          ) : (
            <>
              <p className="inline-error" role="alert">
                {cleanupState.entry.task.failureMessage}
              </p>
              <button
                type="button"
                onClick={() => startOwnershipRef.current(cleanupState.entry)}
              >
                {cleanupState.entry.task.retryLabel ?? "完了処理を再試行"}
              </button>
            </>
          )}
        </section>
      </main>
    );
  }

  const quiescing = cleanupState?.kind === "quiescing";
  return (
    <PostCommitRouteOwnershipContext.Provider value={captureRouteOwnership}>
      <PostCommitCleanupContext.Provider value={runPostCommitCleanup}>
        {quiescing ? (
          <div className="app-message" role="status" aria-live="polite">
            {cleanupState.entry.task.pendingMessage}
          </div>
        ) : null}
        <div hidden={quiescing} inert={quiescing}>
          {children}
        </div>
      </PostCommitCleanupContext.Provider>
    </PostCommitRouteOwnershipContext.Provider>
  );
}
