import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";

import type { Session } from "../../shared/api/schemas";
import type { SessionRecoverySubscription } from "../../shared/api/sessionRecoveryEvents";
import type { AutoSaveScopeRegistry } from "../../shared/autosave/AutoSaveScopeProvider";
import type { AuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import type {
  PublishSession,
  RuntimeRecoveryState,
} from "./sessionBoundaryContracts";

type SessionPublicationControllerOptions = {
  readonly queryClient: QueryClient;
  readonly sessionQueryKey: QueryKey;
  readonly autoSaveScopes: AutoSaveScopeRegistry;
  readonly childrenWrapperRef: RefObject<HTMLDivElement | null>;
  readonly leaseOwner: AuthenticatedRequestLeaseOwner;
  readonly recoverySubscriptionRef: RefObject<SessionRecoverySubscription | null>;
};

export type SessionPublicationController = {
  readonly sessionBoundaryGeneration: number;
  readonly runtimeRecovery: RuntimeRecoveryState | null;
  readonly setRuntimeRecovery: Dispatch<
    SetStateAction<RuntimeRecoveryState | null>
  >;
  readonly interactionSuspended: boolean;
  readonly identityUnverifiedRef: RefObject<boolean>;
  readonly advanceRecoveryGeneration: () => void;
  readonly suspendInteractionAndInvalidateLease: () => void;
  readonly publishSession: PublishSession;
};

export function useSessionPublicationController({
  queryClient,
  sessionQueryKey,
  autoSaveScopes,
  childrenWrapperRef,
  leaseOwner,
  recoverySubscriptionRef,
}: SessionPublicationControllerOptions): SessionPublicationController {
  const identityUnverifiedRef = useRef(false);
  const [sessionBoundaryGeneration, setSessionBoundaryGeneration] = useState(0);
  const [runtimeRecovery, setRuntimeRecovery] =
    useState<RuntimeRecoveryState | null>(null);
  const [interactionSuspended, setInteractionSuspended] = useState(false);

  const advanceRecoveryGeneration = useCallback(() => {
    recoverySubscriptionRef.current?.advanceGeneration();
  }, [recoverySubscriptionRef]);

  const setInteractionSuspendedSynchronously = useCallback(
    (suspended: boolean) => {
      commitSynchronouslyWhenMounted(childrenWrapperRef, () => {
        setInteractionSuspended(suspended);
      });
    },
    [childrenWrapperRef],
  );

  const suspendInteractionAndInvalidateLease = useCallback(() => {
    commitSynchronouslyWhenMounted(childrenWrapperRef, () => {
      leaseOwner.invalidate();
      setInteractionSuspended(true);
    });
  }, [childrenWrapperRef, leaseOwner]);

  const commitPublishedSession = useCallback(
    (
      nextSession: Session,
      remountSameIdentity: boolean,
      isCurrent: () => boolean,
    ): boolean => {
      if (identityUnverifiedRef.current) return false;
      let committed = false;
      commitSynchronouslyWhenMounted(childrenWrapperRef, () => {
        if (identityUnverifiedRef.current || !isCurrent()) return;
        leaseOwner.activate(nextSession.user.id);
        setRuntimeRecovery(null);
        setInteractionSuspended(false);
        advanceRecoveryGeneration();
        queryClient.setQueryData(sessionQueryKey, nextSession);
        if (remountSameIdentity) {
          setSessionBoundaryGeneration((generation) => generation + 1);
        }
        committed = true;
      });
      return committed;
    },
    [
      advanceRecoveryGeneration,
      childrenWrapperRef,
      leaseOwner,
      queryClient,
      sessionQueryKey,
    ],
  );

  const publishSession = useCallback<PublishSession>(
    async (nextSession, options) => {
      if (identityUnverifiedRef.current || options.isCurrent?.() === false) {
        return false;
      }
      const currentSession = queryClient.getQueryData<Session>(sessionQueryKey);
      if (currentSession?.user.id === nextSession.user.id) {
        return commitPublishedSession(
          nextSession,
          options.remountSameIdentity,
          () =>
            !identityUnverifiedRef.current && options.isCurrent?.() !== false,
        );
      }

      if (leaseOwner.active() !== null) {
        suspendInteractionAndInvalidateLease();
      } else {
        setInteractionSuspendedSynchronously(true);
      }
      const publicationEpoch = leaseOwner.epoch();
      const publicationIsCurrent = () =>
        !identityUnverifiedRef.current &&
        options.isCurrent?.() !== false &&
        leaseOwner.epoch() === publicationEpoch;

      if (!options.scopesAlreadyQuiesced) {
        await autoSaveScopes.quiesce({ preserveDrafts: true });
        if (!publicationIsCurrent()) return false;
      }
      if (currentSession !== undefined) {
        const oldUserQueryRoot = ["user", currentSession.user.id] as const;
        await queryClient.cancelQueries({ queryKey: oldUserQueryRoot });
        if (!publicationIsCurrent()) return false;
        queryClient.removeQueries({ queryKey: oldUserQueryRoot });
      }
      queryClient.getMutationCache().clear();
      return commitPublishedSession(nextSession, false, publicationIsCurrent);
    },
    [
      autoSaveScopes,
      commitPublishedSession,
      leaseOwner,
      queryClient,
      sessionQueryKey,
      setInteractionSuspendedSynchronously,
      suspendInteractionAndInvalidateLease,
    ],
  );

  return {
    sessionBoundaryGeneration,
    runtimeRecovery,
    setRuntimeRecovery,
    interactionSuspended,
    identityUnverifiedRef,
    advanceRecoveryGeneration,
    suspendInteractionAndInvalidateLease,
    publishSession,
  };
}

function commitSynchronouslyWhenMounted(
  childrenWrapperRef: RefObject<HTMLDivElement | null>,
  commit: () => void,
): void {
  if (childrenWrapperRef.current === null) {
    commit();
  } else {
    flushSync(commit);
  }
}
