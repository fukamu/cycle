import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { Session } from "../../shared/api/schemas";
import type { AuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import {
  isBetaAdmissionRequired,
  isSessionBoundaryOwnedError,
  loadInitialSession,
  sessionQueryKey,
} from "./sessionDiscovery";

export type InitialSessionQuery = UseQueryResult<Session, Error>;

export function useInitialSessionDiscovery(
  leaseOwner: AuthenticatedRequestLeaseOwner,
  advisorySignal: AbortSignal,
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
      const discoveredSession = await loadInitialSession(discoverySignal);
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
      !isSessionBoundaryOwnedError(error) &&
      failureCount < 2,
  });
}
