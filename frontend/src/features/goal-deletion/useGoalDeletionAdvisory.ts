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

export function useGoalDeletionAdvisory({
  getCurrentUserId,
  onAcceptedGoalDeletionAdvisory,
  factory,
}: GoalDeletionAdvisoryOptions): GoalDeletionAdvisoryRegistry {
  const advisoryRef = useRef<GoalDeletionAdvisory | null>(null);
  const listenersByUserRef = useRef(new Map<string, GoalListeners>());
  const getCurrentUserIdRef = useRef(getCurrentUserId);
  const onAcceptedGoalDeletionAdvisoryRef = useRef(
    onAcceptedGoalDeletionAdvisory,
  );
  useLayoutEffect(() => {
    getCurrentUserIdRef.current = getCurrentUserId;
    onAcceptedGoalDeletionAdvisoryRef.current = onAcceptedGoalDeletionAdvisory;
  }, [getCurrentUserId, onAcceptedGoalDeletionAdvisory]);

  useEffect(() => {
    const advisory = createGoalDeletionAdvisory(
      (deletedUserId, deletedGoalId) => {
        let currentUserId: string | undefined;
        try {
          currentUserId = getCurrentUserIdRef.current();
        } catch {
          return;
        }
        if (currentUserId !== deletedUserId) return;

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

        try {
          onAcceptedGoalDeletionAdvisoryRef.current({
            deletedUserId,
            deletedGoalId,
            subscriberNotified,
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
  }, [factory]);

  const publish = useCallback(
    (deletedUserId: string, deletedGoalId: string) => {
      advisoryRef.current?.publish(deletedUserId, deletedGoalId);
    },
    [],
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
    [],
  );

  return useMemo(() => ({ publish, subscribe }), [publish, subscribe]);
}
