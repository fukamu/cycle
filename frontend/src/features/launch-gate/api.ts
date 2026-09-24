import { requestAuthenticatedJSON } from "../../shared/api/client";
import { launchStatusSchema } from "../../shared/api/schemas";
import type { AuthenticatedRequestLease } from "../../shared/api/client";

export function getLaunchStatus(lease: AuthenticatedRequestLease) {
  return requestAuthenticatedJSON(
    lease,
    "/api/v1/launch-status",
    launchStatusSchema,
  );
}
