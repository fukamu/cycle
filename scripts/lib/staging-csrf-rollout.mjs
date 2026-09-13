import { StagingCriticalFailure } from "./staging-critical.mjs";

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const csrfTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export const stagingCSRFRolloutFailureReasons = Object.freeze([
  "unexpected_status",
  "legacy_session_invalid",
  "anonymous_session_request_not_observed",
  "anonymous_session_bad_request",
  "anonymous_session_forbidden",
  "anonymous_session_rate_limited",
  "anonymous_session_unavailable",
  "legacy_baseline_not_observed",
  "deploy_or_drain_failed",
  "session_identity_changed",
  "candidate_not_observed",
  "stable_token_invalid",
  "security_rejection_invalid",
  "account_delete_failed",
  "cleanup_unverified",
]);

export const stagingCSRFRolloutPhases = Object.freeze([
  "configuration",
  "browser_launch",
  "legacy_session",
  "legacy_confirmation",
  "legacy_unsafe_request",
  "deploy_and_drain",
  "two_tab_convergence",
  "reload_stability",
  "tab_a_autosave",
  "tab_a_command",
  "tab_b_command",
  "tab_b_autosave",
  "security_rejections",
  "account_delete",
  "cleanup_verification",
]);

const failureReasonSet = new Set(stagingCSRFRolloutFailureReasons);
const phaseSet = new Set(stagingCSRFRolloutPhases);

export class StagingCSRFRolloutFailure extends Error {
  constructor(phase, reason) {
    if (!phaseSet.has(phase) || !failureReasonSet.has(reason)) {
      throw new Error("staging CSRF rollout failure classification is invalid");
    }
    super("staging CSRF rollout check failed");
    this.name = "StagingCSRFRolloutFailure";
    this.phase = phase;
    this.reason = reason;
  }
}

export function formatStagingCSRFRolloutDiagnostic(failure, metadata) {
  if (
    !(failure instanceof StagingCSRFRolloutFailure) ||
    typeof metadata !== "object" ||
    metadata === null ||
    !/^(?:local|[1-9][0-9]*)$/.test(metadata.runID) ||
    !/^(?:local|[1-9][0-9]*)$/.test(metadata.runAttempt) ||
    !/^(?:local|[0-9a-f]{40})$/.test(metadata.commitSHA)
  ) {
    throw new Error("staging CSRF rollout diagnostic metadata is invalid");
  }
  return `::error::Staging CSRF rollout failed; phase=${failure.phase}; reason=${failure.reason}; run_id=${metadata.runID}; run_attempt=${metadata.runAttempt}; commit_sha=${metadata.commitSHA}.`;
}

export function validateRolloutSession(value, failurePhase = "legacy_session") {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.userID !== "string" ||
    !uuidV7Pattern.test(value.userID) ||
    typeof value.csrfToken !== "string" ||
    !csrfTokenPattern.test(value.csrfToken)
  ) {
    throw new StagingCSRFRolloutFailure(
      failurePhase,
      failurePhase === "legacy_session" ||
        failurePhase === "legacy_confirmation"
        ? "legacy_session_invalid"
        : "stable_token_invalid",
    );
  }
  return { userID: value.userID, csrfToken: value.csrfToken };
}

export async function runStagingCSRFRollout({ adapter, retryOptions } = {}) {
  if (typeof adapter !== "object" || adapter === null) {
    throw new Error("staging CSRF rollout adapter is invalid");
  }

  const failures = [];
  let phase = "browser_launch";
  let originalUserID;
  let originalSession;
  let latestOriginalSession;
  let accountDeleted = false;

  const record = (failure, fallbackPhase = phase) => {
    const classified =
      failure instanceof StagingCSRFRolloutFailure
        ? failure
        : failure instanceof StagingCriticalFailure &&
            failureReasonSet.has(failure.reason)
          ? new StagingCSRFRolloutFailure(fallbackPhase, failure.reason)
          : new StagingCSRFRolloutFailure(fallbackPhase, "unexpected_status");
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

    phase = "legacy_session";
    const preparedSession = await adapter.prepareLegacySession();
    originalUserID = extractUserID(preparedSession);
    await adapter.captureRevokedSessionProbe();
    originalSession = validateRolloutSession(preparedSession);
    latestOriginalSession = originalSession;

    phase = "legacy_confirmation";
    const confirmedLegacySession = validateRolloutSession(
      await adapter.confirmLegacySession(originalSession),
      phase,
    );
    requireOriginalIdentity(confirmedLegacySession, originalSession, phase);
    if (confirmedLegacySession.csrfToken === originalSession.csrfToken) {
      throw new StagingCSRFRolloutFailure(
        phase,
        "legacy_baseline_not_observed",
      );
    }
    originalSession = confirmedLegacySession;
    latestOriginalSession = confirmedLegacySession;
    await adapter.prepareSecondTab();

    phase = "legacy_unsafe_request";
    requireSuccess(
      await adapter.runLegacyUnsafeRequest(originalSession),
      phase,
    );

    phase = "deploy_and_drain";
    try {
      await adapter.runDeployAndDrain();
    } catch {
      throw new StagingCSRFRolloutFailure(phase, "deploy_or_drain_failed");
    }

    phase = "two_tab_convergence";
    const discovered = await adapter.discoverTwoTabsConcurrently();
    if (!Array.isArray(discovered) || discovered.length !== 2) {
      throw new StagingCSRFRolloutFailure(phase, "stable_token_invalid");
    }
    const tabA = validateRolloutSession(discovered[0], phase);
    const tabB = validateRolloutSession(discovered[1], phase);
    requireOriginalIdentity(tabA, originalSession, phase);
    requireOriginalIdentity(tabB, originalSession, phase);
    if (tabA.csrfToken !== tabB.csrfToken) {
      throw new StagingCSRFRolloutFailure(phase, "stable_token_invalid");
    }
    if (tabA.csrfToken === originalSession.csrfToken) {
      throw new StagingCSRFRolloutFailure(phase, "candidate_not_observed");
    }
    latestOriginalSession = tabA;

    phase = "reload_stability";
    const reloaded = validateRolloutSession(
      await adapter.reloadTabAAndDiscover(),
      phase,
    );
    requireOriginalIdentity(reloaded, originalSession, phase);
    if (reloaded.csrfToken !== tabA.csrfToken) {
      throw new StagingCSRFRolloutFailure(phase, "stable_token_invalid");
    }
    latestOriginalSession = reloaded;

    phase = "tab_a_autosave";
    requireSuccess(await adapter.runTabAAutosave(reloaded), phase);
    phase = "tab_a_command";
    requireSuccess(await adapter.runTabACommand(reloaded), phase);
    phase = "tab_b_command";
    requireSuccess(await adapter.runTabBCommand(tabB), phase);
    phase = "tab_b_autosave";
    requireSuccess(await adapter.runTabBAutosave(tabB), phase);

    phase = "security_rejections";
    for (const kind of ["legacy_token", "invalid_token", "invalid_origin"]) {
      requireCSRFRejection(
        await adapter.verifyCSRFRejection(kind, {
          originalSession,
          stableSession: reloaded,
        }),
      );
    }

    await adapter.closePages();
    const refreshed = validateRolloutSession(
      await adapter.discoverForCleanup(),
      "account_delete",
    );
    requireOriginalIdentity(refreshed, originalSession, "account_delete");
    latestOriginalSession = refreshed;

    phase = "account_delete";
    await retryAccountDelete(
      () => adapter.deleteOriginalAccount(refreshed),
      retryOptions,
    );
    accountDeleted = true;

    phase = "cleanup_verification";
    requireExpiredSession(await adapter.verifyRevokedSession());
  } catch (failure) {
    record(failure);
  }

  if (originalUserID !== undefined && !accountDeleted) {
    await adapter.closePages().catch(() => undefined);
    let deletionSession = latestOriginalSession;
    try {
      const discovered = validateRolloutSession(
        await adapter.discoverForCleanup(),
        "account_delete",
      );
      if (discovered.userID === originalUserID) {
        deletionSession = discovered;
      } else {
        record(
          new StagingCSRFRolloutFailure(
            "account_delete",
            "session_identity_changed",
          ),
        );
      }
    } catch (failure) {
      record(
        failure instanceof StagingCSRFRolloutFailure
          ? failure
          : new StagingCSRFRolloutFailure(
              "account_delete",
              "account_delete_failed",
            ),
      );
    }

    if (
      deletionSession !== undefined &&
      deletionSession.userID === originalUserID
    ) {
      try {
        await retryAccountDelete(
          () => adapter.deleteOriginalAccount(deletionSession),
          retryOptions,
        );
        accountDeleted = true;
      } catch {
        record(
          new StagingCSRFRolloutFailure(
            "account_delete",
            "account_delete_failed",
          ),
        );
      }
    }

    if (accountDeleted) {
      try {
        requireExpiredSession(await adapter.verifyRevokedSession());
      } catch {
        record(
          new StagingCSRFRolloutFailure(
            "cleanup_verification",
            "cleanup_unverified",
          ),
        );
      }
    }
  }

  try {
    await adapter.close();
  } catch {
    record(
      new StagingCSRFRolloutFailure(
        "cleanup_verification",
        "cleanup_unverified",
      ),
    );
  }
  return failures;
}

function extractUserID(value) {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.userID === "string" &&
    uuidV7Pattern.test(value.userID)
    ? value.userID
    : undefined;
}

function requireOriginalIdentity(candidate, original, phase) {
  if (candidate.userID !== original.userID) {
    throw new StagingCSRFRolloutFailure(phase, "session_identity_changed");
  }
}

function requireSuccess(result, phase) {
  if (result !== true) {
    throw new StagingCSRFRolloutFailure(phase, "unexpected_status");
  }
}

function requireCSRFRejection(result) {
  if (
    typeof result !== "object" ||
    result === null ||
    result.status !== 403 ||
    result.code !== "CSRF_INVALID" ||
    result.authenticatedUserIDVerified !== true
  ) {
    throw new StagingCSRFRolloutFailure(
      "security_rejections",
      "security_rejection_invalid",
    );
  }
}

function requireExpiredSession(result) {
  if (
    typeof result !== "object" ||
    result === null ||
    result.status !== 401 ||
    result.code !== "SESSION_EXPIRED" ||
    result.authenticatedUserIDAbsent !== true
  ) {
    throw new StagingCSRFRolloutFailure(
      "cleanup_verification",
      "cleanup_unverified",
    );
  }
}

async function retryAccountDelete(
  sendDelete,
  {
    retryDelaysMilliseconds = [1_000, 2_000, 4_000, 8_000, 16_000],
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (
    typeof sendDelete !== "function" ||
    typeof sleep !== "function" ||
    !Array.isArray(retryDelaysMilliseconds) ||
    retryDelaysMilliseconds.some(
      (delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 60_000,
    )
  ) {
    throw new Error("staging CSRF rollout cleanup configuration is invalid");
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
      return;
    }
  }
  throw new Error("staging CSRF rollout account cleanup failed");
}
