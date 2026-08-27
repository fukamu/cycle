import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";

import type { Session } from "../../shared/api/schemas";
import {
  sessionRecoveryEvents,
  type SessionRecoveryEvent,
  type SessionRecoverySubscription,
} from "../../shared/api/sessionRecoveryEvents";
import type { AutoSaveScopeRegistry } from "../../shared/autosave/AutoSaveScopeProvider";
import type { AuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import type {
  PublishSession,
  RuntimeRecoveryState,
} from "./sessionBoundaryContracts";
import {
  runSessionRecoveryAttempt,
  type QuiescedRecovery,
} from "./sessionRecoveryAttempt";

type EnqueueTransition = <Result>(
  operation: () => Promise<Result>,
) => Promise<Result>;

type SessionRecoveryControllerOptions = {
  readonly queryClient: QueryClient;
  readonly sessionQueryKey: QueryKey;
  readonly enqueueTransition: EnqueueTransition;
  readonly autoSaveScopes: AutoSaveScopeRegistry;
  readonly childrenWrapperRef: RefObject<HTMLDivElement | null>;
  readonly leaseOwner: AuthenticatedRequestLeaseOwner;
  readonly recoverySubscriptionRef: RefObject<SessionRecoverySubscription | null>;
  readonly identityUnverifiedRef: RefObject<boolean>;
  readonly advanceRecoveryGeneration: () => void;
  readonly setRuntimeRecovery: Dispatch<
    SetStateAction<RuntimeRecoveryState | null>
  >;
  readonly publishSession: PublishSession;
  readonly publishIdentityAdvisory: (targetUserId: string) => void;
  readonly requestCurrentSession: (signal?: AbortSignal) => Promise<Session>;
  readonly createAnonymousSession: (
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ) => Promise<Session | null>;
  readonly isUnavailableSession: (error: unknown) => boolean;
};

export type SessionRecoveryController = {
  readonly recoverSession: (event: SessionRecoveryEvent) => Promise<void>;
  readonly recoverySubscriptionReady: boolean;
  readonly markSessionRecoveryRequired: () => void;
  readonly handoffStaleRecovery: () => void;
};

export function useSessionRecoveryController({
  queryClient,
  sessionQueryKey,
  enqueueTransition,
  autoSaveScopes,
  childrenWrapperRef,
  leaseOwner,
  recoverySubscriptionRef,
  identityUnverifiedRef,
  advanceRecoveryGeneration,
  setRuntimeRecovery,
  publishSession,
  publishIdentityAdvisory,
  requestCurrentSession,
  createAnonymousSession,
  isUnavailableSession,
}: SessionRecoveryControllerOptions): SessionRecoveryController {
  const recoveryRef = useRef<{
    readonly event: SessionRecoveryEvent;
    readonly promise: Promise<void>;
    readonly abortController: AbortController;
  } | null>(null);
  const quiescedRecoveryRef = useRef<QuiescedRecovery | null>(null);
  const [recoverySubscriptionReady, setRecoverySubscriptionReady] =
    useState(false);

  const suspendChildrenForRecovery = useCallback(
    (event: SessionRecoveryEvent) => {
      const suspend = () =>
        setRuntimeRecovery((current) => ({
          event,
          failed: false,
          suspendChildren: true,
          scopesQuiesced:
            current?.event === event
              ? current.scopesQuiesced
              : quiescedRecoveryRef.current?.event === event
                ? quiescedRecoveryRef.current.scopesQuiesced
                : false,
        }));
      if (childrenWrapperRef.current === null) {
        suspend();
      } else {
        flushSync(suspend);
      }
    },
    [childrenWrapperRef, setRuntimeRecovery],
  );

  const suspendChildrenAndInvalidateLeaseForRecovery = useCallback(
    (event: SessionRecoveryEvent) => {
      const suspend = () => {
        leaseOwner.invalidate();
        setRuntimeRecovery((current) => ({
          event,
          failed: false,
          suspendChildren: true,
          scopesQuiesced:
            current?.event === event
              ? current.scopesQuiesced
              : quiescedRecoveryRef.current?.event === event
                ? quiescedRecoveryRef.current.scopesQuiesced
                : false,
        }));
      };
      if (childrenWrapperRef.current === null) {
        suspend();
      } else {
        flushSync(suspend);
      }
    },
    [childrenWrapperRef, leaseOwner, setRuntimeRecovery],
  );

  const markSessionRecoveryRequired = useCallback(() => {
    void queryClient
      .invalidateQueries({
        queryKey: sessionQueryKey,
        exact: true,
        refetchType: "none",
      })
      .catch(() => undefined);
  }, [queryClient, sessionQueryKey]);

  const handoffStaleRecovery = useCallback(() => {
    markSessionRecoveryRequired();
    sessionRecoveryEvents.capturePublisher()("SESSION_EXPIRED");
  }, [markSessionRecoveryRequired]);

  const recoverSession = useCallback(
    (event: SessionRecoveryEvent): Promise<void> => {
      if (!event.isCurrent()) return Promise.resolve();
      if (identityUnverifiedRef.current) return Promise.resolve();
      const activeRecovery = recoveryRef.current;
      if (activeRecovery?.event.isCurrent() === true) {
        if (
          recoveryPriority(event.reason) >
          recoveryPriority(activeRecovery.event.reason)
        ) {
          if (requiresLeaseInvalidation(event.reason)) {
            suspendChildrenAndInvalidateLeaseForRecovery(event);
          }
          activeRecovery.abortController.abort();
          advanceRecoveryGeneration();
          sessionRecoveryEvents.capturePublisher()(event.reason);
        }
        return activeRecovery.promise;
      }

      if (event.reason === "SESSION_IDENTITY_UNVERIFIED") {
        identityUnverifiedRef.current = true;
      }

      const scopesPreviouslyQuiesced =
        quiescedRecoveryRef.current?.event === event &&
        quiescedRecoveryRef.current.scopesQuiesced;
      if (!scopesPreviouslyQuiesced) {
        quiescedRecoveryRef.current = {
          event,
          scopesQuiesced: false,
        };
      }
      markSessionRecoveryRequired();
      if (requiresLeaseInvalidation(event.reason)) {
        suspendChildrenAndInvalidateLeaseForRecovery(event);
      } else {
        setRuntimeRecovery((current) =>
          current === null
            ? null
            : {
                event,
                failed: false,
                suspendChildren: current.suspendChildren,
                scopesQuiesced: current.scopesQuiesced,
              },
        );
      }
      const abortController = new AbortController();

      const recovery = enqueueTransition(() =>
        runSessionRecoveryAttempt({
          event,
          abortController,
          scopesPreviouslyQuiesced,
          quiescedRecoveryRef,
          identityUnverifiedRef,
          setRuntimeRecovery,
          autoSaveScopes,
          handoffStaleRecovery,
          suspendChildrenForRecovery,
          suspendChildrenAndInvalidateLeaseForRecovery,
          requestCurrentSession,
          createAnonymousSession,
          isUnavailableSession,
          queryClient,
          sessionQueryKey,
          publishIdentityAdvisory,
          publishSession,
        }),
      );
      const recoveryEntry = { event, promise: recovery, abortController };
      recoveryRef.current = recoveryEntry;
      void recovery
        .finally(() => {
          if (recoveryRef.current === recoveryEntry) {
            recoveryRef.current = null;
          }
        })
        .catch(() => undefined);
      return recovery;
    },
    [
      advanceRecoveryGeneration,
      autoSaveScopes,
      createAnonymousSession,
      enqueueTransition,
      handoffStaleRecovery,
      identityUnverifiedRef,
      isUnavailableSession,
      markSessionRecoveryRequired,
      publishIdentityAdvisory,
      publishSession,
      queryClient,
      requestCurrentSession,
      sessionQueryKey,
      setRuntimeRecovery,
      suspendChildrenAndInvalidateLeaseForRecovery,
      suspendChildrenForRecovery,
    ],
  );

  useEffect(() => {
    const subscription = sessionRecoveryEvents.subscribe((event) => {
      void recoverSession(event);
    });
    recoverySubscriptionRef.current = subscription;
    const sessionState = queryClient.getQueryState(sessionQueryKey);
    const cachedSession = queryClient.getQueryData<Session>(sessionQueryKey);
    if (cachedSession !== undefined && sessionState?.isInvalidated !== true) {
      leaseOwner.activate(cachedSession.user.id);
    }
    queueMicrotask(() => {
      if (recoverySubscriptionRef.current === subscription) {
        setRecoverySubscriptionReady(true);
      }
    });
    if (
      sessionState?.isInvalidated === true &&
      sessionState.fetchStatus === "idle"
    ) {
      sessionRecoveryEvents.capturePublisher()("SESSION_EXPIRED");
    }
    return () => {
      recoveryRef.current?.abortController.abort();
      leaseOwner.invalidate();
      subscription.unsubscribe();
      if (recoverySubscriptionRef.current === subscription) {
        recoverySubscriptionRef.current = null;
      }
    };
  }, [
    leaseOwner,
    queryClient,
    recoverSession,
    recoverySubscriptionRef,
    sessionQueryKey,
  ]);

  return {
    recoverSession,
    recoverySubscriptionReady,
    markSessionRecoveryRequired,
    handoffStaleRecovery,
  };
}

function requiresLeaseInvalidation(
  reason: SessionRecoveryEvent["reason"],
): boolean {
  return reason !== "CSRF_INVALID";
}

function recoveryPriority(reason: SessionRecoveryEvent["reason"]): number {
  if (reason === "SESSION_IDENTITY_UNVERIFIED") return 4;
  if (reason === "SESSION_IDENTITY_DRIFT") return 3;
  if (reason === "CSRF_INVALID") return 1;
  return 2;
}
