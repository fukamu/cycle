import { StagingCriticalFailure } from "./staging-critical.mjs";

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const csrfTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export const stagingCSRFRolloutFailureReasons = Object.freeze([
  "unexpected_status",
  "anonymous_session_request_not_observed",
  "anonymous_session_bad_request",
  "anonymous_session_forbidden",
  "anonymous_session_rate_limited",
  "anonymous_session_unavailable",
  "deploy_or_drain_failed",
  "session_identity_changed",
  "stable_token_invalid",
  "security_rejection_invalid",
  "account_delete_failed",
  "cleanup_unverified",
]);

export const stagingCSRFRolloutPhases = Object.freeze([
  "configuration",
  "browser_launch",
  "deploy_and_drain",
  "candidate_session",
  "candidate_unsafe_request",
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

export function validateRolloutSession(
  value,
  failurePhase = "candidate_session",
) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.userID !== "string" ||
    !uuidV7Pattern.test(value.userID) ||
    typeof value.csrfToken !== "string" ||
    !csrfTokenPattern.test(value.csrfToken)
  ) {
    throw new StagingCSRFRolloutFailure(failurePhase, "stable_token_invalid");
  }
  return { userID: value.userID, csrfToken: value.csrfToken };
}

export async function runStagingCSRFRollout({ adapter, retryOptions } = {}) {
  if (typeof adapter !== "object" || adapter === null) {
    throw new Error("staging CSRF rollout adapter is invalid");
  }

  const failures = [];
  let phase = "browser_launch";
  let candidateUserID;
  let candidateSession;
  let latestCandidateSession;
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

    phase = "deploy_and_drain";
    try {
      await adapter.runDeployAndDrain();
    } catch {
      throw new StagingCSRFRolloutFailure(phase, "deploy_or_drain_failed");
    }

    phase = "candidate_session";
    const preparedSession = await adapter.prepareCandidateSession();
    candidateUserID = extractUserID(preparedSession);
    await adapter.captureRevokedSessionProbe();
    candidateSession = validateRolloutSession(preparedSession, phase);
    latestCandidateSession = candidateSession;
    await adapter.prepareSecondTab();

    phase = "candidate_unsafe_request";
    requireSuccess(
      await adapter.runCandidateUnsafeRequest(candidateSession),
      phase,
    );

    phase = "two_tab_convergence";
    const discovered = await adapter.discoverTwoTabsConcurrently();
    if (!Array.isArray(discovered) || discovered.length !== 2) {
      throw new StagingCSRFRolloutFailure(phase, "stable_token_invalid");
    }
    const tabA = validateRolloutSession(discovered[0], phase);
    const tabB = validateRolloutSession(discovered[1], phase);
    requireSameIdentity(tabA, candidateSession, phase);
    requireSameIdentity(tabB, candidateSession, phase);
    if (tabA.csrfToken !== tabB.csrfToken) {
      throw new StagingCSRFRolloutFailure(phase, "stable_token_invalid");
    }
    latestCandidateSession = tabA;

    phase = "reload_stability";
    const reloaded = validateRolloutSession(
      await adapter.reloadTabAAndDiscover(),
      phase,
    );
    requireSameIdentity(reloaded, candidateSession, phase);
    if (reloaded.csrfToken !== tabA.csrfToken) {
      throw new StagingCSRFRolloutFailure(phase, "stable_token_invalid");
    }
    latestCandidateSession = reloaded;

    phase = "tab_a_autosave";
    requireSuccess(await adapter.runTabAAutosave(reloaded), phase);
    phase = "tab_a_command";
    requireSuccess(await adapter.runTabACommand(reloaded), phase);
    phase = "tab_b_command";
    requireSuccess(await adapter.runTabBCommand(tabB), phase);
    phase = "tab_b_autosave";
    requireSuccess(await adapter.runTabBAutosave(tabB), phase);

    phase = "security_rejections";
    for (const kind of ["invalid_token", "invalid_origin"]) {
      requireCSRFRejection(
        await adapter.verifyCSRFRejection(kind, {
          stableSession: reloaded,
        }),
      );
    }

    await adapter.closePages();
    const refreshed = validateRolloutSession(
      await adapter.discoverForCleanup(),
      "account_delete",
    );
    requireSameIdentity(refreshed, candidateSession, "account_delete");
    latestCandidateSession = refreshed;

    phase = "account_delete";
    await retryAccountDelete(
      () => adapter.deleteCandidateAccount(refreshed),
      retryOptions,
    );
    accountDeleted = true;

    phase = "cleanup_verification";
    requireExpiredSession(await adapter.verifyRevokedSession());
  } catch (failure) {
    record(failure);
  }

  if (candidateUserID !== undefined && !accountDeleted) {
    await adapter.closePages().catch(() => undefined);
    let deletionSession = latestCandidateSession;
    try {
      const discovered = validateRolloutSession(
        await adapter.discoverForCleanup(),
        "account_delete",
      );
      if (discovered.userID === candidateUserID) {
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
      deletionSession.userID === candidateUserID
    ) {
      try {
        await retryAccountDelete(
          () => adapter.deleteCandidateAccount(deletionSession),
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

function requireSameIdentity(candidate, expected, phase) {
  if (candidate.userID !== expected.userID) {
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
