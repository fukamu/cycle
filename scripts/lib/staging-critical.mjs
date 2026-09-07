import { createHash } from "node:crypto";

const canonicalStagingBaseURL = "https://cycle.staging.fukamu.matoruru.com";
const inviteTokenPattern = /^fukamu_cycle_beta_[A-Za-z0-9_-]{43}$/;
const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumUUIDTimestamp = 0xffffffffffff;

export const stagingCriticalFailureReasons = Object.freeze([
  "entry_cta_timeout",
  "anonymous_session_not_observed",
  "unexpected_status",
  "session_discovery_failed",
  "account_delete_failed",
  "cleanup_unverified",
]);

export const stagingCriticalPhases = Object.freeze([
  "configuration",
  "browser_launch",
  "health",
  "readiness",
  "bootstrap_seed",
  "entry",
  "session_discovery",
  "goal_creation",
  "cycle_editing",
  "cycle_completion",
  "review_transition",
  "history_verification",
  "account_delete",
  "cleanup_verification",
]);
const stagingCriticalPhaseSet = new Set(stagingCriticalPhases);
const stagingCriticalReasons = new Set(stagingCriticalFailureReasons);

export class StagingCriticalFailure extends Error {
  constructor(phase, reason) {
    if (
      !stagingCriticalPhaseSet.has(phase) ||
      !stagingCriticalReasons.has(reason)
    ) {
      throw new Error("staging critical failure classification is invalid");
    }
    super("staging critical check failed");
    this.name = "StagingCriticalFailure";
    this.phase = phase;
    this.reason = reason;
  }
}

export function parseStagingCriticalMode(value) {
  if (value !== "baseline" && value !== "full") {
    throw new Error("staging critical mode is invalid");
  }
  return value;
}

export function parseStagingAdmissionMode(value) {
  if (value !== "auto" && value !== "off" && value !== "closed") {
    throw new Error("staging admission mode is invalid");
  }
  return value;
}

export function formatStagingCriticalDiagnostic(failure, metadata) {
  if (
    !(failure instanceof StagingCriticalFailure) ||
    typeof metadata !== "object" ||
    metadata === null ||
    !/^(?:local|[1-9][0-9]*)$/.test(metadata.runID) ||
    !/^(?:local|[1-9][0-9]*)$/.test(metadata.runAttempt) ||
    !/^(?:local|[0-9a-f]{40})$/.test(metadata.commitSHA)
  ) {
    throw new Error("staging critical diagnostic metadata is invalid");
  }
  return `::error::Staging critical failed; phase=${failure.phase}; reason=${failure.reason}; run_id=${metadata.runID}; run_attempt=${metadata.runAttempt}; commit_sha=${metadata.commitSHA}.`;
}

export async function runStagingCritical({
  mode,
  admissionMode,
  adapter,
  retryOptions,
}) {
  parseStagingCriticalMode(mode);
  parseStagingAdmissionMode(admissionMode);
  if (typeof adapter !== "object" || adapter === null) {
    throw new Error("staging critical adapter is invalid");
  }

  const failures = [];
  let phase = "browser_launch";
  let bootstrapMayHaveRun = false;
  let session;
  let validatedSession;

  const record = (failure, fallbackPhase = phase) => {
    const classified =
      failure instanceof StagingCriticalFailure
        ? failure
        : new StagingCriticalFailure(fallbackPhase, "unexpected_status");
    if (
      !failures.some(
        (existing) =>
          existing.phase === classified.phase &&
          existing.reason === classified.reason,
      )
    ) {
      failures.push(classified);
    }
  };

  try {
    await adapter.launch();
    phase = "health";
    if ((await adapter.checkHealth()) !== 200) {
      throw new StagingCriticalFailure(phase, "unexpected_status");
    }
    phase = "readiness";
    if ((await adapter.checkReadiness()) !== 200) {
      throw new StagingCriticalFailure(phase, "unexpected_status");
    }
    phase = "bootstrap_seed";
    await adapter.seedBootstrap();
    bootstrapMayHaveRun = true;
    phase = "entry";
    session = await adapter.enter(admissionMode);
    if (session === undefined) {
      throw new StagingCriticalFailure(phase, "anonymous_session_not_observed");
    }
    phase = "session_discovery";
    let discoveredSession;
    try {
      discoveredSession = await adapter.discoverSession();
    } catch {
      throw new StagingCriticalFailure(phase, "session_discovery_failed");
    }
    if (
      discoveredSession === undefined ||
      discoveredSession.userID !== session.userID
    ) {
      throw new StagingCriticalFailure(phase, "session_discovery_failed");
    }
    session = discoveredSession;
    validatedSession = discoveredSession;
    if (mode === "full") {
      await adapter.runFullJourney((nextPhase) => {
        if (!stagingCriticalPhaseSet.has(nextPhase)) {
          throw new StagingCriticalFailure(
            "configuration",
            "unexpected_status",
          );
        }
        phase = nextPhase;
      });
    }
  } catch (failure) {
    record(failure);
  }

  if (bootstrapMayHaveRun) {
    await adapter.beforeCleanup().catch(() => undefined);
    let cleanupSession;
    try {
      cleanupSession = await adapter.discoverSession();
    } catch {
      record(
        new StagingCriticalFailure(
          "session_discovery",
          "session_discovery_failed",
        ),
      );
    }
    if (cleanupSession === undefined) {
      if (
        !failures.some(
          (failure) => failure.reason === "session_discovery_failed",
        )
      ) {
        record(
          new StagingCriticalFailure(
            "session_discovery",
            "session_discovery_failed",
          ),
        );
      }
    }
    let deletionSession = validatedSession ?? session;
    if (cleanupSession !== undefined) {
      if (
        deletionSession !== undefined &&
        cleanupSession.userID !== deletionSession.userID
      ) {
        record(
          new StagingCriticalFailure(
            "session_discovery",
            "session_discovery_failed",
          ),
        );
      } else {
        deletionSession = cleanupSession;
      }
    }
    if (deletionSession !== undefined) {
      let deleted = false;
      try {
        await retryPublicAccountDelete(
          () => adapter.deleteAccount(deletionSession),
          retryOptions,
        );
        deleted = true;
      } catch {
        record(
          new StagingCriticalFailure("account_delete", "account_delete_failed"),
        );
      }
      if (deleted) {
        try {
          if ((await adapter.verifyDeleted()) !== 401) {
            throw new StagingCriticalFailure(
              "cleanup_verification",
              "cleanup_unverified",
            );
          }
        } catch (failure) {
          record(
            failure instanceof StagingCriticalFailure
              ? failure
              : new StagingCriticalFailure(
                  "cleanup_verification",
                  "cleanup_unverified",
                ),
          );
        }
      }
    }
  }

  await adapter.close().catch(() => undefined);
  return failures;
}

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
