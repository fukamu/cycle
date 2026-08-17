import { createContext, useContext } from "react";

import type { Session } from "../../shared/api/schemas";

export const SessionContext = createContext<Session | null>(null);
export const ReplaceSessionContext = createContext<
  ((session: Session) => void) | null
>(null);

export function useSession(): Session {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return value;
}

export function useReplaceSession(): (session: Session) => void {
  const value = useContext(ReplaceSessionContext);
  if (value === null) {
    throw new Error("useReplaceSession must be used within SessionProvider");
  }
  return value;
}
