import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useCallback, useMemo, type RefObject } from "react";

import { APIError, SessionIdentityError } from "../../shared/api/client";
import type { Session } from "../../shared/api/schemas";
import {
  sessionRecoveryEvents,
  type SessionRecoverySubscription,
} from "../../shared/api/sessionRecoveryEvents";
import type { PostCommitSessionOwnershipToken } from "../../shared/cleanup/postCommitCleanupContext";
import type { AuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import type {
  RunPostCommitSessionOperation,
  RunSessionTransition,
  RunTerminalSessionOperation,
} from "./sessionContext";
import type { PublishSession } from "./sessionBoundaryContracts";
import { runSessionCookieWriter } from "./sessionCookieWriter";

type EnqueueTransition = <Result>(
  operation: () => Promise<Result>,
) => Promise<Result>;

type SessionOperationRunnerOptions = {
  readonly queryClient: QueryClient;
  readonly sessionQueryKey: QueryKey;
  readonly enqueueTransition: EnqueueTransition;
  readonly leaseOwner: AuthenticatedRequestLeaseOwner;
  readonly recoverySubscriptionRef: RefObject<SessionRecoverySubscription | null>;
  readonly suspendInteractionAndInvalidateLease: () => void;
  readonly markSessionRecoveryRequired: () => void;
  readonly handoffStaleRecovery: () => void;
  readonly publishIdentityAdvisory: (targetUserId: string) => void;
  readonly publishSession: PublishSession;
};

export type SessionOperationRunners = {
  readonly runTerminalSessionOperation: RunTerminalSessionOperation;
  readonly runPostCommitSessionOperation: RunPostCommitSessionOperation;
  readonly runSessionTransition: RunSessionTransition;
};

export function useSessionOperationRunners({
  queryClient,
  sessionQueryKey,
  enqueueTransition,
  leaseOwner,
  recoverySubscriptionRef,
  suspendInteractionAndInvalidateLease,
  markSessionRecoveryRequired,
  handoffStaleRecovery,
  publishIdentityAdvisory,
  publishSession,
}: SessionOperationRunnerOptions): SessionOperationRunners {
  const runTerminalSessionOperation = useCallback<RunTerminalSessionOperation>(
    (expectedUserId, operation) =>
      enqueueTransition(async () => {
        const currentSession =
          queryClient.getQueryData<Session>(sessionQueryKey);
        if (currentSession === undefined) {
          throw new Error("session unavailable");
        }
        if (currentSession.user.id !== expectedUserId) {
          throw new Error("session operation interrupted");
        }
        const lease = leaseOwner.requireCurrent(expectedUserId);
        const subscription = recoverySubscriptionRef.current;
        const ownership = Object.freeze({
          isCurrent: () =>
            recoverySubscriptionRef.current === subscription &&
            lease.isCurrent() &&
            queryClient.getQueryData<Session>(sessionQueryKey)?.user.id ===
              expectedUserId,
        }) as PostCommitSessionOwnershipToken;
        return operation(currentSession, lease, ownership);
      }),
    [
      enqueueTransition,
      leaseOwner,
      queryClient,
      recoverySubscriptionRef,
      sessionQueryKey,
    ],
  );

  const runPostCommitSessionOperation =
    useCallback<RunPostCommitSessionOperation>(
      (expectedUserId, operation) =>
        enqueueTransition(async () => {
          const currentSession =
            queryClient.getQueryData<Session>(sessionQueryKey);
          if (currentSession === undefined) {
            throw new Error("session unavailable");
          }
          const capturedLease = leaseOwner.active();
          return operation(
            () =>
              currentSession.user.id === expectedUserId &&
              capturedLease?.expectedUserId === expectedUserId &&
              capturedLease.isCurrent() &&
              queryClient.getQueryData<Session>(sessionQueryKey)?.user.id ===
                expectedUserId,
          );
        }),
      [enqueueTransition, leaseOwner, queryClient, sessionQueryKey],
    );

  const runSessionTransition = useCallback<RunSessionTransition>(
    (expectedUserId, request) => {
      const subscription = recoverySubscriptionRef.current;
      const isCurrent = () => recoverySubscriptionRef.current === subscription;
      return enqueueTransition(async () => {
        const transition = await runSessionCookieWriter(
          { isCurrent },
          async () => {
            const previousSession =
              queryClient.getQueryData<Session>(sessionQueryKey);
            if (previousSession === undefined) {
              throw new Error("session unavailable");
            }
            if (previousSession.user.id !== expectedUserId) {
              throw new Error("session transition interrupted");
            }
            const lease = leaseOwner.requireCurrent(expectedUserId);
            let nextSession: Session;
            try {
              nextSession = await request(previousSession, lease);
            } catch (error) {
              if (
                !(error instanceof APIError) &&
                !(error instanceof SessionIdentityError)
              ) {
                if (isCurrent()) {
                  // A successful auth response may already have changed the
                  // cookie before validation or delivery becomes uncertain.
                  suspendInteractionAndInvalidateLease();
                  markSessionRecoveryRequired();
                  sessionRecoveryEvents.capturePublisher()("CSRF_INVALID");
                } else {
                  handoffStaleRecovery();
                }
              }
              throw error;
            }
            if (!lease.isCurrent()) {
              handoffStaleRecovery();
              throw new Error("session transition interrupted");
            }
            if (nextSession.user.id !== previousSession.user.id) {
              publishIdentityAdvisory(nextSession.user.id);
            }
            const published = await publishSession(nextSession, {
              scopesAlreadyQuiesced: false,
              remountSameIdentity: false,
              isCurrent,
            });
            if (!published) {
              handoffStaleRecovery();
              throw new Error("session transition interrupted");
            }
            return { previousSession, session: nextSession };
          },
        );
        if (transition === null) {
          handoffStaleRecovery();
          throw new Error("session transition interrupted");
        }
        return transition;
      });
    },
    [
      enqueueTransition,
      handoffStaleRecovery,
      leaseOwner,
      markSessionRecoveryRequired,
      publishIdentityAdvisory,
      publishSession,
      queryClient,
      recoverySubscriptionRef,
      sessionQueryKey,
      suspendInteractionAndInvalidateLease,
    ],
  );

  return useMemo(
    () => ({
      runTerminalSessionOperation,
      runPostCommitSessionOperation,
      runSessionTransition,
    }),
    [
      runPostCommitSessionOperation,
      runSessionTransition,
      runTerminalSessionOperation,
    ],
  );
}
