import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { SessionIdentityError } from "../../shared/api/client";
import type { Session } from "../../shared/api/schemas";
import {
  sessionRecoveryEvents,
  type SessionRecoveryEvent,
} from "../../shared/api/sessionRecoveryEvents";
import type { AutoSaveScopeRegistry } from "../../shared/autosave/AutoSaveScopeProvider";
import type {
  PublishSession,
  RuntimeRecoveryState,
} from "./sessionBoundaryContracts";

export type QuiescedRecovery = {
  readonly event: SessionRecoveryEvent;
  readonly scopesQuiesced: boolean;
};

type RecoveryAttemptOptions = {
  readonly event: SessionRecoveryEvent;
  readonly abortController: AbortController;
  readonly scopesPreviouslyQuiesced: boolean;
  readonly quiescedRecoveryRef: RefObject<QuiescedRecovery | null>;
  readonly identityUnverifiedRef: RefObject<boolean>;
  readonly setRuntimeRecovery: Dispatch<
    SetStateAction<RuntimeRecoveryState | null>
  >;
  readonly autoSaveScopes: AutoSaveScopeRegistry;
  readonly handoffStaleRecovery: () => void;
  readonly suspendChildrenForRecovery: (event: SessionRecoveryEvent) => void;
  readonly suspendChildrenAndInvalidateLeaseForRecovery: (
    event: SessionRecoveryEvent,
  ) => void;
  readonly requestCurrentSession: (signal?: AbortSignal) => Promise<Session>;
  readonly createAnonymousSession: (
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ) => Promise<Session | null>;
  readonly isUnavailableSession: (error: unknown) => boolean;
  readonly queryClient: QueryClient;
  readonly sessionQueryKey: QueryKey;
  readonly publishIdentityAdvisory: (targetUserId: string) => void;
  readonly publishSession: PublishSession;
};

type RecoveryProgress = {
  readonly continue: () => boolean;
  readonly quiesce: () => Promise<boolean>;
  readonly scopesAlreadyQuiesced: () => boolean;
  readonly clearCompletedQuiesce: () => void;
};

export async function runSessionRecoveryAttempt(
  options: RecoveryAttemptOptions,
): Promise<void> {
  const progress = createRecoveryProgress(options);
  if (!options.event.isCurrent()) return;

  try {
    if (options.event.reason === "SESSION_IDENTITY_UNVERIFIED") {
      await completeUnverifiedRecovery(options, progress);
      return;
    }

    const recoveredSession = await discoverRecoveredSession(options, progress);
    if (recoveredSession === null) return;
    if (!(await publishRecoveredSession(options, progress, recoveredSession))) {
      return;
    }
    progress.clearCompletedQuiesce();
  } catch (error) {
    handleRecoveryFailure(options, progress, error);
  }
}

function createRecoveryProgress(
  options: RecoveryAttemptOptions,
): RecoveryProgress {
  let scopesAlreadyQuiesced = options.scopesPreviouslyQuiesced;

  const continueRecovery = () => {
    if (options.event.isCurrent()) return true;
    if (!options.identityUnverifiedRef.current) {
      options.handoffStaleRecovery();
    }
    return false;
  };

  const recordScopesQuiesced = () => {
    scopesAlreadyQuiesced = true;
    options.quiescedRecoveryRef.current = {
      event: options.event,
      scopesQuiesced: true,
    };
    options.setRuntimeRecovery((current) =>
      current?.event === options.event
        ? { ...current, scopesQuiesced: true }
        : current,
    );
  };

  return {
    continue: continueRecovery,
    quiesce: async () => {
      if (scopesAlreadyQuiesced) return true;
      await options.autoSaveScopes.quiesce({ preserveDrafts: true });
      if (!continueRecovery()) return false;
      recordScopesQuiesced();
      return true;
    },
    scopesAlreadyQuiesced: () => scopesAlreadyQuiesced,
    clearCompletedQuiesce: () => {
      if (options.quiescedRecoveryRef.current?.event === options.event) {
        options.quiescedRecoveryRef.current = null;
      }
    },
  };
}

async function completeUnverifiedRecovery(
  options: RecoveryAttemptOptions,
  progress: RecoveryProgress,
): Promise<void> {
  if (!(await progress.quiesce())) return;
  options.setRuntimeRecovery({
    event: options.event,
    failed: true,
    suspendChildren: true,
    scopesQuiesced: true,
  });
}

async function discoverRecoveredSession(
  options: RecoveryAttemptOptions,
  progress: RecoveryProgress,
): Promise<Session | null> {
  if (requiresDraftQuiesceBeforeDiscovery(options.event.reason)) {
    options.suspendChildrenForRecovery(options.event);
    if (!(await progress.quiesce())) return null;
    return discoverAfterRequiredQuiesce(options, progress);
  }
  return discoverBeforeConditionalQuiesce(options, progress);
}

async function discoverAfterRequiredQuiesce(
  options: RecoveryAttemptOptions,
  progress: RecoveryProgress,
): Promise<Session | null> {
  try {
    const recoveredSession = await options.requestCurrentSession(
      options.abortController.signal,
    );
    return progress.continue() ? recoveredSession : null;
  } catch (error) {
    if (!progress.continue()) return null;
    if (!options.isUnavailableSession(error)) throw error;
    return bootstrapAnonymousSession(options, progress);
  }
}

async function discoverBeforeConditionalQuiesce(
  options: RecoveryAttemptOptions,
  progress: RecoveryProgress,
): Promise<Session | null> {
  let recoveredSession: Session;
  try {
    recoveredSession = await options.requestCurrentSession(
      options.abortController.signal,
    );
    if (!progress.continue()) return null;
  } catch (error) {
    if (!progress.continue()) return null;
    if (!options.isUnavailableSession(error)) throw error;
    options.suspendChildrenAndInvalidateLeaseForRecovery(options.event);
    if (!(await progress.quiesce())) return null;
    const anonymousSession = await bootstrapAnonymousSession(options, progress);
    if (anonymousSession === null) return null;
    recoveredSession = anonymousSession;
  }

  const currentSession = options.queryClient.getQueryData<Session>(
    options.sessionQueryKey,
  );
  if (
    !progress.scopesAlreadyQuiesced() &&
    currentSession !== undefined &&
    currentSession.user.id !== recoveredSession.user.id
  ) {
    options.suspendChildrenAndInvalidateLeaseForRecovery(options.event);
    if (!(await progress.quiesce())) return null;
  }
  return recoveredSession;
}

async function bootstrapAnonymousSession(
  options: RecoveryAttemptOptions,
  progress: RecoveryProgress,
): Promise<Session | null> {
  const anonymousSession = await options.createAnonymousSession(
    options.event.isCurrent,
    options.abortController.signal,
  );
  if (anonymousSession === null) {
    options.handoffStaleRecovery();
    return null;
  }
  return progress.continue() ? anonymousSession : null;
}

async function publishRecoveredSession(
  options: RecoveryAttemptOptions,
  progress: RecoveryProgress,
  recoveredSession: Session,
): Promise<boolean> {
  const currentSession = options.queryClient.getQueryData<Session>(
    options.sessionQueryKey,
  );
  if (currentSession?.user.id !== recoveredSession.user.id) {
    options.publishIdentityAdvisory(recoveredSession.user.id);
  }
  const published = await options.publishSession(recoveredSession, {
    scopesAlreadyQuiesced: progress.scopesAlreadyQuiesced(),
    remountSameIdentity: progress.scopesAlreadyQuiesced(),
    isCurrent: options.event.isCurrent,
  });
  if (!published) options.handoffStaleRecovery();
  return published;
}

function handleRecoveryFailure(
  options: RecoveryAttemptOptions,
  progress: RecoveryProgress,
  error: unknown,
): void {
  if (!progress.continue()) return;
  if (publishHigherPriorityIdentityFailure(options.event.reason, error)) return;

  const scopesAlreadyQuiesced = progress.scopesAlreadyQuiesced();
  options.setRuntimeRecovery({
    event: options.event,
    failed: true,
    suspendChildren:
      scopesAlreadyQuiesced || requiresLeaseInvalidation(options.event.reason),
    scopesQuiesced: scopesAlreadyQuiesced,
  });
  throw error;
}

function publishHigherPriorityIdentityFailure(
  currentReason: SessionRecoveryEvent["reason"],
  error: unknown,
): boolean {
  if (!(error instanceof SessionIdentityError)) return false;
  if (error.reason === "SESSION_IDENTITY_UNVERIFIED") {
    sessionRecoveryEvents.capturePublisher()("SESSION_IDENTITY_UNVERIFIED");
    return true;
  }
  if (
    error.reason === "SESSION_IDENTITY_DRIFT" &&
    currentReason !== "SESSION_IDENTITY_DRIFT"
  ) {
    sessionRecoveryEvents.capturePublisher()("SESSION_IDENTITY_DRIFT");
    return true;
  }
  return false;
}

function requiresLeaseInvalidation(
  reason: SessionRecoveryEvent["reason"],
): boolean {
  return reason !== "CSRF_INVALID";
}

function requiresDraftQuiesceBeforeDiscovery(
  reason: SessionRecoveryEvent["reason"],
): boolean {
  return reason !== "CSRF_INVALID" && reason !== "SESSION_IDENTITY_UNVERIFIED";
}
