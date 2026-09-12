import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import type { Session } from "../../shared/api/schemas";
import { sessionRecoveryEvents } from "../../shared/api/sessionRecoveryEvents";
import {
  createSessionIdentityAdvisory,
  type PublishSessionIdentityAdvisory,
  type SessionIdentityAdvisory,
  type SessionIdentityAdvisoryFactory,
  type SessionIdentityAdvisoryMessage,
} from "./sessionIdentityAdvisory";

type SessionIdentityAdvisoryOptions = {
  readonly queryClient: QueryClient;
  readonly sessionQueryKey: QueryKey;
  readonly factory: SessionIdentityAdvisoryFactory | undefined;
  readonly onUnboundIdentityAdvisory: (
    advisory: SessionIdentityAdvisoryMessage,
  ) => void;
};

export function useSessionIdentityAdvisory({
  queryClient,
  sessionQueryKey,
  factory,
  onUnboundIdentityAdvisory,
}: SessionIdentityAdvisoryOptions): PublishSessionIdentityAdvisory {
  const advisoryRef = useRef<SessionIdentityAdvisory | null>(null);

  useEffect(() => {
    const advisory = createSessionIdentityAdvisory((message) => {
      const currentSession = queryClient.getQueryData<Session>(sessionQueryKey);
      if (currentSession === undefined) {
        onUnboundIdentityAdvisory(message);
        return;
      }
      sessionRecoveryEvents.capturePublisher()(
        currentSession.user.id === message.targetUserId
          ? "CSRF_INVALID"
          : "SESSION_IDENTITY_DRIFT",
        {
          targetUserId: message.targetUserId,
          guidePreferencesReconciled: message.guidePreferencesReconciled,
        },
      );
    }, factory);
    advisoryRef.current = advisory;
    return () => {
      advisory?.close();
      if (advisoryRef.current === advisory) advisoryRef.current = null;
    };
  }, [factory, onUnboundIdentityAdvisory, queryClient, sessionQueryKey]);

  return useCallback<PublishSessionIdentityAdvisory>(
    (targetUserId, options) => {
      advisoryRef.current?.publish(targetUserId, options);
    },
    [],
  );
}
