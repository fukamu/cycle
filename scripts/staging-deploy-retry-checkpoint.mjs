#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const maximumCheckpointBytes = 16 * 1024;
const commitSHAPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const workflowName = "Deploy Staging";
const workflowPath = ".github/workflows/deploy.yml";
const stateKind = "staging_deploy_retry_state";
const evidenceKind = "staging_deploy_retry_checkpoint";
const stateKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "repository",
  "workflowName",
  "workflowPath",
  "commitSHA",
  "operator",
  "deployRunID",
  "deployRunAttempt",
  "deployMode",
  "terraformEvidence",
  "exactMainCI",
  "mutationBoundary",
  "cleanupState",
]);
const evidenceKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "result",
  "repository",
  "workflowName",
  "workflowPath",
  "commitSHA",
  "operator",
  "deployRunID",
  "sourceRunAttempt",
  "deployMode",
  "terraformEvidence",
  "exactMainCI",
  "mutationBoundary",
  "cleanupState",
]);

function fail() {
  throw new Error("staging deploy retry checkpoint failed");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitHubLogin(value) {
  return (
    typeof value === "string" &&
    githubLoginPattern.test(value) &&
    !value.includes("--")
  );
}

function hasOnlyKeys(value, keys) {
  if (!isRecord(value)) return false;
  const allowed = new Set(keys);
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseMetadata(environment) {
  const deployMode = environment.DEPLOY_MODE ?? "";
  const terraformEvidence =
    deployMode === "normal"
      ? {
          kind: environment.INFRA_EVIDENCE_KIND,
          workflowRunID: environment.INFRA_EVIDENCE_RUN_ID,
          planSHA256: environment.INFRA_PLAN_SHA256,
        }
      : null;
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_REPOSITORY !== "fukamu/cycle" ||
    !commitSHAPattern.test(environment.COMMIT_SHA ?? "") ||
    !isGitHubLogin(environment.GITHUB_ACTOR) ||
    !positiveIntegerPattern.test(environment.GITHUB_RUN_ID ?? "") ||
    !positiveIntegerPattern.test(environment.GITHUB_RUN_ATTEMPT ?? "") ||
    !positiveIntegerPattern.test(environment.EXACT_MAIN_CI_RUN_ID ?? "") ||
    !/^(?:normal|recovery)$/.test(deployMode) ||
    !terraformEvidenceMatchesEnvironment(terraformEvidence, environment)
  ) {
    fail();
  }
  return {
    repository: environment.GITHUB_REPOSITORY,
    workflowName,
    workflowPath,
    commitSHA: environment.COMMIT_SHA,
    operator: environment.GITHUB_ACTOR.toLowerCase(),
    deployRunID: environment.GITHUB_RUN_ID,
    deployRunAttempt: environment.GITHUB_RUN_ATTEMPT,
    deployMode,
    terraformEvidence,
    exactMainCI: {
      commitSHA: environment.COMMIT_SHA,
      result: "verified",
      workflowRunID: environment.EXACT_MAIN_CI_RUN_ID,
    },
  };
}

function terraformEvidenceMatchesEnvironment(value, environment) {
  if (environment.DEPLOY_MODE === "recovery") {
    return (
      value === null &&
      (environment.INFRA_EVIDENCE_KIND ?? "") === "" &&
      (environment.INFRA_EVIDENCE_RUN_ID ?? "") === "" &&
      (environment.INFRA_PLAN_SHA256 ?? "") === ""
    );
  }
  return (
    isRecord(value) &&
    /^(?:no_changes_plan|applied_plan)$/.test(value.kind ?? "") &&
    positiveIntegerPattern.test(value.workflowRunID ?? "") &&
    digestPattern.test(value.planSHA256 ?? "")
  );
}

function validateTerraformEvidence(value, deployMode) {
  if (deployMode === "recovery") return value === null;
  return (
    hasOnlyKeys(value, ["kind", "workflowRunID", "planSHA256"]) &&
    /^(?:no_changes_plan|applied_plan)$/.test(value.kind) &&
    positiveIntegerPattern.test(value.workflowRunID) &&
    digestPattern.test(value.planSHA256)
  );
}

function validateExactMainCI(value, commitSHA) {
  return (
    hasOnlyKeys(value, ["commitSHA", "result", "workflowRunID"]) &&
    value.commitSHA === commitSHA &&
    value.result === "verified" &&
    positiveIntegerPattern.test(value.workflowRunID)
  );
}

function metadataMatches(value, metadata, attemptKey = "deployRunAttempt") {
  return (
    value.repository === metadata.repository &&
    value.workflowName === metadata.workflowName &&
    value.workflowPath === metadata.workflowPath &&
    value.commitSHA === metadata.commitSHA &&
    value.operator === metadata.operator &&
    value.deployRunID === metadata.deployRunID &&
    value[attemptKey] === metadata.deployRunAttempt &&
    value.deployMode === metadata.deployMode &&
    terraformEvidenceEquals(
      value.terraformEvidence,
      metadata.terraformEvidence,
    ) &&
    exactMainCIEquals(value.exactMainCI, metadata.exactMainCI)
  );
}

function terraformEvidenceEquals(left, right) {
  if (left === null || right === null) return left === right;
  return (
    isRecord(left) &&
    isRecord(right) &&
    left.kind === right.kind &&
    left.workflowRunID === right.workflowRunID &&
    left.planSHA256 === right.planSHA256
  );
}

function exactMainCIEquals(left, right) {
  return (
    isRecord(left) &&
    isRecord(right) &&
    left.commitSHA === right.commitSHA &&
    left.result === right.result &&
    left.workflowRunID === right.workflowRunID
  );
}

function validateState(value, metadata) {
  if (
    !hasOnlyKeys(value, stateKeys) ||
    value.schemaVersion !== 1 ||
    value.kind !== stateKind ||
    !metadataMatches(value, metadata) ||
    !validateTerraformEvidence(value.terraformEvidence, value.deployMode) ||
    !validateExactMainCI(value.exactMainCI, value.commitSHA) ||
    !/^(?:not_crossed|crossed)$/.test(value.mutationBoundary) ||
    !/^(?:not_started|unverified|verified)$/.test(value.cleanupState)
  ) {
    fail();
  }
  return value;
}

function validateEvidence(value, metadata) {
  const sourceMetadata = { ...metadata, deployRunAttempt: "1" };
  if (
    !hasOnlyKeys(value, evidenceKeys) ||
    value.schemaVersion !== 1 ||
    value.kind !== evidenceKind ||
    value.result !== "no_mutation_started" ||
    !metadataMatches(value, sourceMetadata, "sourceRunAttempt") ||
    !validateTerraformEvidence(value.terraformEvidence, value.deployMode) ||
    !validateExactMainCI(value.exactMainCI, value.commitSHA) ||
    value.mutationBoundary !== "not_crossed" ||
    !/^(?:not_started|verified)$/.test(value.cleanupState)
  ) {
    fail();
  }
  return value;
}

function validatePath(path, runnerTemp, { mustExist }) {
  if (!isAbsolute(path) || !isAbsolute(runnerTemp)) fail();
  const canonicalRunnerTemp = realpathSync(runnerTemp);
  const target = resolve(path);
  const targetRelative = relative(canonicalRunnerTemp, target);
  if (
    targetRelative === "" ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    fail();
  }
  const canonicalParent = realpathSync(dirname(target));
  const parentRelative = relative(canonicalRunnerTemp, canonicalParent);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    isAbsolute(parentRelative)
  ) {
    fail();
  }
  if (mustExist) {
    const stat = lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > maximumCheckpointBytes
    ) {
      fail();
    }
  }
  return target;
}

function readCheckpoint(path, runnerTemp) {
  const validatedPath = validatePath(path, runnerTemp, { mustExist: true });
  const descriptor = openSync(
    validatedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let raw;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumCheckpointBytes) fail();
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (Buffer.byteLength(raw, "utf8") > maximumCheckpointBytes) fail();
  try {
    return JSON.parse(raw);
  } catch {
    fail();
  }
}

function writeNewFile(path, runnerTemp, value) {
  const validatedPath = validatePath(path, runnerTemp, { mustExist: false });
  const payload = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(payload, "utf8") > maximumCheckpointBytes) fail();
  const descriptor = openSync(
    validatedPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function replaceFile(path, runnerTemp, value) {
  const validatedPath = validatePath(path, runnerTemp, { mustExist: true });
  const temporaryPath = `${validatedPath}.${process.pid}.tmp`;
  try {
    writeNewFile(temporaryPath, runnerTemp, value);
    renameSync(temporaryPath, validatedPath);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function environmentPaths(environment) {
  if (!isAbsolute(environment.RUNNER_TEMP ?? "")) fail();
  return {
    runnerTemp: environment.RUNNER_TEMP,
    stateFile: environment.STAGING_DEPLOY_CHECKPOINT_STATE_FILE,
    evidenceFile: environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE,
  };
}

export function initializeStagingDeployCheckpoint(environment = process.env) {
  const metadata = parseMetadata(environment);
  const { runnerTemp, stateFile } = environmentPaths(environment);
  writeNewFile(stateFile, runnerTemp, {
    schemaVersion: 1,
    kind: stateKind,
    ...metadata,
    mutationBoundary: "not_crossed",
    cleanupState: "not_started",
  });
}

function transitionState(environment, transition) {
  const metadata = parseMetadata(environment);
  const { runnerTemp, stateFile } = environmentPaths(environment);
  const current = validateState(
    readCheckpoint(stateFile, runnerTemp),
    metadata,
  );
  const next = transition(current);
  validateState(next, metadata);
  replaceFile(stateFile, runnerTemp, next);
}

export function markStagingDeployCleanupUnverified(environment = process.env) {
  transitionState(environment, (current) => {
    if (
      current.mutationBoundary !== "not_crossed" ||
      !/^(?:not_started|unverified)$/.test(current.cleanupState)
    ) {
      fail();
    }
    return { ...current, cleanupState: "unverified" };
  });
}

export function markStagingDeployCleanupVerified(environment = process.env) {
  transitionState(environment, (current) => {
    if (current.cleanupState !== "unverified") fail();
    return { ...current, cleanupState: "verified" };
  });
}

export function markStagingDeployMutationBoundaryCrossed(
  environment = process.env,
) {
  transitionState(environment, (current) => {
    if (
      current.mutationBoundary !== "not_crossed" ||
      current.cleanupState !== "unverified"
    ) {
      fail();
    }
    return { ...current, mutationBoundary: "crossed" };
  });
}

export function finalizeStagingDeployRetryEvidence(environment = process.env) {
  const metadata = parseMetadata(environment);
  if (metadata.deployRunAttempt !== "1") fail();
  const { runnerTemp, stateFile, evidenceFile } = environmentPaths(environment);
  const state = validateState(readCheckpoint(stateFile, runnerTemp), metadata);
  if (
    state.mutationBoundary !== "not_crossed" ||
    !/^(?:not_started|verified)$/.test(state.cleanupState)
  ) {
    return false;
  }
  const { deployRunAttempt, ...evidenceMetadata } = metadata;
  writeNewFile(evidenceFile, runnerTemp, {
    schemaVersion: 1,
    kind: evidenceKind,
    result: "no_mutation_started",
    ...evidenceMetadata,
    sourceRunAttempt: deployRunAttempt,
    mutationBoundary: state.mutationBoundary,
    cleanupState: state.cleanupState,
  });
  return true;
}

export function verifyStagingDeployRetryEvidence(environment = process.env) {
  const metadata = parseMetadata(environment);
  if (metadata.deployRunAttempt !== "2") fail();
  const { runnerTemp, evidenceFile } = environmentPaths(environment);
  validateEvidence(readCheckpoint(evidenceFile, runnerTemp), metadata);
}

export function runStagingDeployRetryCheckpointCLI({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
} = {}) {
  if (argv.length !== 0) fail();
  switch (environment.STAGING_DEPLOY_CHECKPOINT_OPERATION) {
    case "initialize":
      initializeStagingDeployCheckpoint(environment);
      stdout.write("staging_deploy_checkpoint_initialized\n");
      return;
    case "finalize":
      stdout.write(
        finalizeStagingDeployRetryEvidence(environment)
          ? "staging_deploy_retry_checkpoint_created\n"
          : "staging_deploy_retry_checkpoint_not_created\n",
      );
      return;
    case "mark_mutation_boundary":
      markStagingDeployMutationBoundaryCrossed(environment);
      stdout.write("staging_deploy_mutation_boundary_crossed\n");
      return;
    case "verify_retry":
      verifyStagingDeployRetryEvidence(environment);
      stdout.write("staging_deploy_retry_checkpoint_verified\n");
      return;
    default:
      fail();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runStagingDeployRetryCheckpointCLI();
  } catch {
    process.stderr.write(
      "Staging deploy retry checkpoint validation failed.\n",
    );
    process.exitCode = 1;
  }
}
