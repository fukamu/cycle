import {
  createContext,
  useContext,
  type PropsWithChildren,
  type RefObject,
} from "react";

import {
  SessionIdentityError,
  type AuthenticatedRequestLease,
} from "../../shared/api/client";
import type { Session } from "../../shared/api/schemas";
import type { SessionRecoveryEvent } from "../../shared/api/sessionRecoveryEvents";
import { BetaAdmissionGate } from "../beta-admission/BetaAdmissionGate";
import type { AuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import type { RuntimeRecoveryState } from "./sessionBoundaryContracts";
import {
  isBetaAdmissionRequired,
  isInitialSessionRateLimited,
} from "./sessionDiscovery";
import {
  AuthenticatedRequestLeaseContext,
  RunPostCommitSessionOperationContext,
  RunTerminalSessionOperationContext,
  RunSessionTransitionContext,
  SessionContext,
  type RunPostCommitSessionOperation,
  type RunSessionTransition,
  type RunTerminalSessionOperation,
} from "./sessionContext";
import type { InitialSessionQuery } from "./useInitialSessionDiscovery";

type SessionIdentityBoundaryValue = {
  readonly session: Session;
  readonly lease: AuthenticatedRequestLease;
  readonly generation: number;
  readonly runtimeRecovery: RuntimeRecoveryState | null;
  readonly interactionSuspended: boolean;
  readonly childrenWrapperRef: RefObject<HTMLDivElement | null>;
  readonly retryRecovery: (event: SessionRecoveryEvent) => void;
  readonly reloadApplication: () => void;
};

const SessionIdentityBoundaryContext =
  createContext<SessionIdentityBoundaryValue | null>(null);

export function SessionIdentityBoundary({ children }: PropsWithChildren) {
  const value = useContext(SessionIdentityBoundaryContext);
  if (value === null) {
    throw new Error(
      "SessionIdentityBoundary must be used within SessionProvider",
    );
  }
  const {
    session,
    lease,
    generation,
    runtimeRecovery,
    interactionSuspended,
    childrenWrapperRef,
    retryRecovery,
    reloadApplication,
  } = value;
  const suspended =
    interactionSuspended || runtimeRecovery?.suspendChildren === true;

  return (
    <SessionContext.Provider
      key={session.user.id + ":" + generation}
      value={session}
    >
      <AuthenticatedRequestLeaseContext.Provider value={lease}>
        <RuntimeRecoveryMessage
          runtimeRecovery={runtimeRecovery}
          interactionSuspended={interactionSuspended}
          retryRecovery={retryRecovery}
          reloadApplication={reloadApplication}
        />
        <div ref={childrenWrapperRef} hidden={suspended} inert={suspended}>
          {children}
        </div>
      </AuthenticatedRequestLeaseContext.Provider>
    </SessionContext.Provider>
  );
}

type SessionBoundaryPresentationProps = PropsWithChildren<{
  readonly query: InitialSessionQuery;
  readonly recoverySubscriptionReady: boolean;
  readonly leaseOwner: AuthenticatedRequestLeaseOwner;
  readonly sessionBoundaryGeneration: number;
  readonly runtimeRecovery: RuntimeRecoveryState | null;
  readonly interactionSuspended: boolean;
  readonly childrenWrapperRef: RefObject<HTMLDivElement | null>;
  readonly recoverSession: (event: SessionRecoveryEvent) => Promise<void>;
  readonly reloadApplication: () => void;
  readonly runTerminalSessionOperation: RunTerminalSessionOperation;
  readonly runPostCommitSessionOperation: RunPostCommitSessionOperation;
  readonly runSessionTransition: RunSessionTransition;
}>;

export function SessionBoundaryPresentation({
  children,
  query,
  recoverySubscriptionReady,
  leaseOwner,
  sessionBoundaryGeneration,
  runtimeRecovery,
  interactionSuspended,
  childrenWrapperRef,
  recoverSession,
  reloadApplication,
  runTerminalSessionOperation,
  runPostCommitSessionOperation,
  runSessionTransition,
}: SessionBoundaryPresentationProps) {
  if (query.isPending || !recoverySubscriptionReady) {
    return <SessionPreparingMessage />;
  }
  if (query.isError) {
    return (
      <InitialSessionError
        error={query.error}
        reloadApplication={reloadApplication}
        retry={() => void query.refetch()}
        retryAdmission={() => query.refetch()}
      />
    );
  }

  const lastKnownLease = leaseOwner.last();
  if (lastKnownLease === null) {
    return (
      <UnpublishedSessionRecovery
        runtimeRecovery={runtimeRecovery}
        recoverSession={recoverSession}
        reloadApplication={reloadApplication}
      />
    );
  }

  const activeLease = leaseOwner.active();
  const renderedLease =
    activeLease?.expectedUserId === query.data.user.id &&
    activeLease.isCurrent()
      ? activeLease
      : lastKnownLease.expectedUserId === query.data.user.id
        ? lastKnownLease
        : null;
  if (renderedLease === null) return <SessionPreparingMessage />;

  const identityBoundaryValue: SessionIdentityBoundaryValue = {
    session: query.data,
    lease: renderedLease,
    generation: sessionBoundaryGeneration,
    runtimeRecovery,
    interactionSuspended,
    childrenWrapperRef,
    retryRecovery: (event) => {
      void recoverSession(event);
    },
    reloadApplication,
  };

  return (
    <RunTerminalSessionOperationContext.Provider
      value={runTerminalSessionOperation}
    >
      <RunPostCommitSessionOperationContext.Provider
        value={runPostCommitSessionOperation}
      >
        <RunSessionTransitionContext.Provider value={runSessionTransition}>
          <SessionIdentityBoundaryContext.Provider
            value={identityBoundaryValue}
          >
            {children}
          </SessionIdentityBoundaryContext.Provider>
        </RunSessionTransitionContext.Provider>
      </RunPostCommitSessionOperationContext.Provider>
    </RunTerminalSessionOperationContext.Provider>
  );
}

function RuntimeRecoveryMessage({
  runtimeRecovery,
  interactionSuspended,
  retryRecovery,
  reloadApplication,
}: {
  readonly runtimeRecovery: RuntimeRecoveryState | null;
  readonly interactionSuspended: boolean;
  readonly retryRecovery: (event: SessionRecoveryEvent) => void;
  readonly reloadApplication: () => void;
}) {
  if (runtimeRecovery === null) {
    return interactionSuspended ? (
      <div className="app-message" role="status" aria-live="polite">
        <p>セッションを更新しています…</p>
      </div>
    ) : null;
  }

  const identityUnverified =
    runtimeRecovery.event.reason === "SESSION_IDENTITY_UNVERIFIED";
  return (
    <div
      className={
        runtimeRecovery.failed
          ? "app-message app-message--error"
          : "app-message"
      }
      role={runtimeRecovery.failed ? "alert" : "status"}
      aria-live="polite"
    >
      <p>
        {identityUnverified
          ? "セッションを安全に確認できませんでした。再読み込みしてください。"
          : runtimeRecovery.failed
            ? "セッションを再接続できませんでした。"
            : "セッションを再接続しています…"}
      </p>
      {identityUnverified ? (
        <button type="button" onClick={reloadApplication}>
          再読み込み
        </button>
      ) : runtimeRecovery.failed ? (
        <button
          type="button"
          onClick={() => retryRecovery(runtimeRecovery.event)}
        >
          再試行
        </button>
      ) : null}
    </div>
  );
}

function InitialSessionError({
  error,
  reloadApplication,
  retry,
  retryAdmission,
}: {
  readonly error: Error;
  readonly reloadApplication: () => void;
  readonly retry: () => void;
  readonly retryAdmission: () => Promise<unknown>;
}) {
  if (error instanceof SessionIdentityError) {
    return <ReloadOnlyMessage reloadApplication={reloadApplication} />;
  }
  if (isBetaAdmissionRequired(error)) {
    return <BetaAdmissionGate onAdmitted={retryAdmission} />;
  }
  if (isInitialSessionRateLimited(error)) {
    return (
      <div className="app-message app-message--error" role="alert">
        <p>
          短時間に新しい利用の開始が続いています。時間を空けてから再試行してください。再試行を繰り返すと、待ち時間が延びる場合があります。
        </p>
        <button type="button" onClick={retry}>
          再試行
        </button>
      </div>
    );
  }
  return (
    <div className="app-message app-message--error" role="alert">
      <p>FUKAMU Cycleを開始できませんでした。</p>
      <button type="button" onClick={retry}>
        再試行
      </button>
    </div>
  );
}

function UnpublishedSessionRecovery({
  runtimeRecovery,
  recoverSession,
  reloadApplication,
}: {
  readonly runtimeRecovery: RuntimeRecoveryState | null;
  readonly recoverSession: (event: SessionRecoveryEvent) => Promise<void>;
  readonly reloadApplication: () => void;
}) {
  if (runtimeRecovery?.failed !== true) return <SessionPreparingMessage />;
  if (runtimeRecovery.event.reason === "SESSION_IDENTITY_UNVERIFIED") {
    return <ReloadOnlyMessage reloadApplication={reloadApplication} />;
  }
  return (
    <div className="app-message app-message--error" role="alert">
      <p>セッションを再接続できませんでした。</p>
      <button
        type="button"
        onClick={() => void recoverSession(runtimeRecovery.event)}
      >
        再試行
      </button>
    </div>
  );
}

function ReloadOnlyMessage({
  reloadApplication,
}: {
  readonly reloadApplication: () => void;
}) {
  return (
    <div className="app-message app-message--error" role="alert">
      <p>セッションを安全に確認できませんでした。再読み込みしてください。</p>
      <button type="button" onClick={reloadApplication}>
        再読み込み
      </button>
    </div>
  );
}

function SessionPreparingMessage() {
  return (
    <div className="app-message" role="status" aria-live="polite">
      セッションを準備しています…
    </div>
  );
}
