import { createHash } from "node:crypto";

const canonicalStagingBaseURL = "https://cycle.staging.fukamu.matoruru.com";
const inviteTokenPattern = /^fukamu_cycle_beta_[A-Za-z0-9_-]{43}$/;
const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumUUIDTimestamp = 0xffffffffffff;

export function parseStagingBaseURL(value) {
  if (value !== canonicalStagingBaseURL) {
    throw new Error("staging base URL is not canonical");
  }
  return canonicalStagingBaseURL;
}

export function validateStagingInviteToken(value) {
  if (typeof value !== "string" || !inviteTokenPattern.test(value)) {
    throw new Error("staging invite token is invalid");
  }
  return value;
}

export function deriveBootstrapUUIDv7(runKey, timestampMilliseconds) {
  if (
    typeof runKey !== "string" ||
    runKey.length === 0 ||
    runKey.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(runKey)
  ) {
    throw new Error("staging run key is invalid");
  }
  if (
    !Number.isSafeInteger(timestampMilliseconds) ||
    timestampMilliseconds < 0 ||
    timestampMilliseconds > maximumUUIDTimestamp
  ) {
    throw new Error("staging run timestamp is invalid");
  }

  const bytes = Buffer.alloc(16);
  let remainingTimestamp = timestampMilliseconds;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }
  const digest = createHash("sha256")
    .update("fukamu-cycle-staging-critical-bootstrap\0", "utf8")
    .update(runKey, "utf8")
    .digest();
  digest.copy(bytes, 6, 0, 10);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = bytes.toString("hex");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

export function accountCorrelation(userID) {
  if (typeof userID !== "string" || !uuidV7Pattern.test(userID)) {
    throw new Error("account identifier is invalid");
  }
  return `sha256:${createHash("sha256").update(userID, "utf8").digest("hex")}`;
}

export function parseAnonymousSession(payload, authenticatedUserID) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("staging session response is invalid");
  }
  const session = payload;
  if (
    typeof session.user !== "object" ||
    session.user === null ||
    Array.isArray(session.user) ||
    typeof session.user.id !== "string" ||
    !uuidV7Pattern.test(session.user.id) ||
    session.user.googleConnected !== false ||
    session.user.googleEmail !== null ||
    typeof session.csrfToken !== "string" ||
    session.csrfToken.length === 0 ||
    session.csrfToken.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(session.csrfToken) ||
    authenticatedUserID !== session.user.id
  ) {
    throw new Error("staging session response is invalid");
  }
  return { userID: session.user.id, csrfToken: session.csrfToken };
}

export async function retryPublicAccountDelete(
  sendDelete,
  {
    retryDelaysMilliseconds = [1_000, 2_000, 4_000, 8_000, 16_000],
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (typeof sendDelete !== "function" || typeof sleep !== "function") {
    throw new Error("staging cleanup configuration is invalid");
  }
  if (
    !Array.isArray(retryDelaysMilliseconds) ||
    retryDelaysMilliseconds.some(
      (delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 60_000,
    )
  ) {
    throw new Error("staging cleanup configuration is invalid");
  }

  for (
    let attempt = 0;
    attempt <= retryDelaysMilliseconds.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(retryDelaysMilliseconds[attempt - 1]);
    }
    let result;
    try {
      result = await sendDelete();
    } catch {
      result = undefined;
    }
    if (
      typeof result === "object" &&
      result !== null &&
      result.status === 204 &&
      result.authenticatedUserIDVerified === true
    ) {
      return attempt + 1;
    }
  }
  throw new Error("staging public account cleanup failed");
}
