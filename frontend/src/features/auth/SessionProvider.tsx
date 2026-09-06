import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type GoalDeletionAdvisoryRegistry,
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

type GoalDeletionFallback = {
  status: "pending" | "completed";
  retryRequested: boolean;
};

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
  const goalDeletionFallbacksRef = useRef(
    new Map<string, GoalDeletionFallback>(),
  );
  const goalDeletionsHandledBySubscriberRef = useRef(new Set<string>());
  const goalDeletionAdvisoryRegistryRef =
    useRef<GoalDeletionAdvisoryRegistry | null>(null);
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
  const startGoalDeletionFallback = useCallback(
    function startGoalDeletionFallback(
      deletedUserId: string,
      deletedGoalId: string,
      fallbackKey: string,
    ) {
      const registry = goalDeletionAdvisoryRegistryRef.current;
      if (registry === null) return;
      const claim = registry.beginCleanup(deletedUserId, deletedGoalId);
      const entry: GoalDeletionFallback = {
        status: "pending",
        retryRequested: false,
      };
      goalDeletionFallbacksRef.current.set(fallbackKey, entry);
      if (claim.kind === "owner") {
        const fallback = (async () => {
          await tombstoneDeletedGoalAndClearDrafts(
            deletedUserId,
            deletedGoalId,
          );
          removeGoalFromCache(queryClient, deletedUserId, deletedGoalId);
        })();
        void fallback.then(claim.complete, claim.fail);
      }
      void claim.completion.then((outcome) => {
        if (goalDeletionFallbacksRef.current.get(fallbackKey) !== entry) return;
        if (outcome === "completed") {
          removeGoalFromCache(queryClient, deletedUserId, deletedGoalId);
          entry.status = "completed";
          return;
        }
        goalDeletionFallbacksRef.current.delete(fallbackKey);
        if (entry.retryRequested) {
          startGoalDeletionFallback(deletedUserId, deletedGoalId, fallbackKey);
        }
      });
    },
    [queryClient],
  );
  const handleAcceptedGoalDeletionAdvisory = useCallback(
    ({
      deletedUserId,
      deletedGoalId,
      subscriberNotified,
    }: AcceptedGoalDeletionAdvisory) => {
      const fallbackKey = JSON.stringify([deletedUserId, deletedGoalId]);
      if (subscriberNotified) {
        // The matching workspace owns the whole deletion sequence, including
        // durable cleanup and cache eviction. Remember that ownership after it
        // navigates away so the sender's confirmation cannot start a second,
        // subscriber-free cleanup for the same deletion.
        goalDeletionsHandledBySubscriberRef.current.add(fallbackKey);
        return;
      }
      if (goalDeletionsHandledBySubscriberRef.current.has(fallbackKey)) return;
      const fallback = goalDeletionFallbacksRef.current.get(fallbackKey);
      if (fallback !== undefined) {
        if (fallback.status === "pending") {
          fallback.retryRequested = true;
        } else {
          removeGoalFromCache(queryClient, deletedUserId, deletedGoalId);
        }
        return;
      }
      startGoalDeletionFallback(deletedUserId, deletedGoalId, fallbackKey);
    },
    [queryClient, startGoalDeletionFallback],
  );
  const goalDeletionAdvisory = useGoalDeletionAdvisory({
    getCurrentUserId: getCurrentGoalDeletionUserId,
    onAcceptedGoalDeletionAdvisory: handleAcceptedGoalDeletionAdvisory,
    factory: goalDeletionAdvisoryFactory,
  });
  useLayoutEffect(() => {
    goalDeletionAdvisoryRegistryRef.current = goalDeletionAdvisory;
    return () => {
      if (goalDeletionAdvisoryRegistryRef.current === goalDeletionAdvisory) {
        goalDeletionAdvisoryRegistryRef.current = null;
      }
    };
  }, [goalDeletionAdvisory]);
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
