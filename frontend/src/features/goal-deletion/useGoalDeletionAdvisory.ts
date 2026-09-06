import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { isUUIDv7 } from "../../shared/id/uuid";
import {
  createGoalDeletionAdvisory,
  type GoalDeletionAdvisory,
  type GoalDeletionAdvisoryFactory,
} from "./goalDeletionAdvisory";
import type {
  BeginGoalDeletionCleanup,
  GoalDeletionCleanupOutcome,
  GoalDeletionAdvisoryRegistry,
  SubscribeGoalDeletionAdvisory,
} from "./goalDeletionContext";

export type AcceptedGoalDeletionAdvisory = {
  readonly deletedUserId: string;
  readonly deletedGoalId: string;
  readonly subscriberNotified: boolean;
};

export type GoalDeletionAdvisoryOptions = {
  readonly getCurrentUserId: () => string | undefined;
  readonly onAcceptedGoalDeletionAdvisory: (
    receipt: AcceptedGoalDeletionAdvisory,
  ) => void;
  readonly factory?: GoalDeletionAdvisoryFactory | undefined;
};

type GoalListeners = Map<string, Set<() => void>>;
type KnownGoalDeletions = Map<string, Set<string>>;

type GoalDeletionCleanup = {
  readonly completion: Promise<GoalDeletionCleanupOutcome>;
  readonly resolve: (outcome: GoalDeletionCleanupOutcome) => void;
};

type GoalDeletionCleanups = Map<string, GoalDeletionCleanup>;

export function useGoalDeletionAdvisory({
  getCurrentUserId,
  onAcceptedGoalDeletionAdvisory,
  factory,
}: GoalDeletionAdvisoryOptions): GoalDeletionAdvisoryRegistry {
  const advisoryRef = useRef<GoalDeletionAdvisory | null>(null);
  const listenersByUserRef = useRef(new Map<string, GoalListeners>());
  const knownDeletionsByUserRef = useRef<KnownGoalDeletions>(new Map());
  const cleanupsByUserRef = useRef(new Map<string, GoalDeletionCleanups>());
  const getCurrentUserIdRef = useRef(getCurrentUserId);
  const onAcceptedGoalDeletionAdvisoryRef = useRef(
    onAcceptedGoalDeletionAdvisory,
  );
  useLayoutEffect(() => {
    getCurrentUserIdRef.current = getCurrentUserId;
    onAcceptedGoalDeletionAdvisoryRef.current = onAcceptedGoalDeletionAdvisory;
  }, [getCurrentUserId, onAcceptedGoalDeletionAdvisory]);

  const rememberDeletion = useCallback(
    (deletedUserId: string, deletedGoalId: string) => {
      let knownGoals = knownDeletionsByUserRef.current.get(deletedUserId);
      if (knownGoals === undefined) {
        knownGoals = new Set();
        knownDeletionsByUserRef.current.set(deletedUserId, knownGoals);
      }
      knownGoals.add(deletedGoalId);
    },
    [],
  );

  const isKnown = useCallback(
    (userId: string, goalId: string) =>
      knownDeletionsByUserRef.current.get(userId)?.has(goalId) ?? false,
    [],
  );

  const notifyMatchingSubscribers = useCallback(
    (
      deletedUserId: string,
      deletedGoalId: string,
    ): { readonly accepted: boolean; readonly subscriberNotified: boolean } => {
      let currentUserId: string | undefined;
      try {
        currentUserId = getCurrentUserIdRef.current();
      } catch {
        return { accepted: false, subscriberNotified: false };
      }
      if (currentUserId !== deletedUserId)
        return { accepted: false, subscriberNotified: false };

      rememberDeletion(deletedUserId, deletedGoalId);

      const listeners = listenersByUserRef.current
        .get(deletedUserId)
        ?.get(deletedGoalId);
      let subscriberNotified = false;
      if (listeners !== undefined) {
        for (const listener of [...listeners]) {
          try {
            listener();
            subscriberNotified = true;
          } catch {
            // One broken subscriber must not suppress other local fences.
          }
        }
      }
      return { accepted: true, subscriberNotified };
    },
    [rememberDeletion],
  );

  useEffect(() => {
    const advisory = createGoalDeletionAdvisory(
      (deletedUserId, deletedGoalId) => {
        const notification = notifyMatchingSubscribers(
          deletedUserId,
          deletedGoalId,
        );
        if (!notification.accepted) return;

        try {
          onAcceptedGoalDeletionAdvisoryRef.current({
            deletedUserId,
            deletedGoalId,
            subscriberNotified: notification.subscriberNotified,
          });
        } catch {
          // The provider callback is advisory; durable deletion remains canonical.
        }
      },
      factory,
    );
    advisoryRef.current = advisory;
    return () => {
      advisory?.close();
      if (advisoryRef.current === advisory) advisoryRef.current = null;
    };
  }, [factory, notifyMatchingSubscribers]);

  const publish = useCallback(
    (deletedUserId: string, deletedGoalId: string) => {
      if (isUUIDv7(deletedUserId) && isUUIDv7(deletedGoalId)) {
        rememberDeletion(deletedUserId, deletedGoalId);
        // BroadcastChannel does not deliver a sender's own message. Notify
        // another active route generation in this document before sending the
        // cross-context advisory so every matching editor is fenced promptly.
        notifyMatchingSubscribers(deletedUserId, deletedGoalId);
      }
      advisoryRef.current?.publish(deletedUserId, deletedGoalId);
    },
    [notifyMatchingSubscribers, rememberDeletion],
  );

  const subscribe = useCallback<SubscribeGoalDeletionAdvisory>(
    (userId, goalId, listener) => {
      if (!isUUIDv7(userId) || !isUUIDv7(goalId)) return () => undefined;

      let listenersByGoal = listenersByUserRef.current.get(userId);
      if (listenersByGoal === undefined) {
        listenersByGoal = new Map();
        listenersByUserRef.current.set(userId, listenersByGoal);
      }
      let listeners = listenersByGoal.get(goalId);
      if (listeners === undefined) {
        listeners = new Set();
        listenersByGoal.set(goalId, listeners);
      }
      const registeredListener = () => listener();
      listeners.add(registeredListener);

      let currentUserId: string | undefined;
      try {
        currentUserId = getCurrentUserIdRef.current();
      } catch {
        currentUserId = undefined;
      }
      if (currentUserId === userId && isKnown(userId, goalId)) {
        try {
          registeredListener();
        } catch {
          // An earlier subscriber-free fallback still owns durable cleanup.
          // A broken late subscriber must not make registration itself fail.
        }
      }

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(registeredListener);
        if (listeners.size > 0) return;
        listenersByGoal.delete(goalId);
        if (listenersByGoal.size === 0)
          listenersByUserRef.current.delete(userId);
      };
    },
    [isKnown],
  );

  const beginCleanup = useCallback<BeginGoalDeletionCleanup>(
    (userId, goalId) => {
      let cleanupsByGoal = cleanupsByUserRef.current.get(userId);
      const existingCleanup = cleanupsByGoal?.get(goalId);
      if (existingCleanup !== undefined) {
        return {
          kind: "joined",
          completion: existingCleanup.completion,
        };
      }

      let resolveCompletion: (
        outcome: GoalDeletionCleanupOutcome,
      ) => void = () => undefined;
      const completion = new Promise<GoalDeletionCleanupOutcome>((resolve) => {
        resolveCompletion = resolve;
      });
      const cleanup: GoalDeletionCleanup = {
        completion,
        resolve: resolveCompletion,
      };
      if (cleanupsByGoal === undefined) {
        cleanupsByGoal = new Map();
        cleanupsByUserRef.current.set(userId, cleanupsByGoal);
      }
      cleanupsByGoal.set(goalId, cleanup);

      let settled = false;
      const settle = (outcome: GoalDeletionCleanupOutcome) => {
        if (settled) return;
        settled = true;

        if (outcome === "failed") {
          const currentCleanupsByGoal = cleanupsByUserRef.current.get(userId);
          if (currentCleanupsByGoal?.get(goalId) === cleanup) {
            currentCleanupsByGoal.delete(goalId);
            if (currentCleanupsByGoal.size === 0) {
              cleanupsByUserRef.current.delete(userId);
            }
          }
        }
        cleanup.resolve(outcome);
      };
      return {
        kind: "owner",
        completion,
        complete: () => settle("completed"),
        fail: () => settle("failed"),
      };
    },
    [],
  );

  return useMemo(
    () => ({ publish, subscribe, beginCleanup, isKnown }),
    [beginCleanup, isKnown, publish, subscribe],
  );
}
