import { useCallback, useEffect, useMemo, useRef } from "react";

import type { AuthenticatedRequestLease } from "../../shared/api/client";

type ActiveRequestLease = {
  readonly lease: AuthenticatedRequestLease;
  readonly abortController: AbortController;
  readonly epoch: number;
};

export type AuthenticatedRequestLeaseOwner = {
  readonly active: () => AuthenticatedRequestLease | null;
  readonly last: () => AuthenticatedRequestLease | null;
  readonly epoch: () => number;
  readonly invalidate: () => void;
  readonly activate: (expectedUserId: string) => AuthenticatedRequestLease;
  readonly requireCurrent: (
    expectedUserId: string,
  ) => AuthenticatedRequestLease;
};

export function useAuthenticatedRequestLeaseOwner(): AuthenticatedRequestLeaseOwner {
  const activeRef = useRef<ActiveRequestLease | null>(null);
  const lastRef = useRef<AuthenticatedRequestLease | null>(null);
  const epochRef = useRef(0);

  const invalidate = useCallback(() => {
    const active = activeRef.current;
    activeRef.current = null;
    epochRef.current += 1;
    active?.abortController.abort();
  }, []);

  const activate = useCallback(
    (expectedUserId: string): AuthenticatedRequestLease => {
      const current = activeRef.current;
      if (
        current !== null &&
        current.lease.expectedUserId === expectedUserId &&
        current.lease.isCurrent()
      ) {
        return current.lease;
      }
      invalidate();
      const abortController = new AbortController();
      const epoch = epochRef.current;
      const lease: AuthenticatedRequestLease = Object.freeze({
        expectedUserId,
        signal: abortController.signal,
        isCurrent: () =>
          !abortController.signal.aborted &&
          activeRef.current?.lease === lease &&
          activeRef.current.epoch === epoch,
      });
      activeRef.current = { lease, abortController, epoch };
      lastRef.current = lease;
      return lease;
    },
    [invalidate],
  );

  const requireCurrent = useCallback(
    (expectedUserId: string): AuthenticatedRequestLease => {
      const active = activeRef.current;
      if (
        active === null ||
        active.lease.expectedUserId !== expectedUserId ||
        !active.lease.isCurrent()
      ) {
        throw new Error("session operation interrupted");
      }
      return active.lease;
    },
    [],
  );

  useEffect(
    () => () => {
      invalidate();
    },
    [invalidate],
  );

  return useMemo(
    () => ({
      active: () => activeRef.current?.lease ?? null,
      last: () => lastRef.current,
      epoch: () => epochRef.current,
      invalidate,
      activate,
      requireCurrent,
    }),
    [activate, invalidate, requireCurrent],
  );
}
