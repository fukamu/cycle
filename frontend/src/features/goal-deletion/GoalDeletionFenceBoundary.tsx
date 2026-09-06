import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from "react";
import { useNavigate } from "react-router-dom";

import { APIError } from "../../shared/api/client";
import {
  type PostCommitRouteOwnershipToken,
  useCapturePostCommitRouteOwnership,
  usePostCommitCleanup,
} from "../../shared/cleanup/postCommitCleanupContext";
import { tombstoneDeletedGoalAndClearDrafts } from "../../shared/drafts/browserDraftCache";
import { removeGoalFromCache } from "../goal-collection";
import {
  useBeginGoalDeletionCleanup,
  usePublishGoalDeletionAdvisory,
  useSubscribeGoalDeletionAdvisory,
} from "./goalDeletionContext";

export type StartGoalDeletionFence = (
  routeOwnership: PostCommitRouteOwnershipToken,
) => void;

export type RunGoalDeletionFencedRequest = <Result>(
  request: () => Promise<Result>,
) => Promise<Result>;

type GoalDeletionFenceListener = () => void;
type GoalDeletionFenceSource = "local" | "advisory";

type GoalDeletionFenceController = {
  readonly registerEditorFence: (
    listener: GoalDeletionFenceListener,
  ) => () => void;
  readonly runFencedRequest: RunGoalDeletionFencedRequest;
  readonly start: StartGoalDeletionFence;
};

const GoalDeletionFenceContext =
  createContext<GoalDeletionFenceController | null>(null);

export function GoalDeletionFenceBoundary({
  userId,
  goalId,
  children,
}: PropsWithChildren<{
  readonly userId: string;
  readonly goalId: string;
}>) {
  return (
    <GoalDeletionFenceControllerBoundary
      key={`${userId}:${goalId}`}
      userId={userId}
      goalId={goalId}
    >
      {children}
    </GoalDeletionFenceControllerBoundary>
  );
}

function GoalDeletionFenceControllerBoundary({
  userId,
  goalId,
  children,
}: PropsWithChildren<{
  readonly userId: string;
  readonly goalId: string;
}>) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const captureRouteOwnership = useCapturePostCommitRouteOwnership();
  const runPostCommitCleanup = usePostCommitCleanup();
  const beginCleanup = useBeginGoalDeletionCleanup();
  const publishGoalDeletionAdvisory = usePublishGoalDeletionAdvisory();
  const subscribeGoalDeletionAdvisory = useSubscribeGoalDeletionAdvisory();
  const listenersRef = useRef(new Set<GoalDeletionFenceListener>());
  const startedRef = useRef(false);

  const start = useCallback(
    (
      routeOwnership: PostCommitRouteOwnershipToken,
      source: GoalDeletionFenceSource,
    ) => {
      for (const listener of [...listenersRef.current]) {
        try {
          listener();
        } catch {
          // Every mounted editor gets its synchronous privacy fence even if a
          // sibling listener is broken. Durable cleanup must continue as well.
        }
      }

      if (startedRef.current) return;
      startedRef.current = true;

      const claim = beginCleanup(userId, goalId);
      if (claim.kind === "joined") {
        void claim.completion.then(() => {
          if (!routeOwnership.isCurrent()) return;
          navigate("/", { replace: true, flushSync: true });
        });
        return;
      }

      if (source === "local") {
        try {
          publishGoalDeletionAdvisory(userId, goalId);
        } catch {
          // Cross-context notification is advisory; local durable cleanup is
          // the canonical privacy operation and must still run.
        }
      }

      const completion = runPostCommitCleanup({
        expectedUserId: userId,
        routeOwnership,
        cleanup: async () => {
          await tombstoneDeletedGoalAndClearDrafts(userId, goalId);
          removeGoalFromCache(cache, userId, goalId);
          if (source === "local") {
            try {
              publishGoalDeletionAdvisory(userId, goalId);
            } catch {
              // The confirmation is best-effort after the durable tombstone.
            }
          }
        },
        onSuccess: (publicationIsCurrent) => {
          if (!publicationIsCurrent()) return;
          navigate("/", { replace: true, flushSync: true });
        },
        pendingMessage: "削除済みGoalのブラウザ下書きを削除しています…",
        failureMessage: "削除済みGoalのブラウザ下書きを削除できませんでした。",
        retryLabel: "ブラウザデータの削除を再試行",
      });
      void completion.then(claim.complete, () => {
        // Keep the tuple claim when its owner cannot finish cleanup. A later
        // route must join the same privacy operation rather than repeat the
        // transport that witnessed deletion.
      });
    },
    [
      beginCleanup,
      cache,
      goalId,
      navigate,
      publishGoalDeletionAdvisory,
      runPostCommitCleanup,
      userId,
    ],
  );

  const startLocal = useCallback<StartGoalDeletionFence>(
    (routeOwnership) => start(routeOwnership, "local"),
    [start],
  );

  const registerEditorFence = useCallback(
    (listener: GoalDeletionFenceListener) => {
      const listeners = listenersRef.current;
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    [],
  );

  const runFencedRequest = useCallback<RunGoalDeletionFencedRequest>(
    async (request) => {
      const routeOwnership = captureRouteOwnership();
      try {
        return await request();
      } catch (error) {
        if (
          error instanceof APIError &&
          error.status === 404 &&
          error.code === "GOAL_NOT_FOUND"
        ) {
          startLocal(routeOwnership);
        }
        throw error;
      }
    },
    [captureRouteOwnership, startLocal],
  );

  useLayoutEffect(
    () =>
      subscribeGoalDeletionAdvisory(userId, goalId, () => {
        start(captureRouteOwnership(), "advisory");
      }),
    [
      captureRouteOwnership,
      goalId,
      start,
      subscribeGoalDeletionAdvisory,
      userId,
    ],
  );

  const value = useMemo<GoalDeletionFenceController>(
    () => ({
      registerEditorFence,
      runFencedRequest,
      start: startLocal,
    }),
    [registerEditorFence, runFencedRequest, startLocal],
  );

  return (
    <GoalDeletionFenceContext.Provider value={value}>
      {children}
    </GoalDeletionFenceContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- route features consume the hook paired with this boundary
export function useStartGoalDeletionFence(): StartGoalDeletionFence {
  return useGoalDeletionFenceController().start;
}

// eslint-disable-next-line react-refresh/only-export-components -- route features consume the hook paired with this boundary
export function useGoalDeletionEditorFence(
  listener: GoalDeletionFenceListener,
): void {
  const { registerEditorFence } = useGoalDeletionFenceController();
  useLayoutEffect(
    () => registerEditorFence(listener),
    [listener, registerEditorFence],
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- route features consume the hook paired with this boundary
export function useRunGoalDeletionFencedRequest(): RunGoalDeletionFencedRequest {
  return useGoalDeletionFenceController().runFencedRequest;
}

function useGoalDeletionFenceController(): GoalDeletionFenceController {
  const value = useContext(GoalDeletionFenceContext);
  if (value === null) {
    throw new Error(
      "Goal deletion fence hooks must be used within GoalDeletionFenceBoundary",
    );
  }
  return value;
}
