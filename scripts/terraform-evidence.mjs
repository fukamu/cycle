#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const maximumEvidenceBytes = 4 * 1024;
const failureMessage = "terraform evidence failed\n";
const commitSHAPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const runIDPattern = /^[1-9][0-9]*$/;
const planResults = new Set(["no_changes", "changes_present"]);
const operations = new Set([
  "write_plan",
  "verify_plan",
  "write_apply",
  "verify_apply",
]);
const planEvidenceKeys = Object.freeze([
  "schemaVersion",
  "result",
  "commitSHA",
  "workflowRunID",
  "planSHA256",
]);
const applyEvidenceKeys = Object.freeze([
  "schemaVersion",
  "result",
  "commitSHA",
  "workflowRunID",
  "sourcePlanWorkflowRunID",
  "planSHA256",
]);

export class TerraformEvidenceFailure extends Error {
  constructor() {
    super("terraform evidence failed");
    this.name = "TerraformEvidenceFailure";
  }
}

function fail() {
  throw new TerraformEvidenceFailure();
}

function hasExactKeys(value, expectedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function parseCommitSHA(value) {
  if (typeof value !== "string" || !commitSHAPattern.test(value)) fail();
  return value;
}

function parseRunID(value) {
  if (typeof value !== "string" || !runIDPattern.test(value)) fail();
  return value;
}

function parsePlanResult(value) {
  if (typeof value !== "string" || !planResults.has(value)) fail();
  return value;
}

function parseSHA256(value) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) fail();
  return value;
}

function parseAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    fail();
  }
  return value;
}

async function requireCanonicalDirectory(directory) {
  const parsed = parseAbsolutePath(directory);
  let metadata;
  let canonical;
  try {
    [metadata, canonical] = await Promise.all([
      lstat(parsed),
      realpath(parsed),
    ]);
  } catch {
    fail();
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    canonical !== parsed
  ) {
    fail();
  }
  return parsed;
}

async function openRegularFile(filename, maximumBytes) {
  const parsed = parseAbsolutePath(filename);
  let canonical;
  let handle;
  try {
    canonical = await realpath(parsed);
    if (canonical !== parsed) fail();
    handle = await open(parsed, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (maximumBytes !== undefined &&
        (metadata.size <= 0 || metadata.size > maximumBytes))
    ) {
      fail();
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof TerraformEvidenceFailure) throw error;
    fail();
  }
}

async function readEvidenceFile(filename) {
  const handle = await openRegularFile(filename, maximumEvidenceBytes);
  try {
    const bytes = await handle.readFile();
    if (bytes.length === 0 || bytes.length > maximumEvidenceBytes) fail();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof TerraformEvidenceFailure) throw error;
    fail();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hashRegularFile(filename) {
  const handle = await openRegularFile(filename);
  const hash = createHash("sha256");
  try {
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    fail();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeExclusiveEvidence(filename, evidence) {
  const parsed = parseAbsolutePath(filename);
  await requireCanonicalDirectory(path.dirname(parsed));
  const contents = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(contents, "utf8") > maximumEvidenceBytes) fail();

  let handle;
  let created = false;
  try {
    handle = await open(
      parsed,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) fail();
  } catch (error) {
    if (created) await unlink(parsed).catch(() => undefined);
    if (error instanceof TerraformEvidenceFailure) throw error;
    fail();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parsePlanEvidence(value) {
  if (!hasExactKeys(value, planEvidenceKeys) || value.schemaVersion !== 1) {
    fail();
  }
  return Object.freeze({
    schemaVersion: 1,
    result: parsePlanResult(value.result),
    commitSHA: parseCommitSHA(value.commitSHA),
    workflowRunID: parseRunID(value.workflowRunID),
    planSHA256: parseSHA256(value.planSHA256),
  });
}

function parseApplyEvidence(value) {
  if (
    !hasExactKeys(value, applyEvidenceKeys) ||
    value.schemaVersion !== 1 ||
    value.result !== "applied_plan"
  ) {
    fail();
  }
  return Object.freeze({
    schemaVersion: 1,
    result: "applied_plan",
    commitSHA: parseCommitSHA(value.commitSHA),
    workflowRunID: parseRunID(value.workflowRunID),
    sourcePlanWorkflowRunID: parseRunID(value.sourcePlanWorkflowRunID),
    planSHA256: parseSHA256(value.planSHA256),
  });
}

async function requireExactArtifactEntries(directory, expectedNames) {
  const parsed = await requireCanonicalDirectory(directory);
  let entries;
  try {
    entries = await readdir(parsed, { withFileTypes: true });
  } catch {
    fail();
  }
  const sorted = entries.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const expected = [...expectedNames].sort();
  if (
    sorted.length !== expected.length ||
    sorted.some(
      (entry, index) => entry.name !== expected[index] || !entry.isFile(),
    )
  ) {
    fail();
  }
  return parsed;
}

export async function writePlanEvidence(env) {
  const planFile = parseAbsolutePath(env.TERRAFORM_PLAN_FILE);
  const result = parsePlanResult(env.TERRAFORM_PLAN_RESULT);
  const evidence = {
    schemaVersion: 1,
    result,
    commitSHA: parseCommitSHA(env.COMMIT_SHA),
    workflowRunID: parseRunID(env.GITHUB_RUN_ID),
    planSHA256: await hashRegularFile(planFile),
  };
  await writeExclusiveEvidence(env.TERRAFORM_PLAN_EVIDENCE_FILE, evidence);
  return Object.freeze(evidence);
}

export async function verifyPlanEvidence(env) {
  const directory = await requireExactArtifactEntries(
    env.TERRAFORM_EVIDENCE_DIRECTORY,
    ["staging.tfplan", "terraform-plan-evidence.json"],
  );
  const evidence = parsePlanEvidence(
    await readEvidenceFile(
      path.join(directory, "terraform-plan-evidence.json"),
    ),
  );
  if (
    evidence.commitSHA !== parseCommitSHA(env.EXPECTED_COMMIT_SHA) ||
    evidence.workflowRunID !== parseRunID(env.EXPECTED_WORKFLOW_RUN_ID) ||
    evidence.result !== parsePlanResult(env.EXPECTED_PLAN_RESULT)
  ) {
    fail();
  }
  const checksum = await hashRegularFile(
    path.join(directory, "staging.tfplan"),
  );
  if (checksum !== evidence.planSHA256) fail();
  return checksum;
}

export async function writeApplyEvidence(env) {
  const planEvidence = parsePlanEvidence(
    await readEvidenceFile(env.TERRAFORM_PLAN_EVIDENCE_FILE),
  );
  const commitSHA = parseCommitSHA(env.COMMIT_SHA);
  const workflowRunID = parseRunID(env.GITHUB_RUN_ID);
  const sourcePlanWorkflowRunID = parseRunID(env.PLAN_RUN_ID);
  if (
    planEvidence.result !== "changes_present" ||
    planEvidence.commitSHA !== commitSHA ||
    planEvidence.workflowRunID !== sourcePlanWorkflowRunID
  ) {
    fail();
  }
  const evidence = {
    schemaVersion: 1,
    result: "applied_plan",
    commitSHA,
    workflowRunID,
    sourcePlanWorkflowRunID,
    planSHA256: planEvidence.planSHA256,
  };
  await writeExclusiveEvidence(env.TERRAFORM_APPLY_EVIDENCE_FILE, evidence);
  return Object.freeze(evidence);
}

export async function verifyApplyEvidence(env) {
  const directory = await requireExactArtifactEntries(
    env.TERRAFORM_EVIDENCE_DIRECTORY,
    ["terraform-apply-evidence.json"],
  );
  const evidence = parseApplyEvidence(
    await readEvidenceFile(
      path.join(directory, "terraform-apply-evidence.json"),
    ),
  );
  if (
    evidence.commitSHA !== parseCommitSHA(env.EXPECTED_COMMIT_SHA) ||
    evidence.workflowRunID !== parseRunID(env.EXPECTED_WORKFLOW_RUN_ID)
  ) {
    fail();
  }
  return evidence.planSHA256;
}

async function write(output, value) {
  if (output.write(value)) return;
  await new Promise((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
}

export async function runTerraformEvidenceCLI({
  argv = process.argv.slice(2),
  env = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  try {
    if (
      argv.length !== 0 ||
      !operations.has(env.TERRAFORM_EVIDENCE_OPERATION)
    ) {
      fail();
    }
    switch (env.TERRAFORM_EVIDENCE_OPERATION) {
      case "write_plan":
        await writePlanEvidence(env);
        break;
      case "verify_plan":
        await write(output, `${await verifyPlanEvidence(env)}\n`);
        break;
      case "write_apply":
        await writeApplyEvidence(env);
        break;
      case "verify_apply":
        await write(output, `${await verifyApplyEvidence(env)}\n`);
        break;
      default:
        fail();
    }
    return 0;
  } catch {
    await write(errorOutput, failureMessage).catch(() => undefined);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runTerraformEvidenceCLI();
}
