import {
  APIError,
  RequestTimeoutError,
  SessionIdentityError,
  requestAnonymousSessionBootstrapJSON,
  requestCurrentSessionJSON,
  startupReadRequestTimeoutMs,
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
  const timeoutSignal = AbortSignal.timeout(startupReadRequestTimeoutMs);
  const creationSignal =
    signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
  try {
    const bootstrapId = await waitForSignal(
      getOrCreateBootstrapID(),
      creationSignal,
    );
    if (!isCurrent()) return null;
    const discovery = await runSessionCookieWriter(
      { isCurrent, signal: creationSignal },
      async () => {
        try {
          const existingSession = await requestCurrentSession(creationSignal);
          if (!isCurrent()) return null;
          // Another cookie writer already reconciled the browser-local guide
          // state for this authoritative Session. The waiting writer must not
          // clear or recreate that state during publication.
          onGuidePreferencesReconciled("deferred", existingSession);
          return existingSession;
        } catch (error) {
          if (!isUnavailableSession(error)) throw error;
        }

        const turnstileToken = await getAnonymousBootstrapToken(creationSignal);
        if (!isCurrent()) return null;
        const anonymousSession = await requestAnonymousSessionBootstrapJSON(
          sessionSchema,
          {
            method: "POST",
            body: { bootstrapId, turnstileToken },
            signal: creationSignal,
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
    await waitForSignal(clearBootstrapID(bootstrapId), creationSignal);
    if (!isCurrent()) return null;
    return discovery;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (timeoutSignal.aborted) throw new RequestTimeoutError();
    throw error;
  }
}

function waitForSignal<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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

export function isInitialSessionRateLimited(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 429 &&
    error.code === "RATE_LIMIT_EXCEEDED"
  );
}

export function isInitialSessionAnonymousCreationBlocked(
  error: unknown,
): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    error.code === "ANONYMOUS_CREATION_BLOCKED"
  );
}
