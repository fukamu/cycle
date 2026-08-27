import { z } from "zod";

import {
  requestAuthenticatedJSON,
  type AuthenticatedRequestLease,
} from "./client";
import { sessionSchema, type Session } from "./schemas";

export function upgradeGoogle(
  lease: AuthenticatedRequestLease,
  idToken: string,
  csrfToken: string,
): Promise<Session> {
  return requestAuthenticatedJSON(
    lease,
    "/api/v1/auth/google/upgrade",
    sessionSchema,
    {
      method: "POST",
      csrfToken,
      body: { idToken },
    },
  );
}

export function loginGoogle(
  lease: AuthenticatedRequestLease,
  idToken: string,
  csrfToken: string,
): Promise<Session> {
  return requestAuthenticatedJSON(
    lease,
    "/api/v1/auth/google/login",
    sessionSchema,
    {
      method: "POST",
      csrfToken,
      body: { idToken },
    },
  );
}

export function deleteAccount(
  lease: AuthenticatedRequestLease,
  csrfToken: string,
): Promise<void> {
  return requestAuthenticatedJSON(lease, "/api/v1/account", z.undefined(), {
    method: "DELETE",
    csrfToken,
    body: { confirmed: true },
  });
}
