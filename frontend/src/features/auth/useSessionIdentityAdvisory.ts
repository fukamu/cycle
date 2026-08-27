import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import type { Session } from "../../shared/api/schemas";
import { sessionRecoveryEvents } from "../../shared/api/sessionRecoveryEvents";
import {
  createSessionIdentityAdvisory,
  type SessionIdentityAdvisory,
  type SessionIdentityAdvisoryFactory,
} from "./sessionIdentityAdvisory";

type SessionIdentityAdvisoryOptions = {
  readonly queryClient: QueryClient;
  readonly sessionQueryKey: QueryKey;
  readonly factory: SessionIdentityAdvisoryFactory | undefined;
  readonly onUnboundIdentityAdvisory: () => void;
};

export function useSessionIdentityAdvisory({
  queryClient,
  sessionQueryKey,
  factory,
  onUnboundIdentityAdvisory,
}: SessionIdentityAdvisoryOptions): (targetUserId: string) => void {
  const advisoryRef = useRef<SessionIdentityAdvisory | null>(null);

  useEffect(() => {
    const advisory = createSessionIdentityAdvisory((targetUserId) => {
      const currentSession = queryClient.getQueryData<Session>(sessionQueryKey);
      if (currentSession === undefined) {
        onUnboundIdentityAdvisory();
        return;
      }
      sessionRecoveryEvents.capturePublisher()(
        currentSession.user.id === targetUserId
          ? "CSRF_INVALID"
          : "SESSION_IDENTITY_DRIFT",
      );
    }, factory);
    advisoryRef.current = advisory;
    return () => {
      advisory?.close();
      if (advisoryRef.current === advisory) advisoryRef.current = null;
    };
  }, [factory, onUnboundIdentityAdvisory, queryClient, sessionQueryKey]);

  return useCallback((targetUserId: string) => {
    advisoryRef.current?.publish(targetUserId);
  }, []);
}
