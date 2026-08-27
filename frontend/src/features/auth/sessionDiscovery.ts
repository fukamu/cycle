import {
  APIError,
  SessionIdentityError,
  requestAnonymousSessionBootstrapJSON,
  requestCurrentSessionJSON,
} from "../../shared/api/client";
import { sessionSchema, type Session } from "../../shared/api/schemas";
import {
  clearBootstrapID,
  getOrCreateBootstrapID,
} from "./bootstrapRepository";
import { runSessionCookieWriter } from "./sessionCookieWriter";
import { getAnonymousBootstrapToken } from "./turnstile";

export const sessionQueryKey = ["session"] as const;

export const requestCurrentSession = (signal?: AbortSignal) =>
  requestCurrentSessionJSON(sessionSchema, {
    signal,
  });

export async function createAnonymousSession(): Promise<Session>;
export async function createAnonymousSession(
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<Session | null>;
export async function createAnonymousSession(
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<Session | null> {
  const bootstrapId = await getOrCreateBootstrapID();
  if (!isCurrent()) return null;
  const turnstileToken = await getAnonymousBootstrapToken();
  if (!isCurrent()) return null;
  const session = await runSessionCookieWriter(
    signal === undefined ? { isCurrent } : { isCurrent, signal },
    () =>
      requestAnonymousSessionBootstrapJSON(sessionSchema, {
        method: "POST",
        body: { bootstrapId, turnstileToken },
        signal,
      }),
  );
  if (session === null || !isCurrent()) return null;
  await clearBootstrapID();
  if (!isCurrent()) return null;
  return session;
}

export async function loadInitialSession(
  signal: AbortSignal,
): Promise<Session> {
  try {
    return await requestCurrentSession(signal);
  } catch (error) {
    if (!isUnavailableSession(error)) throw error;
  }
  const anonymousSession = await createAnonymousSession(
    () => !signal.aborted,
    signal,
  );
  if (anonymousSession === null) {
    signal.throwIfAborted();
    throw new Error("session discovery interrupted");
  }
  return anonymousSession;
}

export function isUnavailableSession(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 401 &&
    (error.code === "SESSION_MISSING" || error.code === "SESSION_EXPIRED")
  );
}

export function isSessionBoundaryOwnedError(error: unknown): boolean {
  if (error instanceof SessionIdentityError) return true;
  return (
    error instanceof APIError &&
    ((error.status === 401 &&
      (error.code === "SESSION_MISSING" || error.code === "SESSION_EXPIRED")) ||
      (error.status === 403 && error.code === "CSRF_INVALID"))
  );
}

export function isBetaAdmissionRequired(error: unknown): boolean {
  return error instanceof APIError && error.code === "BETA_ADMISSION_REQUIRED";
}
