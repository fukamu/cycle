import { useCallback, useRef, useState, type PropsWithChildren } from "react";

import { useAutoSaveScopeRegistry } from "../autosave/AutoSaveScopeProvider";
import {
  PostCommitCleanupContext,
  type PostCommitCleanupTask,
  type RunPostCommitCleanup,
} from "./postCommitCleanupContext";

type CleanupState = {
  readonly kind: "pending" | "failed";
  readonly task: PostCommitCleanupTask;
};

export function PostCommitCleanupBoundary({ children }: PropsWithChildren) {
  const registry = useAutoSaveScopeRegistry();
  const activeTaskRef = useRef<PostCommitCleanupTask | undefined>(undefined);
  const queuedTasksRef = useRef<PostCommitCleanupTask[]>([]);
  const attemptRef = useRef<Promise<boolean> | undefined>(undefined);
  const retainTerminalRef = useRef(false);
  const attemptCleanupRef = useRef<(task: PostCommitCleanupTask) => void>(
    () => undefined,
  );
  const [cleanupState, setCleanupState] = useState<CleanupState>();

  const attemptCleanup = useCallback(
    (task: PostCommitCleanupTask) => {
      if (attemptRef.current || activeTaskRef.current !== task) return;

      const attempt = (async () => {
        try {
          // Keep the route mounted until quiesce snapshots every active callback.
          // Replacing children first would let their layout-effect cleanup
          // unregister callbacks before the browser-operation tail is fenced.
          await registry.quiesce({ preserveDrafts: true });
          setCleanupState({ kind: "pending", task });
          await task.cleanup();
          await task.onSuccess();
          return true;
        } catch {
          setCleanupState({ kind: "failed", task });
          return false;
        }
      })();
      attemptRef.current = attempt;
      void attempt.then((succeeded) => {
        if (attemptRef.current !== attempt) return;
        attemptRef.current = undefined;
        if (!succeeded) return;

        retainTerminalRef.current ||= Boolean(task.retainTerminalOnSuccess);
        const nextTask = queuedTasksRef.current.shift();
        if (nextTask) {
          activeTaskRef.current = nextTask;
          attemptCleanupRef.current(nextTask);
          return;
        }

        activeTaskRef.current = undefined;
        if (!retainTerminalRef.current) setCleanupState(undefined);
      });
    },
    [registry],
  );
  attemptCleanupRef.current = attemptCleanup;

  const runPostCommitCleanup = useCallback<RunPostCommitCleanup>(
    (task) => {
      if (activeTaskRef.current) {
        queuedTasksRef.current.push(task);
        return;
      }
      activeTaskRef.current = task;
      attemptCleanup(task);
    },
    [attemptCleanup],
  );

  if (cleanupState) {
    return (
      <main className="page settings-page">
        <header className="page-heading">
          <p className="eyebrow">CLEANUP</p>
          <h1>処理を完了しています</h1>
        </header>
        <section className="settings-card">
          {cleanupState.kind === "pending" ? (
            <p role="status" aria-live="polite">
              {cleanupState.task.pendingMessage}
            </p>
          ) : (
            <>
              <p className="inline-error" role="alert">
                {cleanupState.task.failureMessage}
              </p>
              <button
                type="button"
                onClick={() => attemptCleanup(cleanupState.task)}
              >
                {cleanupState.task.retryLabel ?? "完了処理を再試行"}
              </button>
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <PostCommitCleanupContext.Provider value={runPostCommitCleanup}>
      {children}
    </PostCommitCleanupContext.Provider>
  );
}
