#!/usr/bin/env node

import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

import { serializeCloudflareDrainEvidence } from "./lib/cloudflare-drain-evidence.mjs";

const maximumInputBytes = 16 * 1024;
const commitSHAPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const releaseEvidenceKeys = Object.freeze([
  "schemaVersion",
  "result",
  "commitSHA",
  "operator",
  "deployRunID",
  "deployRunAttempt",
  "deployMode",
  "terraformEvidence",
  "exactMainCI",
  "cloudflareDrain",
]);

function fail() {
  throw new Error("staging rollout evidence write failed");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  if (!isRecord(value)) return false;
  const allowed = new Set(keys);
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/");
}

function readBoundedEvidenceFile(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maximumInputBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumInputBytes) fail();
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseBoundedJSON(raw) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > maximumInputBytes
  ) {
    fail();
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail();
  }
}

function validatedMetadata(env) {
  const normalTerraformEvidence =
    /^(?:no_changes_plan|applied_plan)$/.test(env.INFRA_EVIDENCE_KIND ?? "") &&
    positiveIntegerPattern.test(env.INFRA_EVIDENCE_RUN_ID ?? "") &&
    digestPattern.test(env.INFRA_PLAN_SHA256 ?? "");
  const recoveryWithoutTerraformEvidence =
    (env.INFRA_EVIDENCE_KIND ?? "") === "" &&
    (env.INFRA_EVIDENCE_RUN_ID ?? "") === "" &&
    (env.INFRA_PLAN_SHA256 ?? "") === "";
  if (
    !commitSHAPattern.test(env.COMMIT_SHA ?? "") ||
    !githubLoginPattern.test(env.GITHUB_ACTOR ?? "") ||
    !positiveIntegerPattern.test(env.GITHUB_RUN_ID ?? "") ||
    !positiveIntegerPattern.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !positiveIntegerPattern.test(env.EXACT_MAIN_CI_RUN_ID ?? "") ||
    !/^(?:normal|recovery)$/.test(env.DEPLOY_MODE ?? "") ||
    !(
      (env.DEPLOY_MODE === "normal" && normalTerraformEvidence) ||
      (env.DEPLOY_MODE === "recovery" && recoveryWithoutTerraformEvidence)
    )
  ) {
    fail();
  }
  return {
    commitSHA: env.COMMIT_SHA,
    operator: env.GITHUB_ACTOR,
    deployRunID: env.GITHUB_RUN_ID,
    deployRunAttempt: env.GITHUB_RUN_ATTEMPT,
    deployMode: env.DEPLOY_MODE,
    terraformEvidence:
      env.DEPLOY_MODE === "normal"
        ? {
            kind: env.INFRA_EVIDENCE_KIND,
            workflowRunID: env.INFRA_EVIDENCE_RUN_ID,
            planSHA256: env.INFRA_PLAN_SHA256,
          }
        : null,
    exactMainCIWorkflowRunID: env.EXACT_MAIN_CI_RUN_ID,
  };
}

function validateDrainEvidence(value, commitSHA) {
  try {
    serializeCloudflareDrainEvidence(value);
  } catch {
    fail();
  }
  if (value.commitSHA !== commitSHA) fail();
  return value;
}

function validatePendingEvidence(value, metadata) {
  if (
    !hasOnlyKeys(value, releaseEvidenceKeys) ||
    value.schemaVersion !== 1 ||
    value.result !== "drained_smoke_pending" ||
    value.commitSHA !== metadata.commitSHA ||
    value.operator !== metadata.operator ||
    value.deployRunID !== metadata.deployRunID ||
    value.deployRunAttempt !== metadata.deployRunAttempt ||
    value.deployMode !== metadata.deployMode ||
    !terraformEvidenceMatches(value.terraformEvidence, metadata) ||
    !hasOnlyKeys(value.exactMainCI, ["commitSHA", "result", "workflowRunID"]) ||
    value.exactMainCI.commitSHA !== metadata.commitSHA ||
    value.exactMainCI.result !== "verified" ||
    value.exactMainCI.workflowRunID !== metadata.exactMainCIWorkflowRunID
  ) {
    fail();
  }
  validateDrainEvidence(value.cloudflareDrain, metadata.commitSHA);
  return value;
}

function terraformEvidenceMatches(value, metadata) {
  if (metadata.terraformEvidence === null) return value === null;
  return (
    hasOnlyKeys(value, ["kind", "workflowRunID", "planSHA256"]) &&
    value.kind === metadata.terraformEvidence.kind &&
    value.workflowRunID === metadata.terraformEvidence.workflowRunID &&
    value.planSHA256 === metadata.terraformEvidence.planSHA256
  );
}

function buildReleaseEvidence(result, metadata, cloudflareDrain) {
  const { exactMainCIWorkflowRunID, ...releaseMetadata } = metadata;
  return {
    schemaVersion: 1,
    result,
    ...releaseMetadata,
    exactMainCI: {
      commitSHA: metadata.commitSHA,
      result: "verified",
      workflowRunID: exactMainCIWorkflowRunID,
    },
    cloudflareDrain,
  };
}

function formatSummary(releaseEvidence) {
  const drainEvidence = releaseEvidence.cloudflareDrain;
  return [
    "## Stable CSRF initial rollout evidence",
    "",
    "| Evidence | Result |",
    "|---|---|",
    `| Rollout checkpoint | ${releaseEvidence.result} |`,
    `| Candidate commit | \`${releaseEvidence.commitSHA}\` |`,
    `| Exact-main CI | ${releaseEvidence.exactMainCI.result} |`,
    `| Exact-main CI workflow run | \`${releaseEvidence.exactMainCI.workflowRunID}\` |`,
    `| Deploy mode | ${releaseEvidence.deployMode} |`,
    `| Terraform evidence | ${releaseEvidence.terraformEvidence?.kind ?? "recovery"} |`,
    `| Terraform evidence workflow run | \`${releaseEvidence.terraformEvidence?.workflowRunID ?? "not_applicable"}\` |`,
    `| Terraform Plan checksum | \`${releaseEvidence.terraformEvidence?.planSHA256 ?? "not_applicable"}\` |`,
    `| Deploy operator | \`${releaseEvidence.operator}\` |`,
    `| Worker version | \`${drainEvidence.workerVersionId}\` |`,
    `| Drained Worker version | \`${drainEvidence.drainedWorkerVersionId}\` |`,
    `| Container rollout | \`${drainEvidence.containerRolloutId}\` |`,
    `| Container image digest | \`${drainEvidence.containerImageDigest}\` |`,
    `| Drained Container image digest | \`${drainEvidence.drainedContainerImageDigest}\` |`,
    `| Drain observed at | \`${drainEvidence.observedAt}\` |`,
    "",
  ].join("\n");
}

export function writeStagingRolloutEvidence({
  argv = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  readInput = () => readFileSync(input.fd, "utf8"),
  readEvidenceFile = readBoundedEvidenceFile,
  writeFile = writeFileSync,
  appendFile = appendFileSync,
} = {}) {
  const stage = env.STAGING_ROLLOUT_EVIDENCE_STAGE;
  if (
    argv.length !== 0 ||
    !/^(?:drained|smoke_passed)$/.test(stage ?? "") ||
    !isAbsolutePath(env.STAGING_ROLLOUT_EVIDENCE_FILE) ||
    !isAbsolutePath(env.GITHUB_STEP_SUMMARY) ||
    typeof readInput !== "function" ||
    typeof readEvidenceFile !== "function" ||
    typeof writeFile !== "function" ||
    typeof appendFile !== "function"
  ) {
    fail();
  }

  const metadata = validatedMetadata(env);
  let releaseEvidence;
  if (stage === "drained") {
    const drainEvidence = validateDrainEvidence(
      parseBoundedJSON(readInput()),
      metadata.commitSHA,
    );
    releaseEvidence = buildReleaseEvidence(
      "drained_smoke_pending",
      metadata,
      drainEvidence,
    );
  } else {
    if (
      !isAbsolutePath(env.STAGING_ROLLOUT_PENDING_EVIDENCE_FILE) ||
      env.STAGING_ROLLOUT_PENDING_EVIDENCE_FILE ===
        env.STAGING_ROLLOUT_EVIDENCE_FILE
    ) {
      fail();
    }
    const pendingEvidence = validatePendingEvidence(
      parseBoundedJSON(
        readEvidenceFile(env.STAGING_ROLLOUT_PENDING_EVIDENCE_FILE),
      ),
      metadata,
    );
    releaseEvidence = buildReleaseEvidence(
      "smoke_passed",
      metadata,
      pendingEvidence.cloudflareDrain,
    );
  }

  writeFile(
    env.STAGING_ROLLOUT_EVIDENCE_FILE,
    `${JSON.stringify(releaseEvidence)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  appendFile(env.GITHUB_STEP_SUMMARY, formatSummary(releaseEvidence), {
    encoding: "utf8",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    writeStagingRolloutEvidence();
  } catch {
    process.stderr.write(
      "::error::Staging rollout evidence could not be recorded.\n",
    );
    process.exitCode = 1;
  }
}
