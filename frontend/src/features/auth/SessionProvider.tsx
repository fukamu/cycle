import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import type { Session } from "../../shared/api/schemas";
import type { SessionRecoverySubscription } from "../../shared/api/sessionRecoveryEvents";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
} from "../../shared/autosave/AutoSaveScopeProvider";
import {
  cleanupExpiredBrowserDrafts,
  tombstoneDeletedGoalAndClearDrafts,
} from "../../shared/drafts/browserDraftCache";
import { removeGoalFromCache } from "../goal-collection";
import {
  type AcceptedGoalDeletionAdvisory,
  GoalDeletionAdvisoryContext,
  type GoalDeletionAdvisoryFactory,
  useGoalDeletionAdvisory,
} from "../goal-deletion";
import type { AccountDeletionAdvisoryFactory } from "./accountDeletionAdvisory";
import { AccountDeletionAdvisoryPublishContext } from "./accountDeletionContext";
import { useAuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import { SessionBoundaryPresentation } from "./SessionBoundaryPresentation";
import {
  createAnonymousSession,
  isUnavailableSession,
  requestCurrentSession,
  sessionQueryKey,
} from "./sessionDiscovery";
import type { SessionIdentityAdvisoryFactory } from "./sessionIdentityAdvisory";
import { useSessionIdentityAdvisory } from "./useSessionIdentityAdvisory";
import { useSessionOperationRunners } from "./sessionOperationRunners";
import { useSessionRecoveryController } from "./sessionRecoveryController";
import { useAccountDeletionAdvisory } from "./useAccountDeletionAdvisory";
import { useInitialSessionDiscovery } from "./useInitialSessionDiscovery";
import { useSessionPublicationController } from "./useSessionPublicationController";

export { SessionIdentityBoundary } from "./SessionBoundaryPresentation";

type SessionProviderProps = PropsWithChildren<{
  readonly reloadApplication?: () => void;
  readonly advisoryFactory?: SessionIdentityAdvisoryFactory;
  readonly accountDeletionAdvisoryFactory?: AccountDeletionAdvisoryFactory;
  readonly goalDeletionAdvisoryFactory?: GoalDeletionAdvisoryFactory;
}>;

export function SessionProvider({
  children,
  reloadApplication = reloadFromServer,
  advisoryFactory,
  accountDeletionAdvisoryFactory,
  goalDeletionAdvisoryFactory,
}: SessionProviderProps) {
  const browserDraftCleanupStarted = useRef(false);

  useEffect(() => {
    if (browserDraftCleanupStarted.current) return;
    browserDraftCleanupStarted.current = true;
    void cleanupExpiredBrowserDrafts().catch(() => undefined);
  }, []);

  return (
    <AutoSaveScopeProvider>
      <SessionBoundary
        reloadApplication={reloadApplication}
        advisoryFactory={advisoryFactory}
        accountDeletionAdvisoryFactory={accountDeletionAdvisoryFactory}
        goalDeletionAdvisoryFactory={goalDeletionAdvisoryFactory}
      >
        {children}
      </SessionBoundary>
    </AutoSaveScopeProvider>
  );
}

function SessionBoundary({
  children,
  reloadApplication,
  advisoryFactory,
  accountDeletionAdvisoryFactory,
  goalDeletionAdvisoryFactory,
}: PropsWithChildren<{
  readonly reloadApplication: () => void;
  readonly advisoryFactory: SessionIdentityAdvisoryFactory | undefined;
  readonly accountDeletionAdvisoryFactory:
    | AccountDeletionAdvisoryFactory
    | undefined;
  readonly goalDeletionAdvisoryFactory: GoalDeletionAdvisoryFactory | undefined;
}>) {
  const queryClient = useQueryClient();
  const leaseOwner = useAuthenticatedRequestLeaseOwner();
  const autoSaveScopes = useAutoSaveScopeRegistry();
  const transitionRef = useRef<Promise<void>>(Promise.resolve());
  const goalDeletionFallbacksRef = useRef(new Map<string, Promise<void>>());
  const goalDeletionsHandledBySubscriberRef = useRef(new Set<string>());
  const recoverySubscriptionRef = useRef<SessionRecoverySubscription | null>(
    null,
  );
  const childrenWrapperRef = useRef<HTMLDivElement | null>(null);
  const [unboundAdvisoryAbortController] = useState(
    () => new AbortController(),
  );
  const query = useInitialSessionDiscovery(
    leaseOwner,
    unboundAdvisoryAbortController.signal,
  );

  const enqueueTransition = useCallback(
    <Result,>(operation: () => Promise<Result>): Promise<Result> => {
      const transition = transitionRef.current
        .catch(() => undefined)
        .then(operation);
      transitionRef.current = transition.then(
        () => undefined,
        () => undefined,
      );
      return transition;
    },
    [],
  );

  const handleUnboundIdentityAdvisory = useCallback(() => {
    unboundAdvisoryAbortController.abort();
    reloadApplication();
  }, [reloadApplication, unboundAdvisoryAbortController]);

  const publication = useSessionPublicationController({
    queryClient,
    sessionQueryKey,
    autoSaveScopes,
    childrenWrapperRef,
    leaseOwner,
    recoverySubscriptionRef,
  });
  const publishIdentityAdvisory = useSessionIdentityAdvisory({
    queryClient,
    sessionQueryKey,
    factory: advisoryFactory,
    onUnboundIdentityAdvisory: handleUnboundIdentityAdvisory,
  });
  const publishAccountDeletionAdvisory = useAccountDeletionAdvisory({
    queryClient,
    sessionQueryKey,
    autoSaveScopes,
    suspendInteractionAndInvalidateLease:
      publication.suspendInteractionAndInvalidateLease,
    onUnboundAccountDeletionAdvisory: handleUnboundIdentityAdvisory,
    reloadApplication,
    factory: accountDeletionAdvisoryFactory,
  });
  const getCurrentGoalDeletionUserId = useCallback(
    () => queryClient.getQueryData<Session>(sessionQueryKey)?.user.id,
    [queryClient],
  );
  const handleAcceptedGoalDeletionAdvisory = useCallback(
    ({
      deletedUserId,
      deletedGoalId,
      subscriberNotified,
    }: AcceptedGoalDeletionAdvisory) => {
      const fallbackKey = `${deletedUserId}:${deletedGoalId}`;
      try {
        removeGoalFromCache(queryClient, deletedUserId, deletedGoalId);
      } catch {
        // A matching editor has already been synchronously fenced. Durable
        // cleanup remains authoritative if an in-memory cache is unavailable.
      }
      if (subscriberNotified) {
        // The matching workspace owns durable cleanup. Remember that ownership
        // after it navigates away so the sender's confirmation cannot start a
        // second, subscriber-free cleanup for the same deletion.
        goalDeletionsHandledBySubscriberRef.current.add(fallbackKey);
        return;
      }
      if (goalDeletionsHandledBySubscriberRef.current.has(fallbackKey)) return;
      if (goalDeletionFallbacksRef.current.has(fallbackKey)) return;
      const fallback = tombstoneDeletedGoalAndClearDrafts(
        deletedUserId,
        deletedGoalId,
      );
      goalDeletionFallbacksRef.current.set(fallbackKey, fallback);
      void fallback.catch(() => {
        if (goalDeletionFallbacksRef.current.get(fallbackKey) === fallback) {
          goalDeletionFallbacksRef.current.delete(fallbackKey);
        }
      });
    },
    [queryClient],
  );
  const goalDeletionAdvisory = useGoalDeletionAdvisory({
    getCurrentUserId: getCurrentGoalDeletionUserId,
    onAcceptedGoalDeletionAdvisory: handleAcceptedGoalDeletionAdvisory,
    factory: goalDeletionAdvisoryFactory,
  });
  const recovery = useSessionRecoveryController({
    queryClient,
    sessionQueryKey,
    enqueueTransition,
    autoSaveScopes,
    childrenWrapperRef,
    leaseOwner,
    recoverySubscriptionRef,
    identityUnverifiedRef: publication.identityUnverifiedRef,
    advanceRecoveryGeneration: publication.advanceRecoveryGeneration,
    setRuntimeRecovery: publication.setRuntimeRecovery,
    publishSession: publication.publishSession,
    publishIdentityAdvisory,
    requestCurrentSession,
    createAnonymousSession,
    isUnavailableSession,
  });
  const runners = useSessionOperationRunners({
    queryClient,
    sessionQueryKey,
    enqueueTransition,
    leaseOwner,
    recoverySubscriptionRef,
    suspendInteractionAndInvalidateLease:
      publication.suspendInteractionAndInvalidateLease,
    markSessionRecoveryRequired: recovery.markSessionRecoveryRequired,
    handoffStaleRecovery: recovery.handoffStaleRecovery,
    publishIdentityAdvisory,
    publishSession: publication.publishSession,
  });

  return (
    <GoalDeletionAdvisoryContext.Provider value={goalDeletionAdvisory}>
      <AccountDeletionAdvisoryPublishContext.Provider
        value={publishAccountDeletionAdvisory}
      >
        <SessionBoundaryPresentation
          query={query}
          recoverySubscriptionReady={recovery.recoverySubscriptionReady}
          leaseOwner={leaseOwner}
          sessionBoundaryGeneration={publication.sessionBoundaryGeneration}
          runtimeRecovery={publication.runtimeRecovery}
          interactionSuspended={publication.interactionSuspended}
          childrenWrapperRef={childrenWrapperRef}
          recoverSession={recovery.recoverSession}
          reloadApplication={reloadApplication}
          runTerminalSessionOperation={runners.runTerminalSessionOperation}
          runPostCommitSessionOperation={runners.runPostCommitSessionOperation}
          runSessionTransition={runners.runSessionTransition}
        >
          {children}
        </SessionBoundaryPresentation>
      </AccountDeletionAdvisoryPublishContext.Provider>
    </GoalDeletionAdvisoryContext.Provider>
  );
}

function reloadFromServer(): void {
  window.location.reload();
}
