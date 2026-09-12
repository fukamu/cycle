import type { AuthenticatedRequestLease } from "../../shared/api/client";
import { requestCurrentSession } from "./sessionDiscovery";
import { runSessionCookieWriter } from "./sessionCookieWriter";

type FirstUseGuideSessionPersistenceOptions = {
  readonly expectedUserId: string;
  readonly lease: AuthenticatedRequestLease;
  readonly lifecycle: {
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
  };
  readonly registration: {
    readonly isCurrent: () => boolean;
  };
  readonly persist: () => void;
};

export async function persistFirstUseGuidePreferenceForCapturedUser({
  expectedUserId,
  lease,
  lifecycle,
  registration,
  persist,
}: FirstUseGuideSessionPersistenceOptions): Promise<void> {
  const isCurrent = () =>
    lease.expectedUserId === expectedUserId &&
    lease.isCurrent() &&
    lifecycle.isCurrent() &&
    registration.isCurrent();
  if (!isCurrent()) return;
  const signal = AbortSignal.any([lease.signal, lifecycle.signal]);

  try {
    await runSessionCookieWriter({ isCurrent, signal }, async () => {
      const authoritativeSession = await requestCurrentSession(signal);
      if (!isCurrent() || authoritativeSession.user.id !== expectedUserId) {
        return;
      }
      persist();
    });
  } catch {
    // Guide persistence is best-effort and cannot fail the user operation.
  }
}
