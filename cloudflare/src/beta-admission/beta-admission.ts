// TEMPORARY CLOSED BETA: this module is an ingress-only admission layer.
// Remove this directory and the small hook in src/index.ts for general release.

const admissionCookieName = "__Host-fukamu_cycle_beta_admission";
const sessionCookieName = "__Host-fukamu_cycle_session";
const redeemPath = "/api/__beta/admission/redeem";
const anonymousSessionPath = "/api/v1/session/anonymous";
const sessionPath = "/api/v1/session";
const maximumBodyBytes = 2_048;
const secondsPerDay = 86_400;
const tokenPattern = /^fukamu_cycle_beta_[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const inviteIDPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type BetaAdmissionBindings = {
  readonly PUBLIC_ORIGIN?: string;
  readonly BETA_ADMISSION_MODE?: string;
  readonly BETA_ADMISSION_COOKIE_TTL_DAYS?: string;
  readonly BETA_INVITES?: string;
  readonly BETA_ADMISSION_COOKIE_KEY?: string;
};

type ClosedConfig = {
  readonly mode: "closed";
  readonly publicOrigin: string;
  readonly cookieTTLDays: number;
  readonly inviteDigests: readonly string[];
  readonly cookieKey: Uint8Array;
};

type ParsedConfig = { readonly mode: "off" } | ClosedConfig;

type InviteEntry = {
  readonly id: string;
  readonly digest: string;
};

type APIErrorCode =
  | "BETA_ADMISSION_REQUIRED"
  | "BETA_ADMISSION_UNAVAILABLE"
  | "BETA_INVITE_INVALID"
  | "CSRF_INVALID"
  | "VALIDATION_ERROR";

export async function handleBetaAdmission(
  request: Request,
  bindings: BetaAdmissionBindings,
  nowMilliseconds = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url);
  const relevant =
    url.pathname === redeemPath ||
    (url.pathname === anonymousSessionPath && request.method === "POST") ||
    (url.pathname === sessionPath && request.method === "GET");
  if (!relevant) return null;

  let config: ParsedConfig;
  try {
    config = parseConfig(bindings);
  } catch {
    if (url.pathname === sessionPath && hasCookie(request, sessionCookieName)) {
      return null;
    }
    return apiError(
      request,
      503,
      "BETA_ADMISSION_UNAVAILABLE",
      "現在、新しい利用を開始できません。",
    );
  }
  if (config.mode === "off") return null;

  if (url.pathname === redeemPath) {
    return redeem(request, config, nowMilliseconds);
  }

  if (url.pathname === sessionPath && hasCookie(request, sessionCookieName)) {
    return null;
  }

  const cookie = cookieValue(request, admissionCookieName);
  if (
    cookie !== null &&
    (await verifyAdmissionCookie(cookie, config.cookieKey, nowMilliseconds))
  ) {
    return null;
  }
  return apiError(
    request,
    403,
    "BETA_ADMISSION_REQUIRED",
    "FUKAMU Cycle Closed Betaの招待Tokenが必要です。",
  );
}

async function redeem(
  request: Request,
  config: ClosedConfig,
  nowMilliseconds: number,
): Promise<Response> {
  if (request.method !== "POST") {
    return apiError(
      request,
      400,
      "VALIDATION_ERROR",
      "入力内容を確認してください。",
    );
  }
  if (request.headers.get("Origin") !== config.publicOrigin) {
    return apiError(
      request,
      403,
      "CSRF_INVALID",
      "ページを再読み込みして、もう一度お試しください。",
    );
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (
    !contentType.toLowerCase().startsWith("application/json") ||
    !Number.isFinite(contentLength) ||
    contentLength > maximumBodyBytes
  ) {
    return apiError(
      request,
      400,
      "VALIDATION_ERROR",
      "入力内容を確認してください。",
    );
  }

  let value: unknown;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumBodyBytes) {
      throw new Error("body too large");
    }
    value = JSON.parse(body);
  } catch {
    return apiError(
      request,
      400,
      "VALIDATION_ERROR",
      "入力内容を確認してください。",
    );
  }
  const token = inviteToken(value);
  if (token === null) {
    return apiError(
      request,
      403,
      "BETA_INVITE_INVALID",
      "招待Tokenを確認できませんでした。",
    );
  }

  const digest = await sha256Hex(token);
  if (!constantTimeIncludes(config.inviteDigests, digest)) {
    return apiError(
      request,
      403,
      "BETA_INVITE_INVALID",
      "招待Tokenを確認できませんでした。",
    );
  }

  const expiresAt =
    Math.floor(nowMilliseconds / 1_000) + config.cookieTTLDays * secondsPerDay;
  const cookie = await createAdmissionCookie(config.cookieKey, expiresAt);
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": serializeAdmissionCookie(
        cookie,
        expiresAt,
        Math.floor(nowMilliseconds / 1_000),
      ),
      "X-Request-ID": requestID(request),
    },
  });
}

function parseConfig(bindings: BetaAdmissionBindings): ParsedConfig {
  if (bindings.BETA_ADMISSION_MODE === "off") return { mode: "off" };
  if (bindings.BETA_ADMISSION_MODE !== "closed") {
    throw new Error("BETA_ADMISSION_MODE must be off or closed");
  }

  const publicURL = new URL(bindings.PUBLIC_ORIGIN ?? "");
  const publicOrigin = publicURL.origin;
  if (
    publicURL.protocol !== "https:" ||
    publicOrigin !== bindings.PUBLIC_ORIGIN
  ) {
    throw new Error("PUBLIC_ORIGIN must be a canonical HTTPS origin");
  }
  const cookieTTLDays = Number(bindings.BETA_ADMISSION_COOKIE_TTL_DAYS);
  if (
    !Number.isInteger(cookieTTLDays) ||
    cookieTTLDays < 1 ||
    cookieTTLDays > 730
  ) {
    throw new Error("BETA_ADMISSION_COOKIE_TTL_DAYS is invalid");
  }
  const cookieKey = decodeBase64URL(bindings.BETA_ADMISSION_COOKIE_KEY ?? "");
  if (cookieKey.byteLength !== 32) {
    throw new Error("BETA_ADMISSION_COOKIE_KEY must contain 32 bytes");
  }

  let entries: unknown;
  try {
    entries = JSON.parse(bindings.BETA_INVITES ?? "");
  } catch {
    throw new Error("BETA_INVITES must be JSON");
  }
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > 1_000
  ) {
    throw new Error("BETA_INVITES must contain 1 to 1000 entries");
  }
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const entry of entries) {
    if (!isInviteEntry(entry)) throw new Error("BETA_INVITES entry is invalid");
    if (ids.has(entry.id) || digests.has(entry.digest)) {
      throw new Error("BETA_INVITES entries must be unique");
    }
    ids.add(entry.id);
    digests.add(entry.digest);
  }
  return {
    mode: "closed",
    publicOrigin,
    cookieTTLDays,
    inviteDigests: [...digests],
    cookieKey,
  };
}

function isInviteEntry(value: unknown): value is InviteEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    typeof candidate.id === "string" &&
    inviteIDPattern.test(candidate.id) &&
    typeof candidate.digest === "string" &&
    digestPattern.test(candidate.digest)
  );
}

function inviteToken(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 1 ||
    typeof candidate.token !== "string" ||
    !tokenPattern.test(candidate.token)
  ) {
    return null;
  }
  return candidate.token;
}

async function createAdmissionCookie(
  keyBytes: Uint8Array,
  expiresAt: number,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const payload = `v1.${expiresAt}.${encodeBase64URL(nonce)}`;
  const signature = await sign(keyBytes, payload);
  return `${payload}.${encodeBase64URL(signature)}`;
}

async function verifyAdmissionCookie(
  value: string,
  keyBytes: Uint8Array,
  nowMilliseconds: number,
): Promise<boolean> {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{10}$/.test(parts[1])) {
    return false;
  }
  const expiresAt = Number(parts[1]);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(nowMilliseconds / 1_000)
  ) {
    return false;
  }
  try {
    if (decodeBase64URL(parts[2]).byteLength !== 16) return false;
    const signature = decodeBase64URL(parts[3]);
    if (signature.byteLength !== 32) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(parts.slice(0, 3).join(".")),
    );
  } catch {
    return false;
  }
}

async function sign(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeIncludes(
  values: readonly string[],
  candidate: string,
): boolean {
  let matches = 0;
  for (const value of values) {
    let difference = value.length ^ candidate.length;
    for (let index = 0; index < 64; index += 1) {
      difference |= value.charCodeAt(index) ^ candidate.charCodeAt(index);
    }
    matches |= Number(difference === 0);
  }
  return matches !== 0;
}

function serializeAdmissionCookie(
  value: string,
  expiresAt: number,
  nowSeconds: number,
): string {
  return [
    `${admissionCookieName}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, expiresAt - nowSeconds)}`,
    `Expires=${new Date(expiresAt * 1_000).toUTCString()}`,
  ].join("; ");
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

function hasCookie(request: Request, name: string): boolean {
  return cookieValue(request, name) !== null;
}

function apiError(
  request: Request,
  status: number,
  code: APIErrorCode,
  message: string,
): Response {
  const id = requestID(request);
  return new Response(
    JSON.stringify({ error: { code, message, requestId: id } }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Request-ID": id,
      },
    },
  );
}

function requestID(request: Request): string {
  const supplied = request.headers.get("X-Request-ID")?.trim().toLowerCase();
  if (supplied !== undefined && uuidV7Pattern.test(supplied)) return supplied;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeBase64URL(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64URL(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
