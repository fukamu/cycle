import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import type { SessionRecoverySubscription } from "../../shared/api/sessionRecoveryEvents";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
} from "../../shared/autosave/AutoSaveScopeProvider";
import { cleanupExpiredBrowserDrafts } from "../../shared/drafts/browserDraftCache";
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
}>;

export function SessionProvider({
  children,
  reloadApplication = reloadFromServer,
  advisoryFactory,
  accountDeletionAdvisoryFactory,
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
}: PropsWithChildren<{
  readonly reloadApplication: () => void;
  readonly advisoryFactory: SessionIdentityAdvisoryFactory | undefined;
  readonly accountDeletionAdvisoryFactory:
    | AccountDeletionAdvisoryFactory
    | undefined;
}>) {
  const queryClient = useQueryClient();
  const leaseOwner = useAuthenticatedRequestLeaseOwner();
  const autoSaveScopes = useAutoSaveScopeRegistry();
  const transitionRef = useRef<Promise<void>>(Promise.resolve());
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
  );
}

function reloadFromServer(): void {
  window.location.reload();
}
