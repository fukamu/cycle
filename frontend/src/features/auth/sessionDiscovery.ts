import {
  APIError,
  SessionIdentityError,
  requestAnonymousSessionBootstrapJSON,
  requestCurrentSessionJSON,
} from "../../shared/api/client";
import { sessionSchema, type Session } from "../../shared/api/schemas";
import {
  activateFirstUseGuide,
  bindFirstUseGuidePreferencesToCurrentSession,
} from "../../shared/preferences/firstUseGuidePreference";
import {
  clearBootstrapID,
  getOrCreateBootstrapID,
} from "./bootstrapRepository";
import { runSessionCookieWriter } from "./sessionCookieWriter";
import { getAnonymousBootstrapToken } from "./turnstile";
import type { GuidePreferencesReconciliation } from "./sessionBoundaryContracts";

export const sessionQueryKey = ["session"] as const;

export const requestCurrentSession = (signal?: AbortSignal) =>
  requestCurrentSessionJSON(sessionSchema, {
    signal,
  });

export async function createAnonymousSession(): Promise<Session>;
export async function createAnonymousSession(
  isCurrent: () => boolean,
  signal?: AbortSignal,
  onGuidePreferencesReconciled?: (
    reconciliation: GuidePreferencesReconciliation,
    session: Session,
  ) => void,
): Promise<Session | null>;
export async function createAnonymousSession(
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
  onGuidePreferencesReconciled: (
    reconciliation: GuidePreferencesReconciliation,
    session: Session,
  ) => void = () => undefined,
): Promise<Session | null> {
  const bootstrapId = await getOrCreateBootstrapID();
  if (!isCurrent()) return null;
  const discovery = await runSessionCookieWriter(
    signal === undefined ? { isCurrent } : { isCurrent, signal },
    async () => {
      try {
        const existingSession = await requestCurrentSession(signal);
        if (!isCurrent()) return null;
        // Another cookie writer already reconciled the browser-local guide
        // state for this authoritative Session. The waiting writer must not
        // clear or recreate that state during publication.
        onGuidePreferencesReconciled("deferred", existingSession);
        return existingSession;
      } catch (error) {
        if (!isUnavailableSession(error)) throw error;
      }

      const turnstileToken = await getAnonymousBootstrapToken();
      if (!isCurrent()) return null;
      const anonymousSession = await requestAnonymousSessionBootstrapJSON(
        sessionSchema,
        {
          method: "POST",
          body: { bootstrapId, turnstileToken },
          signal,
        },
      );
      if (!isCurrent()) return null;
      const activation = activateFirstUseGuide();
      onGuidePreferencesReconciled(
        activation.sharedSafe ? "local-shared-safe" : "local-document-only",
        anonymousSession,
      );
      return anonymousSession;
    },
  );
  if (discovery === null || !isCurrent()) return null;
  await clearBootstrapID(bootstrapId);
  if (!isCurrent()) return null;
  return discovery;
}

export async function loadInitialSession(
  signal: AbortSignal,
  onGuidePreferencesReconciled?: (
    reconciliation: GuidePreferencesReconciliation,
    session: Session,
  ) => void,
): Promise<Session> {
  try {
    const existingSession = await requestCurrentSession(signal);
    signal.throwIfAborted();
    bindFirstUseGuidePreferencesToCurrentSession();
    return existingSession;
  } catch (error) {
    if (!isUnavailableSession(error)) throw error;
  }
  const anonymousSession = await createAnonymousSession(
    () => !signal.aborted,
    signal,
    onGuidePreferencesReconciled,
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

export function isInitialSessionRateLimited(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 429 &&
    error.code === "RATE_LIMIT_EXCEEDED"
  );
}
