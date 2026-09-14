const apiOrigin = "https://api.cloudflare.com";
const apiPrefix = "/client/v4/accounts";
const maximumResponseBytes = 64 * 1024;
const maximumPages = 4;
const pageSize = 50;
const maximumRollouts = pageSize * maximumPages;
const defaultPollIntervalMilliseconds = 10_000;
const defaultTimeoutMilliseconds = 20 * 60_000;
const maximumBaselineTimeoutMilliseconds = 5 * 60_000;
const requestRetryDelaysMilliseconds = Object.freeze([250, 1_000, 2_000]);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const commitSHAPattern = /^[0-9a-f]{40}$/;
const accountIDPattern = /^[0-9a-f]{32}$/;
const namePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const imagePattern =
  /^(?=.{1,512}$)[a-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9._/@:-]+@sha256:[0-9a-f]{64}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;
const cursorPattern = /^[A-Za-z0-9._~-]{1,512}$/;

export const cloudflareDrainPhases = Object.freeze([
  "configuration",
  "baseline",
  "deployment",
  "drain",
  "stability",
]);

export const cloudflareDrainReasons = Object.freeze([
  "invalid_configuration",
  "authorization_rejected",
  "provider_rejected",
  "invalid_evidence",
  "baseline_not_stable",
  "baseline_active_rollout",
  "baseline_instance_not_running",
  "baseline_instance_version_mismatch",
  "baseline_instance_image_reference_mismatch",
  "candidate_already_active",
  "deployment_failed",
  "rollout_failed",
  "evidence_changed",
  "worker_observation_changed",
  "application_observation_changed",
  "worker_identity_changed",
  "application_identity_changed",
  "instance_binding_changed",
  "rollout_history_changed",
  "unexpected_rollout",
  "application_state_changed",
  "rollout_identity_changed",
  "candidate_image_changed",
  "candidate_stability_changed",
  "application_rollout_visibility_lag",
  "rollout_inventory_visibility_lag",
  "evidence_timeout",
]);

export const cloudflareDrainSources = Object.freeze([
  "none",
  "provider_response",
  "worker_deployment",
  "worker_version",
  "application_inventory",
  "application",
  "rollout_inventory",
  "instance_inventory",
  "observation",
  "candidate_image",
]);

const phaseSet = new Set(cloudflareDrainPhases);
const reasonSet = new Set(cloudflareDrainReasons);
const sourceSet = new Set(cloudflareDrainSources);
const retryableTornObservationReasonSet = new Set([
  "worker_observation_changed",
  "application_observation_changed",
]);
const rolloutStatuses = new Set([
  "pending",
  "progressing",
  "completed",
  "reverted",
  "replaced",
]);
const instanceStatuses = new Set([
  "placed",
  "running",
  "failed",
  "stopped",
  "stopping",
  "unhealthy",
]);

export class CloudflareDrainFailure extends Error {
  constructor(phase, reason, source = "none") {
    if (
      !phaseSet.has(phase) ||
      !reasonSet.has(reason) ||
      !sourceSet.has(source) ||
      (reason === "invalid_evidence") !== (source !== "none")
    ) {
      throw new Error("cloudflare drain failure classification is invalid");
    }
    super("cloudflare drain evidence failed");
    this.name = "CloudflareDrainFailure";
    this.phase = phase;
    this.reason = reason;
    this.source = source;
  }
}

function fail(phase, reason, source = "none") {
  throw new CloudflareDrainFailure(phase, reason, source);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseTimestamp(value) {
  if (
    typeof value !== "string" ||
    value.length > 35 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("timestamp is invalid");
  }
  return value;
}

function parseIdentifier(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error("identifier is invalid");
  }
  return value;
}

function parseImage(value) {
  if (typeof value !== "string" || !imagePattern.test(value)) {
    throw new Error("container image is invalid");
  }
  return value;
}

function imageDigest(image) {
  return image.slice(image.lastIndexOf("@") + 1);
}

function parseCommitSHA(value) {
  if (typeof value !== "string" || !commitSHAPattern.test(value)) {
    throw new Error("commit SHA is invalid");
  }
  return value;
}

function parseNormalizedObservation(value) {
  if (!hasOnlyKeys(value, ["worker", "container"])) {
    throw new Error("observation is invalid");
  }
  const { worker, container } = value;
  if (
    !hasOnlyKeys(worker, [
      "deploymentId",
      "versionId",
      "trafficPercentage",
      "tag",
    ]) ||
    !parseIdentifier(worker.deploymentId) ||
    !parseIdentifier(worker.versionId) ||
    worker.trafficPercentage !== 100 ||
    !(
      worker.tag === null ||
      (typeof worker.tag === "string" && commitSHAPattern.test(worker.tag))
    )
  ) {
    throw new Error("worker observation is invalid");
  }
  if (
    !hasOnlyKeys(container, [
      "applicationId",
      "version",
      "image",
      "activeRolloutId",
      "rollouts",
      "instances",
    ]) ||
    !parseIdentifier(container.applicationId) ||
    !isNonNegativeInteger(container.version) ||
    !parseImage(container.image) ||
    !(
      container.activeRolloutId === null ||
      parseIdentifier(container.activeRolloutId)
    ) ||
    !Array.isArray(container.rollouts) ||
    container.rollouts.length > maximumRollouts ||
    !Array.isArray(container.instances) ||
    container.instances.length > pageSize * maximumPages
  ) {
    throw new Error("container observation is invalid");
  }

  const rolloutIDs = new Set();
  for (const rollout of container.rollouts) {
    if (
      !hasOnlyKeys(rollout, [
        "id",
        "createdAt",
        "status",
        "currentVersion",
        "targetVersion",
        "targetImage",
      ]) ||
      !parseIdentifier(rollout.id) ||
      rolloutIDs.has(rollout.id) ||
      !parseTimestamp(rollout.createdAt) ||
      !rolloutStatuses.has(rollout.status) ||
      !isNonNegativeInteger(rollout.currentVersion) ||
      !isNonNegativeInteger(rollout.targetVersion) ||
      !(rollout.targetImage === null || parseImage(rollout.targetImage))
    ) {
      throw new Error("container rollout is invalid");
    }
    rolloutIDs.add(rollout.id);
  }
  const instanceIDs = new Set();
  for (const instance of container.instances) {
    if (
      !hasOnlyKeys(instance, ["id", "status", "version", "image"]) ||
      !parseIdentifier(instance.id) ||
      instanceIDs.has(instance.id) ||
      !instanceStatuses.has(instance.status) ||
      !isNonNegativeInteger(instance.version) ||
      !(instance.image === null || parseImage(instance.image))
    ) {
      throw new Error("container instance is invalid");
    }
    instanceIDs.add(instance.id);
  }
  return structuredClone(value);
}

function parseRawObservation(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > maximumResponseBytes * 4) {
      throw new Error("observation is too large");
    }
    value = JSON.parse(raw);
  }
  return parseNormalizedObservation(value);
}

function baselinePendingReason(observation, candidateCommitSHA) {
  const { worker, container } = observation;
  if (worker.tag === candidateCommitSHA) {
    fail("baseline", "candidate_already_active");
  }
  if (container.activeRolloutId !== null) return "baseline_active_rollout";
  if (container.instances.some(({ status }) => status !== "running")) {
    return "baseline_instance_not_running";
  }
  if (
    container.instances.some(({ version }) => version !== container.version)
  ) {
    return "baseline_instance_version_mismatch";
  }
  if (
    container.instances.some(
      ({ image }) => image !== null && image !== container.image,
    )
  ) {
    return "baseline_instance_image_reference_mismatch";
  }
  return undefined;
}

function baselineProjection(observation) {
  const { worker, container } = observation;
  const rollouts = rolloutProjection(container.rollouts);
  return Object.freeze({
    workerDeploymentId: worker.deploymentId,
    workerVersionId: worker.versionId,
    workerTag: worker.tag,
    containerApplicationId: container.applicationId,
    containerVersion: container.version,
    containerImage: container.image,
    containerImageDigest: imageDigest(container.image),
    rollouts,
    rolloutIds: Object.freeze(rollouts.map(({ id }) => id)),
  });
}

function rolloutProjection(rollouts) {
  return Object.freeze(
    rollouts
      .map(
        ({
          id,
          createdAt,
          status,
          currentVersion,
          targetVersion,
          targetImage,
        }) =>
          Object.freeze({
            id,
            createdAt,
            status,
            currentVersion,
            targetVersion,
            targetImage,
          }),
      )
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  );
}

function candidateProjection(
  observation,
  baseline,
  candidateCommitSHA,
  candidateRolloutIdentity,
  expectedCandidateImageDigest,
) {
  const { worker, container } = observation;
  if (
    worker.tag !== candidateCommitSHA ||
    worker.deploymentId === baseline.workerDeploymentId ||
    worker.versionId === baseline.workerVersionId ||
    container.applicationId !== baseline.containerApplicationId
  ) {
    return undefined;
  }

  const instancesAreCandidateOnly = container.instances.every(
    (instance) =>
      instance.status === "running" &&
      instance.version === container.version &&
      (instance.image === null || instance.image === container.image),
  );
  if (expectedCandidateImageDigest === baseline.containerImageDigest) {
    if (
      candidateRolloutIdentity !== undefined ||
      container.activeRolloutId !== null ||
      container.version !== baseline.containerVersion ||
      container.image !== baseline.containerImage ||
      imageDigest(container.image) !== expectedCandidateImageDigest ||
      !sameProjection(
        rolloutProjection(container.rollouts),
        baseline.rollouts,
      ) ||
      container.instances.length !== 0
    ) {
      return undefined;
    }
    return Object.freeze({
      result: "drained",
      commitSHA: candidateCommitSHA,
      workerDeploymentId: worker.deploymentId,
      workerVersionId: worker.versionId,
      drainedWorkerVersionId: baseline.workerVersionId,
      containerApplicationId: container.applicationId,
      containerProof: "image_reused",
      containerRolloutId: null,
      containerVersion: container.version,
      containerImageDigest: imageDigest(container.image),
      drainedContainerVersion: baseline.containerVersion,
      drainedContainerImageDigest: baseline.containerImageDigest,
    });
  }

  const rollout = container.rollouts.find(
    ({ id }) => id === candidateRolloutIdentity?.id,
  );
  if (
    rollout === undefined ||
    rollout.status !== "completed" ||
    rollout.targetImage === null ||
    imageDigest(rollout.targetImage) !== expectedCandidateImageDigest ||
    container.activeRolloutId !== null ||
    container.version === baseline.containerVersion ||
    container.image === baseline.containerImage ||
    imageDigest(container.image) !== expectedCandidateImageDigest ||
    !instancesAreCandidateOnly
  ) {
    return undefined;
  }

  return Object.freeze({
    result: "drained",
    commitSHA: candidateCommitSHA,
    workerDeploymentId: worker.deploymentId,
    workerVersionId: worker.versionId,
    drainedWorkerVersionId: baseline.workerVersionId,
    containerApplicationId: container.applicationId,
    containerProof: "rolled_out",
    containerRolloutId: rollout.id,
    containerVersion: container.version,
    containerImageDigest: imageDigest(container.image),
    drainedContainerVersion: baseline.containerVersion,
    drainedContainerImageDigest: baseline.containerImageDigest,
  });
}

function rolloutIdentity(rollout) {
  return Object.freeze({
    id: rollout.id,
    currentVersion: rollout.currentVersion,
    targetVersion: rollout.targetVersion,
    targetImage: rollout.targetImage,
  });
}

function pinnedRolloutId(id) {
  return Object.freeze({ id });
}

function isFullRolloutIdentity(identity) {
  return (
    identity !== undefined &&
    Object.hasOwn(identity, "currentVersion") &&
    Object.hasOwn(identity, "targetVersion") &&
    Object.hasOwn(identity, "targetImage")
  );
}

function drainTransition(candidateRolloutIdentity, pendingReason = undefined) {
  return Object.freeze({ candidateRolloutIdentity, pendingReason });
}

function validateCandidateRolloutSafety(container, candidateRollout) {
  if (
    candidateRollout.status === "reverted" ||
    candidateRollout.status === "replaced"
  ) {
    fail("drain", "rollout_failed");
  }
  if (
    container.instances.some(
      (instance) =>
        instance.version === candidateRollout.targetVersion &&
        instance.image !== null &&
        instance.image !== candidateRollout.targetImage,
    )
  ) {
    fail("drain", "instance_binding_changed");
  }
  if (
    container.instances.some(
      (instance) =>
        instance.version === candidateRollout.targetVersion &&
        ["failed", "stopped", "stopping", "unhealthy"].includes(
          instance.status,
        ),
    )
  ) {
    fail("drain", "rollout_failed");
  }
}

function validateDrainTransition(
  observation,
  baseline,
  candidateCommitSHA,
  expectedCandidateRollout,
  expectedCandidateImageDigest,
) {
  const { worker, container } = observation;
  const workerIsBaseline =
    worker.tag === baseline.workerTag &&
    worker.deploymentId === baseline.workerDeploymentId &&
    worker.versionId === baseline.workerVersionId;
  const workerIsCandidate =
    worker.tag === candidateCommitSHA &&
    worker.deploymentId !== baseline.workerDeploymentId &&
    worker.versionId !== baseline.workerVersionId;
  if (!workerIsBaseline && !workerIsCandidate) {
    fail("drain", "worker_identity_changed");
  }
  if (container.applicationId !== baseline.containerApplicationId) {
    fail("drain", "application_identity_changed");
  }
  if (
    container.instances.some(
      (instance) =>
        (instance.version === baseline.containerVersion &&
          instance.image !== null &&
          instance.image !== baseline.containerImage) ||
        (instance.version === container.version &&
          instance.image !== null &&
          instance.image !== container.image),
    )
  ) {
    fail("drain", "instance_binding_changed");
  }

  const newRollouts = container.rollouts.filter(
    ({ id }) => !baseline.rolloutIds.includes(id),
  );
  const historicalRollouts = container.rollouts.filter(({ id }) =>
    baseline.rolloutIds.includes(id),
  );
  if (
    !sameProjection(rolloutProjection(historicalRollouts), baseline.rollouts)
  ) {
    fail("drain", "rollout_history_changed");
  }

  const applicationIsBaseline =
    container.version === baseline.containerVersion &&
    container.image === baseline.containerImage;
  const candidateUsesDifferentImage =
    expectedCandidateImageDigest !== undefined &&
    expectedCandidateImageDigest !== baseline.containerImageDigest;
  const applicationIsCandidate =
    candidateUsesDifferentImage &&
    container.version !== baseline.containerVersion &&
    container.image !== baseline.containerImage &&
    imageDigest(container.image) === expectedCandidateImageDigest;
  const expectedRolloutIsFullyBound = isFullRolloutIdentity(
    expectedCandidateRollout,
  );
  if (
    applicationIsCandidate &&
    container.instances.some(
      (instance) =>
        instance.version === container.version &&
        ["failed", "stopped", "stopping", "unhealthy"].includes(
          instance.status,
        ),
    )
  ) {
    fail("drain", "rollout_failed");
  }

  if (newRollouts.length === 0) {
    if (
      container.instances.some(
        (instance) =>
          instance.version !== baseline.containerVersion &&
          instance.version !== container.version,
      )
    ) {
      fail("drain", "instance_binding_changed");
    }
    if (expectedCandidateRollout !== undefined) {
      if (
        workerIsCandidate &&
        candidateUsesDifferentImage &&
        (applicationIsCandidate ||
          (!expectedRolloutIsFullyBound && applicationIsBaseline))
      ) {
        if (
          container.activeRolloutId === null ||
          container.activeRolloutId === expectedCandidateRollout.id
        ) {
          return drainTransition(
            expectedCandidateRollout,
            "rollout_inventory_visibility_lag",
          );
        }
        fail("drain", "rollout_identity_changed");
      }
      fail("drain", "rollout_identity_changed");
    }
    if (
      workerIsCandidate &&
      candidateUsesDifferentImage &&
      ((applicationIsBaseline && container.activeRolloutId !== null) ||
        applicationIsCandidate)
    ) {
      return drainTransition(
        container.activeRolloutId === null
          ? undefined
          : pinnedRolloutId(container.activeRolloutId),
        "rollout_inventory_visibility_lag",
      );
    }
    if (
      container.activeRolloutId !== null ||
      container.version !== baseline.containerVersion ||
      container.image !== baseline.containerImage
    ) {
      fail("drain", "application_state_changed");
    }
    return drainTransition(undefined);
  }
  if (expectedCandidateImageDigest === baseline.containerImageDigest) {
    fail("drain", "unexpected_rollout");
  }
  if (newRollouts.length !== 1) {
    fail("drain", "unexpected_rollout");
  }

  const candidateRollouts = newRollouts.filter(
    (rollout) =>
      rollout.targetImage !== null &&
      rollout.currentVersion === baseline.containerVersion &&
      rollout.targetVersion !== baseline.containerVersion &&
      imageDigest(rollout.targetImage) === expectedCandidateImageDigest,
  );
  for (const candidateRollout of candidateRollouts) {
    validateCandidateRolloutSafety(container, candidateRollout);
  }
  const expectedVisibleRollout =
    expectedCandidateRollout === undefined
      ? undefined
      : newRollouts.find(({ id }) => id === expectedCandidateRollout.id);
  if (
    expectedCandidateRollout !== undefined &&
    (expectedVisibleRollout === undefined ||
      (expectedRolloutIsFullyBound &&
        (expectedVisibleRollout.currentVersion !==
          expectedCandidateRollout.currentVersion ||
          expectedVisibleRollout.targetVersion !==
            expectedCandidateRollout.targetVersion ||
          expectedVisibleRollout.targetImage !==
            expectedCandidateRollout.targetImage)) ||
      (!expectedRolloutIsFullyBound &&
        !candidateRollouts.some(
          ({ id }) => id === expectedCandidateRollout.id,
        )))
  ) {
    fail("drain", "rollout_identity_changed");
  }

  const activeRollout =
    container.activeRolloutId === null
      ? undefined
      : newRollouts.find(({ id }) => id === container.activeRolloutId);
  if (container.activeRolloutId !== null && activeRollout === undefined) {
    fail("drain", "rollout_identity_changed");
  }

  const possibleLaggingApplicationRollout =
    applicationIsBaseline && workerIsCandidate
      ? (expectedVisibleRollout ??
        (newRollouts.length === 1 && candidateRollouts.length === 1
          ? candidateRollouts[0]
          : undefined))
      : undefined;
  const laggingApplicationRollout =
    possibleLaggingApplicationRollout !== undefined &&
    newRollouts.length === 1 &&
    (activeRollout === undefined ||
      activeRollout.id === possibleLaggingApplicationRollout.id)
      ? possibleLaggingApplicationRollout
      : undefined;
  if (
    container.instances.some(
      (instance) =>
        instance.version !== baseline.containerVersion &&
        instance.version !== container.version &&
        (laggingApplicationRollout === undefined ||
          instance.version !== laggingApplicationRollout.targetVersion),
    )
  ) {
    fail("drain", "instance_binding_changed");
  }

  if (applicationIsBaseline && workerIsCandidate) {
    if (laggingApplicationRollout !== undefined) {
      validateCandidateRolloutSafety(container, laggingApplicationRollout);
      return drainTransition(
        rolloutIdentity(laggingApplicationRollout),
        "application_rollout_visibility_lag",
      );
    }
    fail("drain", "unexpected_rollout");
  }
  if (!applicationIsBaseline && !applicationIsCandidate) {
    if (
      candidateUsesDifferentImage &&
      container.image !== baseline.containerImage &&
      imageDigest(container.image) !== expectedCandidateImageDigest
    ) {
      fail("drain", "candidate_image_changed");
    }
    fail("drain", "application_state_changed");
  }

  const applicationMatches = newRollouts.filter(
    (rollout) =>
      rollout.currentVersion === baseline.containerVersion &&
      rollout.targetVersion === container.version &&
      rollout.targetImage === container.image,
  );
  if (applicationIsCandidate && applicationMatches.length !== 1) {
    fail("drain", "application_state_changed");
  }

  let candidateRollout;
  if (expectedCandidateRollout !== undefined) {
    candidateRollout = expectedVisibleRollout;
    if (!workerIsCandidate) {
      fail("drain", "worker_identity_changed");
    }
  } else if (workerIsCandidate) {
    candidateRollout = activeRollout ?? applicationMatches[0];
  } else if (activeRollout !== undefined) {
    fail("drain", "unexpected_rollout");
  }

  if (
    candidateRollout !== undefined &&
    (candidateRollout.targetImage === null ||
      candidateRollout.targetImage === baseline.containerImage ||
      imageDigest(candidateRollout.targetImage) !==
        expectedCandidateImageDigest)
  ) {
    fail("drain", "candidate_image_changed");
  }
  if (
    candidateRollout !== undefined &&
    (candidateRollout.currentVersion !== baseline.containerVersion ||
      candidateRollout.targetVersion === baseline.containerVersion)
  ) {
    fail("drain", "rollout_identity_changed");
  }
  if (
    activeRollout !== undefined &&
    (candidateRollout === undefined || activeRollout.id !== candidateRollout.id)
  ) {
    fail("drain", "rollout_identity_changed");
  }
  if (
    applicationMatches.length === 1 &&
    (candidateRollout === undefined ||
      applicationMatches[0].id !== candidateRollout.id)
  ) {
    fail("drain", "rollout_identity_changed");
  }
  if (candidateRollout !== undefined) {
    validateCandidateRolloutSafety(container, candidateRollout);
  }
  if (
    (container.version === baseline.containerVersion &&
      container.image !== baseline.containerImage) ||
    (activeRollout !== undefined &&
      (activeRollout.currentVersion !== baseline.containerVersion ||
        activeRollout.targetImage === baseline.containerImage))
  ) {
    fail(
      "drain",
      container.version === baseline.containerVersion &&
        container.image !== baseline.containerImage
        ? "application_state_changed"
        : "rollout_identity_changed",
    );
  }
  return drainTransition(
    candidateRollout === undefined
      ? undefined
      : rolloutIdentity(candidateRollout),
  );
}

function sameProjection(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readClock(now, previous) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value < previous) {
    fail("configuration", "invalid_configuration");
  }
  return value;
}

export async function proveCloudflareDrain({
  candidateCommitSHA,
  rawAdapter,
  resolveCandidateImageDigest,
  now = () => Date.now(),
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  wake,
  pollIntervalMilliseconds = defaultPollIntervalMilliseconds,
  timeoutMilliseconds = defaultTimeoutMilliseconds,
}) {
  try {
    parseCommitSHA(candidateCommitSHA);
  } catch {
    fail("configuration", "invalid_configuration");
  }
  if (
    !isRecord(rawAdapter) ||
    typeof rawAdapter.readObservation !== "function" ||
    typeof resolveCandidateImageDigest !== "function" ||
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    typeof wake !== "function" ||
    !isPositiveInteger(pollIntervalMilliseconds) ||
    pollIntervalMilliseconds > 60_000 ||
    !isPositiveInteger(timeoutMilliseconds) ||
    timeoutMilliseconds > 30 * 60_000 ||
    pollIntervalMilliseconds >= timeoutMilliseconds
  ) {
    fail("configuration", "invalid_configuration");
  }

  let currentTime = readClock(now, 0);
  const baselineDeadline =
    currentTime +
    Math.min(timeoutMilliseconds, maximumBaselineTimeoutMilliseconds);
  let firstStableBaseline;
  let previousBaselineWasStable = false;
  let baseline;
  let lastBaselineReason;
  let baselineAttempt = 0;
  while (baselineAttempt < 256) {
    currentTime = readClock(now, currentTime);
    if (currentTime >= baselineDeadline) {
      fail("baseline", lastBaselineReason ?? "evidence_timeout");
    }
    let baselineObservation;
    try {
      baselineObservation = parseRawObservation(
        await rawAdapter.readObservation({
          phase: "baseline",
          attempt: baselineAttempt,
          timeoutMilliseconds: baselineDeadline - currentTime,
        }),
      );
    } catch (error) {
      if (error instanceof CloudflareDrainFailure) throw error;
      fail("baseline", "invalid_evidence", "observation");
    }
    currentTime = readClock(now, currentTime);
    if (currentTime >= baselineDeadline) {
      fail("baseline", lastBaselineReason ?? "evidence_timeout");
    }

    const pendingReason = baselinePendingReason(
      baselineObservation,
      candidateCommitSHA,
    );
    if (pendingReason !== undefined) {
      previousBaselineWasStable = false;
      lastBaselineReason = pendingReason;
    } else {
      const currentBaseline = baselineProjection(baselineObservation);
      if (firstStableBaseline === undefined) {
        firstStableBaseline = currentBaseline;
      } else if (!sameProjection(firstStableBaseline, currentBaseline)) {
        fail("baseline", "evidence_changed");
      } else if (previousBaselineWasStable) {
        baseline = currentBaseline;
        break;
      }
      previousBaselineWasStable = true;
    }

    baselineAttempt += 1;
    try {
      await sleep(pollIntervalMilliseconds);
    } catch {
      fail("baseline", "provider_rejected");
    }
  }
  if (baseline === undefined) {
    fail("baseline", lastBaselineReason ?? "evidence_timeout");
  }

  try {
    await wake(baseline);
  } catch {
    fail("deployment", "deployment_failed");
  }

  currentTime = readClock(now, currentTime);
  const deadline = currentTime + timeoutMilliseconds;
  let candidateImageDigest;
  let candidateWorkerIdentity;
  let candidateRolloutIdentity;
  let firstStable;
  let lastTransientDrainReason;
  let attempt = 0;
  while (attempt < 256) {
    currentTime = readClock(now, currentTime);
    if (currentTime >= deadline) {
      fail(
        firstStable ? "stability" : "drain",
        lastTransientDrainReason ?? "evidence_timeout",
      );
    }
    let observation;
    let transientDrainReason;
    try {
      observation = parseRawObservation(
        await rawAdapter.readObservation({
          phase: "drain",
          attempt,
          timeoutMilliseconds: deadline - currentTime,
        }),
      );
    } catch (error) {
      if (
        error instanceof CloudflareDrainFailure &&
        error.phase === "drain" &&
        retryableTornObservationReasonSet.has(error.reason)
      ) {
        transientDrainReason = error.reason;
        lastTransientDrainReason = error.reason;
        firstStable = undefined;
      } else if (error instanceof CloudflareDrainFailure) {
        throw error;
      } else {
        fail("drain", "invalid_evidence", "observation");
      }
    }
    currentTime = readClock(now, currentTime);
    if (currentTime >= deadline) {
      fail(
        firstStable ? "stability" : "drain",
        transientDrainReason ?? "evidence_timeout",
      );
    }
    if (transientDrainReason !== undefined) {
      attempt += 1;
      try {
        await sleep(pollIntervalMilliseconds);
      } catch {
        fail("drain", "provider_rejected");
      }
      continue;
    }
    lastTransientDrainReason = undefined;

    if (
      candidateWorkerIdentity !== undefined &&
      (observation.worker.tag !== candidateCommitSHA ||
        observation.worker.deploymentId !==
          candidateWorkerIdentity.deploymentId ||
        observation.worker.versionId !== candidateWorkerIdentity.versionId)
    ) {
      fail("drain", "worker_identity_changed");
    }
    if (
      candidateWorkerIdentity === undefined &&
      observation.worker.tag === candidateCommitSHA
    ) {
      try {
        candidateImageDigest = await resolveCandidateImageDigest({
          workerVersionId: observation.worker.versionId,
          baselineContainerImageDigest: baseline.containerImageDigest,
        });
        if (
          typeof candidateImageDigest !== "string" ||
          !imageDigestPattern.test(candidateImageDigest)
        ) {
          throw new Error("candidate image digest is invalid");
        }
      } catch {
        fail("drain", "invalid_evidence", "candidate_image");
      }
      candidateWorkerIdentity = Object.freeze({
        deploymentId: observation.worker.deploymentId,
        versionId: observation.worker.versionId,
      });
      currentTime = readClock(now, currentTime);
      if (currentTime >= deadline) {
        fail(firstStable ? "stability" : "drain", "evidence_timeout");
      }
    }

    const transition = validateDrainTransition(
      observation,
      baseline,
      candidateCommitSHA,
      candidateRolloutIdentity,
      candidateImageDigest,
    );
    candidateRolloutIdentity = transition.candidateRolloutIdentity;
    if (transition.pendingReason !== undefined) {
      lastTransientDrainReason = transition.pendingReason;
      firstStable = undefined;
      attempt += 1;
      try {
        await sleep(pollIntervalMilliseconds);
      } catch {
        fail("drain", "provider_rejected");
      }
      continue;
    }

    const candidate = candidateProjection(
      observation,
      baseline,
      candidateCommitSHA,
      candidateRolloutIdentity,
      candidateImageDigest,
    );
    if (candidate !== undefined) {
      if (firstStable === undefined) {
        firstStable = candidate;
      } else if (!sameProjection(firstStable, candidate)) {
        fail("stability", "candidate_stability_changed");
      } else {
        const observedAt = new Date(currentTime).toISOString();
        return Object.freeze({ ...candidate, observedAt });
      }
    } else if (firstStable !== undefined) {
      fail("stability", "candidate_stability_changed");
    }

    attempt += 1;
    try {
      await sleep(pollIntervalMilliseconds);
    } catch {
      fail("drain", "provider_rejected");
    }
  }
  fail("drain", lastTransientDrainReason ?? "evidence_timeout");
}

function normalizeWorkerDeployment(envelope) {
  if (
    !hasOnlyKeys(
      envelope,
      ["success", "result"],
      ["errors", "messages", "result_info"],
    ) ||
    envelope.success !== true ||
    !isRecord(envelope.result) ||
    !Array.isArray(envelope.result.deployments) ||
    envelope.result.deployments.length === 0 ||
    envelope.result.deployments.length > 100
  ) {
    throw new Error("worker deployment response is invalid");
  }
  const deployment = envelope.result.deployments[0];
  if (
    !isRecord(deployment) ||
    !parseIdentifier(deployment.id) ||
    deployment.strategy !== "percentage" ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1 ||
    !isRecord(deployment.versions[0]) ||
    deployment.versions[0].percentage !== 100 ||
    !parseIdentifier(deployment.versions[0].version_id)
  ) {
    throw new Error("active worker deployment is invalid");
  }
  return {
    deploymentId: deployment.id,
    versionId: deployment.versions[0].version_id,
  };
}

function normalizeWorkerVersion(envelope, expectedVersionID) {
  if (
    !hasOnlyKeys(envelope, ["success", "result"], ["errors", "messages"]) ||
    envelope.success !== true ||
    !isRecord(envelope.result) ||
    envelope.result.id !== expectedVersionID
  ) {
    throw new Error("worker version response is invalid");
  }
  const annotations = envelope.result.annotations;
  if (annotations === undefined) {
    return null;
  }
  if (!isRecord(annotations)) {
    throw new Error("worker version response is invalid");
  }
  if (!Object.hasOwn(annotations, "workers/tag")) {
    return null;
  }
  const tag = annotations["workers/tag"];
  if (typeof tag !== "string" || !commitSHAPattern.test(tag)) {
    throw new Error("worker version response is invalid");
  }
  return tag;
}

function parseV4Envelope(value) {
  if (
    !hasOnlyKeys(
      value,
      ["success", "result"],
      ["errors", "messages", "result_info"],
    ) ||
    value.success !== true
  ) {
    throw new Error("container response is invalid");
  }
  return value;
}

function normalizeApplication(value, expectedName) {
  if (
    !isRecord(value) ||
    value.name !== expectedName ||
    !parseIdentifier(value.id) ||
    !isNonNegativeInteger(value.version) ||
    !(
      value.instances === undefined ||
      (Number.isSafeInteger(value.instances) && value.instances >= 0)
    ) ||
    value.max_instances !== 1 ||
    !isRecord(value.configuration) ||
    !parseImage(value.configuration.image) ||
    !(
      value.active_rollout_id === undefined ||
      parseIdentifier(value.active_rollout_id)
    )
  ) {
    throw new Error("container application is invalid");
  }
  return value;
}

function normalizeRollout(value) {
  const targetImage = value?.target_configuration?.image;
  if (
    !isRecord(value) ||
    !parseIdentifier(value.id) ||
    !parseTimestamp(value.created_at) ||
    !rolloutStatuses.has(value.status) ||
    !isNonNegativeInteger(value.current_version) ||
    !isNonNegativeInteger(value.target_version) ||
    !isRecord(value.target_configuration) ||
    !(targetImage === undefined || parseImage(targetImage))
  ) {
    throw new Error("container rollout response is invalid");
  }
  return {
    id: value.id,
    createdAt: value.created_at,
    status: value.status,
    currentVersion: value.current_version,
    targetVersion: value.target_version,
    targetImage: targetImage ?? null,
  };
}

function normalizeInstance(value) {
  const placementStatus = value?.current_placement?.status;
  const status = placementStatus?.container_status ?? placementStatus?.health;
  const image = value?.image;
  if (
    !isRecord(value) ||
    !parseIdentifier(value.id) ||
    !instanceStatuses.has(status) ||
    !isNonNegativeInteger(value.app_version) ||
    !(image === undefined || parseImage(image))
  ) {
    throw new Error("container instance response is invalid");
  }
  return {
    id: value.id,
    status,
    version: value.app_version,
    image: image ?? null,
  };
}

async function readBoundedJSON(response, phase) {
  if (!isRecord(response) && !(response instanceof Response)) {
    fail(phase, "provider_rejected");
  }
  if (response.status === 401 || response.status === 403) {
    fail(phase, "authorization_rejected");
  }
  if (response.status !== 200) {
    fail(phase, "provider_rejected");
  }
  const declaredLengthValue = response.headers?.get?.("content-length");
  if (declaredLengthValue !== null && declaredLengthValue !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLengthValue)) {
      fail(phase, "invalid_evidence", "provider_response");
    }
    const declaredLength = Number(declaredLengthValue);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maximumResponseBytes
    ) {
      fail(phase, "invalid_evidence", "provider_response");
    }
  }

  let body = "";
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximumResponseBytes) {
          await reader.cancel();
          fail(phase, "invalid_evidence", "provider_response");
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) {
      if (error instanceof CloudflareDrainFailure) throw error;
      fail(phase, "provider_rejected");
    }
  } else {
    try {
      body = await response.text();
    } catch {
      fail(phase, "provider_rejected");
    }
    if (Buffer.byteLength(body, "utf8") > maximumResponseBytes) {
      fail(phase, "invalid_evidence", "provider_response");
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    fail(phase, "invalid_evidence", "provider_response");
  }
}

function nextPageToken(envelope, expectedToken) {
  const info = envelope.result_info;
  if (info === undefined) return null;
  if (
    !hasOnlyKeys(info, [], ["page_token", "per_page", "next_page_token"]) ||
    (expectedToken !== null && info.page_token !== expectedToken) ||
    (info.per_page !== undefined && info.per_page !== pageSize) ||
    !(
      info.next_page_token === undefined ||
      info.next_page_token === null ||
      (typeof info.next_page_token === "string" &&
        cursorPattern.test(info.next_page_token))
    )
  ) {
    throw new Error("pagination response is invalid");
  }
  return info.next_page_token ?? null;
}

async function fetchJSON(
  fetchImpl,
  requestSleep,
  requestNow,
  deadlineMilliseconds,
  token,
  url,
  phase,
) {
  for (
    let attempt = 0;
    attempt <= requestRetryDelaysMilliseconds.length;
    attempt += 1
  ) {
    const remainingMilliseconds = deadlineMilliseconds - requestNow();
    if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0) {
      fail(phase, "evidence_timeout");
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(30_000, Math.ceil(remainingMilliseconds))),
        ),
      });
    } catch {
      response = undefined;
    }
    if (requestNow() >= deadlineMilliseconds) {
      fail(phase, "evidence_timeout");
    }
    const retryable =
      response === undefined ||
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599);
    if (!retryable) {
      const value = await readBoundedJSON(response, phase);
      if (requestNow() >= deadlineMilliseconds) {
        fail(phase, "evidence_timeout");
      }
      return value;
    }
    await response?.body?.cancel?.().catch(() => undefined);
    if (attempt === requestRetryDelaysMilliseconds.length) {
      fail(phase, "provider_rejected");
    }
    if (
      requestNow() + requestRetryDelaysMilliseconds[attempt] >=
      deadlineMilliseconds
    ) {
      fail(phase, "evidence_timeout");
    }
    try {
      await requestSleep(requestRetryDelaysMilliseconds[attempt]);
    } catch {
      fail(phase, "provider_rejected");
    }
  }
  fail(phase, "provider_rejected");
}

function endpoint(accountId, path, query = undefined) {
  const url = new URL(`${apiPrefix}/${accountId}/${path}`, apiOrigin);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

export function createCloudflareRawAdapter({
  accountId,
  apiToken,
  workerName,
  containerApplicationName,
  fetchImpl = fetch,
  requestSleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  requestNow = () => Date.now(),
}) {
  if (
    typeof accountId !== "string" ||
    !accountIDPattern.test(accountId) ||
    typeof apiToken !== "string" ||
    apiToken.length < 1 ||
    apiToken.length > 2048 ||
    /[\x00-\x20\x7f]/.test(apiToken) ||
    typeof workerName !== "string" ||
    !namePattern.test(workerName) ||
    typeof containerApplicationName !== "string" ||
    !namePattern.test(containerApplicationName) ||
    typeof fetchImpl !== "function" ||
    typeof requestSleep !== "function" ||
    typeof requestNow !== "function"
  ) {
    fail("configuration", "invalid_configuration");
  }

  const readPaginated = async (
    path,
    phase,
    deadlineMilliseconds,
    invalidEvidenceSource,
    selectItems = (result) => result,
  ) => {
    const items = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < maximumPages; page += 1) {
      const raw = await fetchJSON(
        fetchImpl,
        requestSleep,
        requestNow,
        deadlineMilliseconds,
        apiToken,
        endpoint(accountId, path, {
          per_page: pageSize,
          page_token: cursor,
        }),
        phase,
      );
      let envelope;
      try {
        envelope = parseV4Envelope(raw);
        const pageItems = selectItems(envelope.result);
        if (!Array.isArray(pageItems) || pageItems.length > pageSize) {
          throw new Error("paginated result is invalid");
        }
        items.push(...pageItems);
        const next = nextPageToken(envelope, cursor);
        if (next === null) return items;
        if (seen.has(next)) throw new Error("pagination cycle");
        seen.add(next);
        cursor = next;
      } catch {
        fail(phase, "invalid_evidence", invalidEvidenceSource);
      }
    }
    fail(phase, "invalid_evidence", invalidEvidenceSource);
  };

  return Object.freeze({
    async readObservation({
      phase,
      timeoutMilliseconds = defaultTimeoutMilliseconds,
    }) {
      if (phase !== "baseline" && phase !== "drain") {
        fail("configuration", "invalid_configuration");
      }
      if (
        !isPositiveInteger(timeoutMilliseconds) ||
        timeoutMilliseconds > 30 * 60_000
      ) {
        fail("configuration", "invalid_configuration");
      }
      const startedAt = requestNow();
      if (!Number.isFinite(startedAt) || startedAt < 0) {
        fail("configuration", "invalid_configuration");
      }
      const deadlineMilliseconds = startedAt + timeoutMilliseconds;
      const workerEnvelope = await fetchJSON(
        fetchImpl,
        requestSleep,
        requestNow,
        deadlineMilliseconds,
        apiToken,
        endpoint(
          accountId,
          `workers/scripts/${encodeURIComponent(workerName)}/deployments`,
        ),
        phase,
      );
      let worker;
      try {
        worker = normalizeWorkerDeployment(workerEnvelope);
      } catch {
        fail(phase, "invalid_evidence", "worker_deployment");
      }
      const versionEnvelope = await fetchJSON(
        fetchImpl,
        requestSleep,
        requestNow,
        deadlineMilliseconds,
        apiToken,
        endpoint(
          accountId,
          `workers/scripts/${encodeURIComponent(workerName)}/versions/${worker.versionId}`,
        ),
        phase,
      );
      let workerTag;
      try {
        workerTag = normalizeWorkerVersion(versionEnvelope, worker.versionId);
      } catch {
        fail(phase, "invalid_evidence", "worker_version");
      }

      const applications = await readPaginated(
        "containers/dash/applications",
        phase,
        deadlineMilliseconds,
        "application_inventory",
      );
      const matches = applications.filter(
        (application) => application?.name === containerApplicationName,
      );
      if (matches.length !== 1) {
        fail(phase, "invalid_evidence", "application_inventory");
      }
      let applicationID;
      try {
        applicationID = parseIdentifier(matches[0].id);
      } catch {
        fail(phase, "invalid_evidence", "application_inventory");
      }

      const [applicationEnvelope, rolloutEnvelope] = await Promise.all([
        fetchJSON(
          fetchImpl,
          requestSleep,
          requestNow,
          deadlineMilliseconds,
          apiToken,
          endpoint(accountId, `containers/applications/${applicationID}`),
          phase,
        ),
        (async () => {
          const values = [];
          const rolloutIDs = new Set();
          let last = null;
          for (let page = 0; page < maximumPages; page += 1) {
            const raw = await fetchJSON(
              fetchImpl,
              requestSleep,
              requestNow,
              deadlineMilliseconds,
              apiToken,
              endpoint(
                accountId,
                `containers/applications/${applicationID}/rollouts`,
                { limit: pageSize, last },
              ),
              phase,
            );
            let pageValues;
            try {
              pageValues = parseV4Envelope(raw).result;
              if (!Array.isArray(pageValues) || pageValues.length > pageSize) {
                throw new Error("rollout page is invalid");
              }
              for (const value of pageValues) {
                const normalized = normalizeRollout(value);
                if (rolloutIDs.has(normalized.id)) {
                  throw new Error("rollout pagination repeated an item");
                }
                rolloutIDs.add(normalized.id);
                values.push(normalized);
              }
              if (pageValues.length < pageSize) return values;
              const nextLast = values.at(-1)?.id;
              if (nextLast === undefined || nextLast === last) {
                throw new Error("rollout pagination did not advance");
              }
              last = nextLast;
            } catch {
              fail(phase, "invalid_evidence", "rollout_inventory");
            }
          }
          fail(phase, "invalid_evidence", "rollout_inventory");
        })(),
      ]);
      const instanceValues = await readPaginated(
        `containers/dash/applications/${applicationID}/instances`,
        phase,
        deadlineMilliseconds,
        "instance_inventory",
        (result) => {
          if (!isRecord(result) || !Array.isArray(result.instances)) {
            throw new Error("instance page is invalid");
          }
          return result.instances;
        },
      );
      const [
        finalWorkerEnvelope,
        finalWorkerVersionEnvelope,
        finalApplicationEnvelope,
      ] = await Promise.all([
        fetchJSON(
          fetchImpl,
          requestSleep,
          requestNow,
          deadlineMilliseconds,
          apiToken,
          endpoint(
            accountId,
            `workers/scripts/${encodeURIComponent(workerName)}/deployments`,
          ),
          phase,
        ),
        fetchJSON(
          fetchImpl,
          requestSleep,
          requestNow,
          deadlineMilliseconds,
          apiToken,
          endpoint(
            accountId,
            `workers/scripts/${encodeURIComponent(workerName)}/versions/${worker.versionId}`,
          ),
          phase,
        ),
        fetchJSON(
          fetchImpl,
          requestSleep,
          requestNow,
          deadlineMilliseconds,
          apiToken,
          endpoint(accountId, `containers/applications/${applicationID}`),
          phase,
        ),
      ]);
      let application;
      try {
        application = normalizeApplication(
          parseV4Envelope(applicationEnvelope).result,
          containerApplicationName,
        );
      } catch {
        fail(phase, "invalid_evidence", "application");
      }
      let finalWorker;
      try {
        finalWorker = normalizeWorkerDeployment(finalWorkerEnvelope);
      } catch {
        fail(phase, "invalid_evidence", "worker_deployment");
      }
      let finalWorkerTag;
      try {
        finalWorkerTag = normalizeWorkerVersion(
          finalWorkerVersionEnvelope,
          worker.versionId,
        );
      } catch {
        fail(phase, "invalid_evidence", "worker_version");
      }
      let finalApplication;
      try {
        finalApplication = normalizeApplication(
          parseV4Envelope(finalApplicationEnvelope).result,
          containerApplicationName,
        );
      } catch {
        fail(phase, "invalid_evidence", "application");
      }
      let instances;
      try {
        instances = instanceValues.map(normalizeInstance);
      } catch {
        fail(phase, "invalid_evidence", "instance_inventory");
      }
      if (
        finalWorker.deploymentId !== worker.deploymentId ||
        finalWorker.versionId !== worker.versionId ||
        finalWorkerTag !== workerTag
      ) {
        fail(phase, "worker_observation_changed");
      }
      if (
        finalApplication.id !== application.id ||
        finalApplication.version !== application.version ||
        finalApplication.configuration.image !==
          application.configuration.image ||
        (finalApplication.active_rollout_id ?? null) !==
          (application.active_rollout_id ?? null)
      ) {
        fail(phase, "application_observation_changed");
      }
      return {
        worker: {
          ...worker,
          trafficPercentage: 100,
          tag: workerTag,
        },
        container: {
          applicationId: application.id,
          version: application.version,
          image: application.configuration.image,
          activeRolloutId: application.active_rollout_id ?? null,
          rollouts: rolloutEnvelope,
          instances,
        },
      };
    },
  });
}

export function formatCloudflareDrainDiagnostic(failure, metadata) {
  if (
    !(failure instanceof CloudflareDrainFailure) ||
    !isRecord(metadata) ||
    !/^(?:local|[1-9][0-9]*)$/.test(metadata.runID) ||
    !/^(?:local|[1-9][0-9]*)$/.test(metadata.runAttempt) ||
    !/^(?:local|[0-9a-f]{40})$/.test(metadata.commitSHA)
  ) {
    throw new Error("cloudflare drain diagnostic metadata is invalid");
  }
  return `::error::Cloudflare drain evidence failed; phase=${failure.phase}; reason=${failure.reason}; source=${failure.source}; run_id=${metadata.runID}; run_attempt=${metadata.runAttempt}; commit_sha=${metadata.commitSHA}.`;
}

export function parseCloudflareDrainDiagnosticLine(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512) {
    return undefined;
  }
  const match = value.match(
    /^::error::Cloudflare drain evidence failed; phase=([a-z_]+); reason=([a-z_]+); source=([a-z_]+); run_id=(local|[1-9][0-9]*); run_attempt=(local|[1-9][0-9]*); commit_sha=(local|[0-9a-f]{40})\.$/,
  );
  if (
    match === null ||
    !phaseSet.has(match[1]) ||
    !reasonSet.has(match[2]) ||
    !sourceSet.has(match[3]) ||
    (match[2] === "invalid_evidence") !== (match[3] !== "none")
  ) {
    return undefined;
  }
  return value;
}

export function serializeCloudflareDrainEvidence(evidence) {
  if (
    !hasOnlyKeys(evidence, [
      "result",
      "commitSHA",
      "workerDeploymentId",
      "workerVersionId",
      "drainedWorkerVersionId",
      "containerApplicationId",
      "containerProof",
      "containerRolloutId",
      "containerVersion",
      "containerImageDigest",
      "drainedContainerVersion",
      "drainedContainerImageDigest",
      "observedAt",
    ]) ||
    evidence.result !== "drained" ||
    typeof evidence.commitSHA !== "string" ||
    !commitSHAPattern.test(evidence.commitSHA) ||
    !parseIdentifier(evidence.workerDeploymentId) ||
    !parseIdentifier(evidence.workerVersionId) ||
    !parseIdentifier(evidence.drainedWorkerVersionId) ||
    !parseIdentifier(evidence.containerApplicationId) ||
    !/^(?:rolled_out|image_reused)$/.test(evidence.containerProof) ||
    !(
      evidence.containerRolloutId === null ||
      parseIdentifier(evidence.containerRolloutId)
    ) ||
    !isNonNegativeInteger(evidence.containerVersion) ||
    !imageDigestPattern.test(evidence.containerImageDigest) ||
    !isNonNegativeInteger(evidence.drainedContainerVersion) ||
    !imageDigestPattern.test(evidence.drainedContainerImageDigest) ||
    !parseTimestamp(evidence.observedAt)
  ) {
    throw new Error("cloudflare drain success evidence is invalid");
  }
  const reusesImage = evidence.containerProof === "image_reused";
  if (
    (reusesImage &&
      (evidence.containerRolloutId !== null ||
        evidence.containerVersion !== evidence.drainedContainerVersion ||
        evidence.containerImageDigest !==
          evidence.drainedContainerImageDigest)) ||
    (!reusesImage &&
      (evidence.containerRolloutId === null ||
        evidence.containerVersion === evidence.drainedContainerVersion ||
        evidence.containerImageDigest === evidence.drainedContainerImageDigest))
  ) {
    throw new Error("cloudflare drain success evidence is invalid");
  }
  return `${JSON.stringify(evidence)}\n`;
}
