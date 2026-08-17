import { z } from "zod";

import { requestJSON } from "./client";
import { sessionSchema, type Session } from "./schemas";

export function upgradeGoogle(
  idToken: string,
  csrfToken: string,
): Promise<Session> {
  return requestJSON("/api/v1/auth/google/upgrade", sessionSchema, {
    method: "POST",
    csrfToken,
    body: { idToken },
  });
}

export function loginGoogle(
  idToken: string,
  csrfToken: string,
): Promise<Session> {
  return requestJSON("/api/v1/auth/google/login", sessionSchema, {
    method: "POST",
    csrfToken,
    body: { idToken },
  });
}

export function deleteAccount(csrfToken: string): Promise<void> {
  return requestJSON("/api/v1/account", z.undefined(), {
    method: "DELETE",
    csrfToken,
    body: { confirmed: true },
  });
}
