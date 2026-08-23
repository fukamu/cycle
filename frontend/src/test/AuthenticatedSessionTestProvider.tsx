import type { ReactNode } from "react";

import {
  AuthenticatedRequestLeaseContext,
  SessionContext,
} from "../features/auth/sessionContext";
import type { AuthenticatedRequestLease } from "../shared/api/client";
import type { Session } from "../shared/api/schemas";

export function AuthenticatedSessionTestProvider({
  children,
  lease,
  session,
}: {
  readonly children: ReactNode;
  readonly lease: AuthenticatedRequestLease;
  readonly session: Session;
}) {
  return (
    <SessionContext.Provider value={session}>
      <AuthenticatedRequestLeaseContext.Provider value={lease}>
        {children}
      </AuthenticatedRequestLeaseContext.Provider>
    </SessionContext.Provider>
  );
}
