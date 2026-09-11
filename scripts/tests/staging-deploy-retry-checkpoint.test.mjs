import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  finalizeStagingDeployRetryEvidence,
  initializeStagingDeployCheckpoint,
  markStagingDeployCleanupUnverified,
  markStagingDeployCleanupVerified,
  markStagingDeployMutationBoundaryCrossed,
  runStagingDeployRetryCheckpointCLI,
  verifyStagingDeployRetryEvidence,
} from "../staging-deploy-retry-checkpoint.mjs";

const commitSHA = "a".repeat(40);
const planSHA256 = "b".repeat(64);

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "cycle-deploy-retry-"));
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "fukamu/cycle",
    GITHUB_ACTOR: "Owner",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    COMMIT_SHA: commitSHA,
    DEPLOY_MODE: "normal",
    EXACT_MAIN_CI_RUN_ID: "789",
    INFRA_EVIDENCE_KIND: "no_changes_plan",
    INFRA_EVIDENCE_RUN_ID: "456",
    INFRA_PLAN_SHA256: planSHA256,
    RUNNER_TEMP: root,
    STAGING_DEPLOY_CHECKPOINT_STATE_FILE: join(root, "state.json"),
    STAGING_DEPLOY_RETRY_EVIDENCE_FILE: join(root, "evidence.json"),
    ...overrides,
  };
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return { environment, root };
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function initialize(environment) {
  initializeStagingDeployCheckpoint(environment);
  assert.equal(
    lstatSync(environment.STAGING_DEPLOY_CHECKPOINT_STATE_FILE).mode & 0o777,
    0o600,
  );
}

test("creates and verifies a bounded retry checkpoint before any side effect", () => {
  const { environment } = fixture();
  initialize(environment);
  assert.equal(finalizeStagingDeployRetryEvidence(environment), true);
  const evidence = readJSON(environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE);
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    kind: "staging_deploy_retry_checkpoint",
    result: "no_mutation_started",
    repository: "fukamu/cycle",
    workflowName: "Deploy Staging",
    workflowPath: ".github/workflows/deploy.yml",
    commitSHA,
    operator: "owner",
    deployRunID: "123",
    deployMode: "normal",
    terraformEvidence: {
      kind: "no_changes_plan",
      workflowRunID: "456",
      planSHA256,
    },
    exactMainCI: {
      commitSHA,
      result: "verified",
      workflowRunID: "789",
    },
    sourceRunAttempt: "1",
    mutationBoundary: "not_crossed",
    cleanupState: "not_started",
  });
  assert.equal(
    lstatSync(environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE).mode & 0o777,
    0o600,
  );
  assert.doesNotThrow(() =>
    verifyStagingDeployRetryEvidence({
      ...environment,
      GITHUB_RUN_ATTEMPT: "2",
    }),
  );
});

test("permits retry only after temporary account cleanup is verified", () => {
  const unverified = fixture();
  initialize(unverified.environment);
  markStagingDeployCleanupUnverified(unverified.environment);
  assert.equal(
    finalizeStagingDeployRetryEvidence(unverified.environment),
    false,
  );
  assert.throws(() =>
    verifyStagingDeployRetryEvidence({
      ...unverified.environment,
      GITHUB_RUN_ATTEMPT: "2",
    }),
  );

  const verified = fixture();
  initialize(verified.environment);
  markStagingDeployCleanupUnverified(verified.environment);
  markStagingDeployCleanupVerified(verified.environment);
  assert.equal(finalizeStagingDeployRetryEvidence(verified.environment), true);
  assert.equal(
    readJSON(verified.environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE)
      .cleanupState,
    "verified",
  );
});

test("never creates retry evidence after the mutation boundary is crossed", () => {
  const { environment } = fixture();
  initialize(environment);
  markStagingDeployCleanupUnverified(environment);
  markStagingDeployMutationBoundaryCrossed(environment);
  markStagingDeployCleanupVerified(environment);
  assert.equal(finalizeStagingDeployRetryEvidence(environment), false);
  assert.throws(() =>
    verifyStagingDeployRetryEvidence({
      ...environment,
      GITHUB_RUN_ATTEMPT: "2",
    }),
  );
});

test("rejects invalid lifecycle transitions and exclusive-file replacement", () => {
  const { environment } = fixture();
  initialize(environment);
  assert.throws(() => initializeStagingDeployCheckpoint(environment));
  assert.throws(() => markStagingDeployCleanupVerified(environment));
  assert.throws(() => markStagingDeployMutationBoundaryCrossed(environment));
  markStagingDeployCleanupUnverified(environment);
  markStagingDeployCleanupVerified(environment);
  assert.throws(() => markStagingDeployCleanupVerified(environment));
  assert.throws(() => markStagingDeployMutationBoundaryCrossed(environment));
});

test("rejects invalid GitHub execution identity", () => {
  for (const GITHUB_ACTOR of ["", "bad--login", "-owner", "owner-"]) {
    const { environment } = fixture({ GITHUB_ACTOR });
    assert.throws(() => initializeStagingDeployCheckpoint(environment));
  }
});

test("supports recovery only with an exact null Terraform evidence binding", () => {
  const valid = fixture({
    DEPLOY_MODE: "recovery",
    INFRA_EVIDENCE_KIND: "",
    INFRA_EVIDENCE_RUN_ID: "",
    INFRA_PLAN_SHA256: "",
  });
  initialize(valid.environment);
  assert.equal(finalizeStagingDeployRetryEvidence(valid.environment), true);
  assert.equal(
    readJSON(valid.environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE)
      .terraformEvidence,
    null,
  );
  assert.doesNotThrow(() =>
    verifyStagingDeployRetryEvidence({
      ...valid.environment,
      GITHUB_RUN_ATTEMPT: "2",
    }),
  );

  for (const overrides of [
    { INFRA_EVIDENCE_KIND: "no_changes_plan" },
    { INFRA_EVIDENCE_RUN_ID: "456" },
    { INFRA_PLAN_SHA256: planSHA256 },
  ]) {
    const invalid = fixture({
      DEPLOY_MODE: "recovery",
      INFRA_EVIDENCE_KIND: "",
      INFRA_EVIDENCE_RUN_ID: "",
      INFRA_PLAN_SHA256: "",
      ...overrides,
    });
    assert.throws(() => initializeStagingDeployCheckpoint(invalid.environment));
  }
});

test("binds evidence to the exact run, SHA, mode, operator, CI, and infrastructure", () => {
  const { environment } = fixture();
  initialize(environment);
  assert.equal(finalizeStagingDeployRetryEvidence(environment), true);
  const retry = { ...environment, GITHUB_RUN_ATTEMPT: "2" };
  for (const overrides of [
    { GITHUB_REPOSITORY: "attacker/cycle" },
    { GITHUB_ACTOR: "Attacker" },
    { GITHUB_RUN_ID: "124" },
    { GITHUB_RUN_ATTEMPT: "3" },
    { COMMIT_SHA: "c".repeat(40) },
    {
      DEPLOY_MODE: "recovery",
      INFRA_EVIDENCE_KIND: "",
      INFRA_EVIDENCE_RUN_ID: "",
      INFRA_PLAN_SHA256: "",
    },
    { EXACT_MAIN_CI_RUN_ID: "790" },
    { INFRA_EVIDENCE_KIND: "applied_plan" },
    { INFRA_EVIDENCE_RUN_ID: "457" },
    { INFRA_PLAN_SHA256: "d".repeat(64) },
  ]) {
    assert.throws(() =>
      verifyStagingDeployRetryEvidence({ ...retry, ...overrides }),
    );
  }
});

test("rejects malformed, extended, oversized, symlinked, and escaped evidence", () => {
  const { environment, root } = fixture();
  initialize(environment);
  assert.equal(finalizeStagingDeployRetryEvidence(environment), true);
  const retry = { ...environment, GITHUB_RUN_ATTEMPT: "2" };
  const original = readJSON(environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE);

  for (const mutate of [
    (value) => ({ ...value, unexpected: true }),
    (value) => ({ ...value, schemaVersion: 2 }),
    (value) => ({ ...value, result: "unknown" }),
    (value) => ({ ...value, mutationBoundary: "crossed" }),
    (value) => ({ ...value, cleanupState: "unverified" }),
  ]) {
    writeFileSync(
      environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE,
      JSON.stringify(mutate(original)),
    );
    assert.throws(() => verifyStagingDeployRetryEvidence(retry));
  }

  writeFileSync(environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE, "{");
  assert.throws(() => verifyStagingDeployRetryEvidence(retry));
  writeFileSync(
    environment.STAGING_DEPLOY_RETRY_EVIDENCE_FILE,
    "x".repeat(16 * 1024 + 1),
  );
  assert.throws(() => verifyStagingDeployRetryEvidence(retry));

  const actual = join(root, "actual.json");
  writeFileSync(actual, JSON.stringify(original));
  const linked = join(root, "linked.json");
  symlinkSync(actual, linked);
  assert.throws(() =>
    verifyStagingDeployRetryEvidence({
      ...retry,
      STAGING_DEPLOY_RETRY_EVIDENCE_FILE: linked,
    }),
  );

  const directory = join(root, "evidence-directory");
  mkdirSync(directory);
  assert.throws(() =>
    verifyStagingDeployRetryEvidence({
      ...retry,
      STAGING_DEPLOY_RETRY_EVIDENCE_FILE: directory,
    }),
  );
  assert.throws(() =>
    verifyStagingDeployRetryEvidence({
      ...retry,
      STAGING_DEPLOY_RETRY_EVIDENCE_FILE: join(root, "..", "outside.json"),
    }),
  );
});

test("CLI returns only closed status values", () => {
  const { environment } = fixture();
  let output = "";
  runStagingDeployRetryCheckpointCLI({
    environment: {
      ...environment,
      STAGING_DEPLOY_CHECKPOINT_OPERATION: "initialize",
    },
    stdout: { write: (value) => (output += value) },
  });
  assert.equal(output, "staging_deploy_checkpoint_initialized\n");
  assert.doesNotMatch(output, new RegExp(`${commitSHA}|${planSHA256}|Owner`));
  markStagingDeployCleanupUnverified(environment);
  output = "";
  runStagingDeployRetryCheckpointCLI({
    environment: {
      ...environment,
      STAGING_DEPLOY_CHECKPOINT_OPERATION: "mark_mutation_boundary",
    },
    stdout: { write: (value) => (output += value) },
  });
  assert.equal(output, "staging_deploy_mutation_boundary_crossed\n");
  assert.throws(() =>
    runStagingDeployRetryCheckpointCLI({
      argv: ["unexpected"],
      environment,
    }),
  );
});
