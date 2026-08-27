import { createContext, useContext } from "react";

import type { AuthenticatedRequestLease } from "../../shared/api/client";
import type { Session } from "../../shared/api/schemas";
import type {
  PostCommitSessionOperationRunner,
  PostCommitSessionOwnershipToken,
} from "../../shared/cleanup/postCommitCleanupContext";

export const SessionContext = createContext<Session | null>(null);
export const AuthenticatedRequestLeaseContext =
  createContext<AuthenticatedRequestLease | null>(null);
export type SessionTransitionResult = {
  readonly previousSession: Session;
  readonly session: Session;
};

export type RunTerminalSessionOperation = <Result>(
  expectedUserId: string,
  operation: (
    currentSession: Session,
    lease: AuthenticatedRequestLease,
    ownership: PostCommitSessionOwnershipToken,
  ) => Promise<Result>,
) => Promise<Result>;

export type RunPostCommitSessionOperation = PostCommitSessionOperationRunner;

export type RunSessionTransition = (
  expectedUserId: string,
  request: (
    currentSession: Session,
    lease: AuthenticatedRequestLease,
  ) => Promise<Session>,
) => Promise<SessionTransitionResult>;

export const RunTerminalSessionOperationContext =
  createContext<RunTerminalSessionOperation | null>(null);
export const RunPostCommitSessionOperationContext =
  createContext<RunPostCommitSessionOperation | null>(null);
export const RunSessionTransitionContext =
  createContext<RunSessionTransition | null>(null);

export function useSession(): Session {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return value;
}

export function useAuthenticatedRequestLease(): AuthenticatedRequestLease {
  const value = useContext(AuthenticatedRequestLeaseContext);
  if (value === null) {
    throw new Error(
      "useAuthenticatedRequestLease must be used within SessionProvider",
    );
  }
  return value;
}

export function useRunTerminalSessionOperation(): RunTerminalSessionOperation {
  const value = useContext(RunTerminalSessionOperationContext);
  if (value === null) {
    throw new Error(
      "useRunTerminalSessionOperation must be used within SessionProvider",
    );
  }
  return value;
}

export function useRunPostCommitSessionOperation(): RunPostCommitSessionOperation {
  const value = useContext(RunPostCommitSessionOperationContext);
  if (value === null) {
    throw new Error(
      "useRunPostCommitSessionOperation must be used within SessionProvider",
    );
  }
  return value;
}

export function useRunSessionTransition(): RunSessionTransition {
  const value = useContext(RunSessionTransitionContext);
  if (value === null) {
    throw new Error(
      "useRunSessionTransition must be used within SessionProvider",
    );
  }
  return value;
}
