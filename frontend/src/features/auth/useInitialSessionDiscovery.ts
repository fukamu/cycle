import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { Session } from "../../shared/api/schemas";
import { suppressFirstUseGuideUntilReconciliation } from "../../shared/preferences/firstUseGuidePreference";
import type { AuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import type { PublishSessionIdentityAdvisory } from "./sessionIdentityAdvisory";
import {
  isBetaAdmissionRequired,
  isInitialSessionRateLimited,
  isSessionBoundaryOwnedError,
  loadInitialSession,
  sessionQueryKey,
} from "./sessionDiscovery";

export type InitialSessionQuery = UseQueryResult<Session, Error>;

export function useInitialSessionDiscovery(
  leaseOwner: AuthenticatedRequestLeaseOwner,
  advisorySignal: AbortSignal,
  publishIdentityAdvisory: PublishSessionIdentityAdvisory,
): InitialSessionQuery {
  const providerMountedRef = useRef(true);
  const [abortController] = useState(() => new AbortController());

  useEffect(() => {
    providerMountedRef.current = true;
    return () => {
      providerMountedRef.current = false;
      queueMicrotask(() => {
        if (!providerMountedRef.current) abortController.abort();
      });
    };
  }, [abortController]);

  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      const discoverySignal = AbortSignal.any([
        abortController.signal,
        advisorySignal,
      ]);
      const discoveredSession = await loadInitialSession(
        discoverySignal,
        (reconciliation, reconciledSession) => {
          if (reconciliation === "deferred") {
            suppressFirstUseGuideUntilReconciliation();
            return;
          }
          if (
            reconciliation !== "local-shared-safe" &&
            reconciliation !== "local-document-only"
          ) {
            return;
          }
          publishIdentityAdvisory(reconciledSession.user.id, {
            guidePreferencesReconciled: reconciliation === "local-shared-safe",
          });
        },
      );
      if (!providerMountedRef.current) {
        throw new DOMException("session discovery interrupted", "AbortError");
      }
      discoverySignal.throwIfAborted();
      leaseOwner.activate(discoveredSession.user.id);
      return discoveredSession;
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) =>
      !isBetaAdmissionRequired(error) &&
      !isInitialSessionRateLimited(error) &&
      !isSessionBoundaryOwnedError(error) &&
      failureCount < 2,
  });
}
