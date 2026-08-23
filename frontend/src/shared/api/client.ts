import type { z } from "zod";

import { isUUIDv7 } from "../id/uuid";
import { parseAPIError } from "./schemas";
import { NetworkError } from "./networkError";
import type { StableAPIErrorCode } from "./errorCodes";
import { sessionRecoveryEvents } from "./sessionRecoveryEvents";

export type APIErrorCode = StableAPIErrorCode | "INVALID_ERROR_RESPONSE";

export class APIError<
  const Code extends APIErrorCode = APIErrorCode,
> extends Error {
  readonly status: number;
  readonly code: Code;
  readonly requestId: string;

  constructor(
    status: number,
    code: Code,
    _message: string,
    requestId: string,
    _details?: Readonly<Record<string, unknown>>,
  ) {
    void _message;
    void _details;
    super("API request failed");
    this.name = "APIError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type RequestOptions = {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly csrfToken?: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal | undefined;
};

export type AuthenticatedRequestLease = {
  readonly expectedUserId: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
};

export type SessionIdentityFailureReason =
  | "SESSION_IDENTITY_STALE"
  | "SESSION_IDENTITY_DRIFT"
  | "SESSION_IDENTITY_UNVERIFIED";

export class SessionIdentityError extends Error {
  readonly reason: SessionIdentityFailureReason;

  constructor(reason: SessionIdentityFailureReason) {
    super(
      reason === "SESSION_IDENTITY_STALE"
        ? "Authenticated request lease is no longer current"
        : "Authenticated response identity verification failed",
    );
    this.name = "SessionIdentityError";
    this.reason = reason;
  }
}

type RequestPolicy =
  | { readonly kind: "public" }
  | { readonly kind: "session-discovery" }
  | {
      readonly kind: "authenticated";
      readonly lease: AuthenticatedRequestLease;
    };

type ResponseIdentity = "match" | "missing" | "malformed" | "mismatch";

const authenticatedUserIDHeader = "X-Fukamu-Authenticated-User-ID";
const expectedUserIDHeader = "X-Fukamu-Expected-User-ID";

export function requestAuthenticatedJSON<T>(
  lease: AuthenticatedRequestLease,
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return requestJSON(path, schema, options, { kind: "authenticated", lease });
}

export function requestCurrentSessionJSON<T>(
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return requestJSON("/api/v1/session", schema, options, {
    kind: "session-discovery",
  });
}

export function requestAnonymousSessionBootstrapJSON<T>(
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return requestJSON("/api/v1/session/anonymous", schema, options, {
    kind: "public",
  });
}

export function requestBetaAdmissionJSON<T>(
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return requestJSON("/api/__beta/admission/redeem", schema, options, {
    kind: "public",
  });
}

async function requestJSON<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions,
  policy: RequestPolicy,
): Promise<T> {
  if (policy.kind === "authenticated") {
    assertLeaseCurrent(policy.lease);
  }
  if (isSignalAborted(options.signal)) {
    throwCallerAbort(options.signal, undefined);
  }

  const publishSessionRecovery =
    policy.kind === "authenticated"
      ? sessionRecoveryEvents.capturePublisher()
      : undefined;
  const requestSignal =
    policy.kind === "authenticated"
      ? combineSignals(policy.lease.signal, options.signal)
      : options.signal;
  const init = createRequestInit(
    options,
    requestSignal,
    policy.kind === "authenticated" ? policy.lease.expectedUserId : undefined,
  );

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (policy.kind === "authenticated" && !isLeaseCurrent(policy.lease)) {
      throw staleIdentityError();
    }
    if (isSignalAborted(options.signal)) {
      throwCallerAbort(options.signal, error);
    }
    if (policy.kind === "authenticated" && policy.lease.signal.aborted) {
      throw staleIdentityError();
    }
    throw new NetworkError();
  }

  if (policy.kind === "authenticated") {
    assertLeaseCurrent(policy.lease);
    const identity = classifyAuthenticatedResponseIdentity(
      response,
      policy.lease.expectedUserId,
    );
    if (identity === "mismatch") {
      publishCurrentIdentityRecovery("SESSION_IDENTITY_DRIFT");
      throw new SessionIdentityError("SESSION_IDENTITY_DRIFT");
    }
    if (
      identity === "malformed" ||
      (identity === "missing" && response.status !== 401)
    ) {
      publishCurrentIdentityRecovery("SESSION_IDENTITY_UNVERIFIED");
      throw new SessionIdentityError("SESSION_IDENTITY_UNVERIFIED");
    }
  }
  if (isSignalAborted(options.signal)) {
    throwCallerAbort(options.signal, undefined);
  }

  let payload: unknown;
  try {
    payload = response.status === 204 ? undefined : await response.json();
  } catch (error) {
    if (policy.kind === "authenticated" && !isLeaseCurrent(policy.lease)) {
      throw staleIdentityError();
    }
    if (isSignalAborted(options.signal)) {
      throwCallerAbort(options.signal, error);
    }
    payload = undefined;
  }

  if (policy.kind === "authenticated") {
    assertLeaseCurrent(policy.lease);
  }
  if (isSignalAborted(options.signal)) {
    throwCallerAbort(options.signal, undefined);
  }

  const apiError = response.ok
    ? undefined
    : createAPIError(response.status, payload);

  if (policy.kind === "authenticated") {
    const identity = classifyAuthenticatedResponseIdentity(
      response,
      policy.lease.expectedUserId,
    );
    if (identity === "mismatch") {
      publishCurrentIdentityRecovery("SESSION_IDENTITY_DRIFT");
      throw new SessionIdentityError("SESSION_IDENTITY_DRIFT");
    }
    if (identity !== "match") {
      if (
        identity === "missing" &&
        apiError !== undefined &&
        isUnavailableSessionError(apiError)
      ) {
        publishAPIRecovery(apiError, publishSessionRecovery);
        throw apiError;
      }
      publishCurrentIdentityRecovery("SESSION_IDENTITY_UNVERIFIED");
      throw new SessionIdentityError("SESSION_IDENTITY_UNVERIFIED");
    }
    if (apiError !== undefined) {
      publishAPIRecovery(apiError, publishSessionRecovery);
      throw apiError;
    }
  } else if (apiError !== undefined) {
    throw apiError;
  }

  if (policy.kind === "session-discovery") {
    verifyDiscoveredSessionIdentity(response, payload);
  }

  const parsed = schema.parse(payload);
  if (policy.kind === "authenticated") {
    assertLeaseCurrent(policy.lease);
  }
  return parsed;
}

function createRequestInit(
  options: RequestOptions,
  signal: AbortSignal | undefined,
  expectedUserId: string | undefined,
): RequestInit {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  if (options.csrfToken !== undefined) {
    headers.set("X-CSRF-Token", options.csrfToken);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (expectedUserId !== undefined) {
    headers.set(expectedUserIDHeader, expectedUserId);
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    credentials: "same-origin",
    cache: "no-store",
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  if (signal !== undefined) {
    init.signal = signal;
  }
  return init;
}

function createAPIError(status: number, payload: unknown): APIError {
  const parsed = parseAPIError(payload);
  if (parsed.success) {
    return new APIError(
      status,
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.requestId,
      parsed.data.error.details,
    );
  }
  return new APIError(
    status,
    "INVALID_ERROR_RESPONSE",
    "サーバーから不正な応答を受信しました。",
    "unknown",
  );
}

function classifyAuthenticatedResponseIdentity(
  response: Response,
  expectedUserId: string,
): ResponseIdentity {
  const actualUserId = response.headers.get(authenticatedUserIDHeader);
  if (actualUserId === null) return "missing";
  if (!isUUIDv7(actualUserId) || !isUUIDv7(expectedUserId)) {
    return "malformed";
  }
  return actualUserId === expectedUserId ? "match" : "mismatch";
}

function verifyDiscoveredSessionIdentity(
  response: Response,
  payload: unknown,
): void {
  const headerUserId = response.headers.get(authenticatedUserIDHeader);
  const bodyUserId = readSessionBodyUserID(payload);
  if (
    headerUserId === null ||
    !isUUIDv7(headerUserId) ||
    bodyUserId === null ||
    !isUUIDv7(bodyUserId)
  ) {
    throw new SessionIdentityError("SESSION_IDENTITY_UNVERIFIED");
  }
  if (headerUserId !== bodyUserId) {
    throw new SessionIdentityError("SESSION_IDENTITY_DRIFT");
  }
}

function readSessionBodyUserID(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const user = Reflect.get(payload, "user");
  if (typeof user !== "object" || user === null) return null;
  const userId = Reflect.get(user, "id");
  return typeof userId === "string" ? userId : null;
}

function isUnavailableSessionError(error: APIError): boolean {
  return (
    error.status === 401 &&
    (error.code === "SESSION_MISSING" || error.code === "SESSION_EXPIRED")
  );
}

function publishAPIRecovery(
  error: APIError,
  publish:
    | ReturnType<typeof sessionRecoveryEvents.capturePublisher>
    | undefined,
): void {
  if (error.status === 401 && error.code === "SESSION_MISSING") {
    publish?.("SESSION_MISSING");
  } else if (error.status === 401 && error.code === "SESSION_EXPIRED") {
    publish?.("SESSION_EXPIRED");
  } else if (error.status === 403 && error.code === "CSRF_INVALID") {
    publish?.("CSRF_INVALID");
  }
}

function publishCurrentIdentityRecovery(
  reason: "SESSION_IDENTITY_DRIFT" | "SESSION_IDENTITY_UNVERIFIED",
): void {
  sessionRecoveryEvents.capturePublisher()(reason);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function combineSignals(
  leaseSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): AbortSignal {
  if (callerSignal === undefined || callerSignal === leaseSignal) {
    return leaseSignal;
  }
  return AbortSignal.any([leaseSignal, callerSignal]);
}

function isLeaseCurrent(lease: AuthenticatedRequestLease): boolean {
  if (lease.signal.aborted) return false;
  try {
    return lease.isCurrent();
  } catch {
    return false;
  }
}

function assertLeaseCurrent(lease: AuthenticatedRequestLease): void {
  if (!isLeaseCurrent(lease)) throw staleIdentityError();
}

function staleIdentityError(): SessionIdentityError {
  return new SessionIdentityError("SESSION_IDENTITY_STALE");
}

function throwCallerAbort(
  signal: AbortSignal | undefined,
  error: unknown,
): never {
  if (error instanceof DOMException && error.name === "AbortError") {
    throw error;
  }
  if (
    signal?.reason instanceof DOMException &&
    signal.reason.name === "AbortError"
  ) {
    throw signal.reason;
  }
  throw new DOMException("The operation was aborted", "AbortError");
}
