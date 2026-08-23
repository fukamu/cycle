import type { AuthenticatedRequestLease } from "../shared/api/client";

export function createCurrentAuthenticatedRequestLease(
  expectedUserId: string,
): AuthenticatedRequestLease {
  const controller = new AbortController();
  return {
    expectedUserId,
    signal: controller.signal,
    isCurrent: () => true,
  };
}
