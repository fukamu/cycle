import assert from "node:assert/strict";
import test from "node:test";

import { materializeStagingWorkerSecrets } from "../materialize-staging-worker-secrets.mjs";
import { writeStagingRolloutEvidence } from "../write-staging-rollout-evidence.mjs";

const commitSHA = "a".repeat(40);
const planSHA256 = "3".repeat(64);
const safeDrainEvidence = Object.freeze({
  result: "drained",
  commitSHA,
  workerDeploymentId: "00000000-0000-4000-8000-000000000001",
  workerVersionId: "00000000-0000-4000-8000-000000000002",
  drainedWorkerVersionId: "00000000-0000-4000-8000-000000000003",
  containerApplicationId: "00000000-0000-4000-8000-000000000004",
  containerRolloutId: "00000000-0000-4000-8000-000000000005",
  containerVersion: 2,
  containerImageDigest: `sha256:${"1".repeat(64)}`,
  containerInstanceId: "00000000-0000-4000-8000-000000000006",
  drainedContainerVersion: 1,
  drainedContainerImageDigest: `sha256:${"2".repeat(64)}`,
  observedAt: "2026-09-07T00:00:00.000Z",
});

test("materializes only the exact Worker secret allowlist", () => {
  const writes = [];
  const baseEnvironment = {
    WORKER_SECRETS_FILE: "/tmp/worker-secrets.json",
    BETA_ADMISSION_MODE: "off",
    DATABASE_URL: "database-private",
    OTEL_EXPORTER_OTLP_HEADERS: "otel-private",
    SESSION_TOKEN_PEPPER: "session-private",
    CSRF_TOKEN_PEPPER: "csrf-private",
    BOOTSTRAP_ID_PEPPER: "bootstrap-private",
    RATE_LIMIT_HMAC_SECRET: "rate-private",
    CURSOR_SIGNING_SECRET: "cursor-private",
    OPENAI_API_KEY: "openai-private",
    TURNSTILE_SECRET_KEY: "turnstile-private",
  };
  materializeStagingWorkerSecrets({
    argv: [],
    env: baseEnvironment,
    writeFile: (...values) => writes.push(values),
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "/tmp/worker-secrets.json");
  assert.deepEqual(writes[0][2], {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  assert.deepEqual(Object.keys(JSON.parse(writes[0][1])).sort(), [
    "BOOTSTRAP_ID_PEPPER",
    "CSRF_TOKEN_PEPPER",
    "CURSOR_SIGNING_SECRET",
    "DATABASE_URL",
    "OPENAI_API_KEY",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "RATE_LIMIT_HMAC_SECRET",
    "SESSION_TOKEN_PEPPER",
    "TURNSTILE_SECRET_KEY",
  ]);

  const closedWrites = [];
  materializeStagingWorkerSecrets({
    argv: [],
    env: {
      ...baseEnvironment,
      BETA_ADMISSION_MODE: "closed",
      BETA_ADMISSION_COOKIE_KEY: "admission-private",
    },
    writeFile: (...values) => closedWrites.push(values),
  });
  assert.equal(
    JSON.parse(closedWrites[0][1]).BETA_ADMISSION_COOKIE_KEY,
    "admission-private",
  );
  assert.throws(
    () =>
      materializeStagingWorkerSecrets({
        argv: [],
        env: { ...baseEnvironment, CSRF_TOKEN_PEPPER: "" },
        writeFile: () => undefined,
      }),
    /materialization failed/,
  );
});

function normalEnvironment(overrides = {}) {
  return {
    STAGING_ROLLOUT_EVIDENCE_STAGE: "drained",
    STAGING_ROLLOUT_EVIDENCE_FILE: "/tmp/release-evidence.json",
    GITHUB_STEP_SUMMARY: "/tmp/step-summary.md",
    COMMIT_SHA: commitSHA,
    GITHUB_ACTOR: "matoruru",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    EXACT_MAIN_CI_RUN_ID: "789",
    DEPLOY_MODE: "normal",
    INFRA_EVIDENCE_KIND: "no_changes_plan",
    INFRA_EVIDENCE_RUN_ID: "456",
    INFRA_PLAN_SHA256: planSHA256,
    ...overrides,
  };
}

function writePending(environment = normalEnvironment()) {
  const files = [];
  const summaries = [];
  writeStagingRolloutEvidence({
    argv: [],
    env: environment,
    readInput: () => `${JSON.stringify(safeDrainEvidence)}\n`,
    writeFile: (...values) => files.push(values),
    appendFile: (...values) => summaries.push(values),
  });
  return { files, summaries, record: JSON.parse(files[0][1]) };
}

test("records drain as smoke-pending with only release-safe metadata", () => {
  const privateToken = "cloudflare-private-token";
  const environment = normalEnvironment({
    CLOUDFLARE_API_TOKEN: privateToken,
  });
  const { files, summaries, record } = writePending(environment);
  assert.deepEqual(
    {
      schemaVersion: record.schemaVersion,
      result: record.result,
      commitSHA: record.commitSHA,
      operator: record.operator,
      deployRunID: record.deployRunID,
      deployRunAttempt: record.deployRunAttempt,
      deployMode: record.deployMode,
      terraformEvidence: record.terraformEvidence,
      exactMainCI: record.exactMainCI,
    },
    {
      schemaVersion: 1,
      result: "drained_smoke_pending",
      commitSHA,
      operator: "matoruru",
      deployRunID: "123",
      deployRunAttempt: "2",
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
    },
  );
  assert.deepEqual(record.cloudflareDrain, safeDrainEvidence);
  assert.deepEqual(files[0][2], {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  assert.match(summaries[0][1], /Stable CSRF initial rollout evidence/);
  assert.match(summaries[0][1], /drained_smoke_pending/);
  assert.doesNotMatch(files[0][1], new RegExp(privateToken));
  assert.doesNotMatch(summaries[0][1], new RegExp(privateToken));

  assert.throws(
    () =>
      writeStagingRolloutEvidence({
        argv: [],
        env: environment,
        readInput: () =>
          JSON.stringify({ ...safeDrainEvidence, commitSHA: "b".repeat(40) }),
        writeFile: () => undefined,
        appendFile: () => undefined,
      }),
    /evidence write failed/,
  );
  assert.throws(
    () =>
      writeStagingRolloutEvidence({
        argv: [],
        env: {
          ...environment,
          DEPLOY_MODE: "recovery",
          INFRA_EVIDENCE_KIND: "applied_plan",
        },
        readInput: () => JSON.stringify(safeDrainEvidence),
        writeFile: () => undefined,
        appendFile: () => undefined,
      }),
    /evidence write failed/,
  );
});

test("accepts applied Plan evidence and rejects malformed Terraform metadata", () => {
  const { record } = writePending(
    normalEnvironment({ INFRA_EVIDENCE_KIND: "applied_plan" }),
  );
  assert.deepEqual(record.terraformEvidence, {
    kind: "applied_plan",
    workflowRunID: "456",
    planSHA256,
  });

  for (const override of [
    { INFRA_EVIDENCE_KIND: "changes_present" },
    { INFRA_EVIDENCE_RUN_ID: "0" },
    { INFRA_PLAN_SHA256: "not-a-checksum" },
  ]) {
    assert.throws(
      () => writePending(normalEnvironment(override)),
      /evidence write failed/,
    );
  }
});

test("finalizes a matching pending checkpoint in a distinct file", () => {
  const privateToken = "cloudflare-private-token";
  const { record: pendingRecord } = writePending(
    normalEnvironment({ CLOUDFLARE_API_TOKEN: privateToken }),
  );
  const files = [];
  const summaries = [];
  const environment = normalEnvironment({
    STAGING_ROLLOUT_EVIDENCE_STAGE: "smoke_passed",
    STAGING_ROLLOUT_PENDING_EVIDENCE_FILE: "/tmp/pending-evidence.json",
    STAGING_ROLLOUT_EVIDENCE_FILE: "/tmp/final-evidence.json",
    CLOUDFLARE_API_TOKEN: privateToken,
  });

  writeStagingRolloutEvidence({
    argv: [],
    env: environment,
    readInput: () => {
      throw new Error("stdin must not be read while finalizing evidence");
    },
    readEvidenceFile: (path) => {
      assert.equal(path, "/tmp/pending-evidence.json");
      return `${JSON.stringify(pendingRecord)}\n`;
    },
    writeFile: (...values) => files.push(values),
    appendFile: (...values) => summaries.push(values),
  });

  const finalRecord = JSON.parse(files[0][1]);
  assert.deepEqual(finalRecord, {
    ...pendingRecord,
    result: "smoke_passed",
  });
  assert.deepEqual(files[0][2], {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  assert.match(summaries[0][1], /smoke_passed/);
  assert.doesNotMatch(files[0][1], new RegExp(privateToken));
  assert.doesNotMatch(summaries[0][1], new RegExp(privateToken));
});

test("finalizes a matching recovery checkpoint without an apply run", () => {
  const pendingEnvironment = normalEnvironment({
    DEPLOY_MODE: "recovery",
    INFRA_EVIDENCE_KIND: "",
    INFRA_EVIDENCE_RUN_ID: "",
    INFRA_PLAN_SHA256: "",
  });
  const { record: pendingRecord } = writePending(pendingEnvironment);
  const files = [];
  writeStagingRolloutEvidence({
    argv: [],
    env: {
      ...pendingEnvironment,
      STAGING_ROLLOUT_EVIDENCE_STAGE: "smoke_passed",
      STAGING_ROLLOUT_PENDING_EVIDENCE_FILE:
        "/tmp/recovery-pending-evidence.json",
      STAGING_ROLLOUT_EVIDENCE_FILE: "/tmp/recovery-final-evidence.json",
    },
    readEvidenceFile: () => JSON.stringify(pendingRecord),
    writeFile: (...values) => files.push(values),
    appendFile: () => undefined,
  });
  const finalRecord = JSON.parse(files[0][1]);
  assert.equal(finalRecord.result, "smoke_passed");
  assert.equal(finalRecord.deployMode, "recovery");
  assert.equal(finalRecord.terraformEvidence, null);
});

test("fails closed when pending checkpoint metadata does not match the run", () => {
  const { record: pendingRecord } = writePending();
  const baseEnvironment = normalEnvironment({
    STAGING_ROLLOUT_EVIDENCE_STAGE: "smoke_passed",
    STAGING_ROLLOUT_PENDING_EVIDENCE_FILE: "/tmp/pending-evidence.json",
    STAGING_ROLLOUT_EVIDENCE_FILE: "/tmp/final-evidence.json",
  });
  const mismatches = [
    { commitSHA: "b".repeat(40) },
    { operator: "another-operator" },
    { deployRunID: "999" },
    { deployRunAttempt: "3" },
    { deployMode: "recovery", terraformEvidence: null },
    {
      terraformEvidence: {
        kind: "applied_plan",
        workflowRunID: "999",
        planSHA256,
      },
    },
    {
      exactMainCI: {
        commitSHA: "b".repeat(40),
        result: "verified",
        workflowRunID: "789",
      },
    },
    {
      exactMainCI: { commitSHA, result: "failed", workflowRunID: "789" },
    },
    {
      exactMainCI: { commitSHA, result: "verified", workflowRunID: "999" },
    },
    { cloudflareDrain: { ...safeDrainEvidence, commitSHA: "b".repeat(40) } },
  ];

  for (const mismatch of mismatches) {
    assert.throws(
      () =>
        writeStagingRolloutEvidence({
          argv: [],
          env: baseEnvironment,
          readEvidenceFile: () =>
            JSON.stringify({ ...pendingRecord, ...mismatch }),
          writeFile: () => undefined,
          appendFile: () => undefined,
        }),
      /evidence write failed/,
    );
  }

  assert.throws(
    () =>
      writeStagingRolloutEvidence({
        argv: [],
        env: {
          ...baseEnvironment,
          STAGING_ROLLOUT_EVIDENCE_FILE: "/tmp/pending-evidence.json",
        },
        readEvidenceFile: () => JSON.stringify(pendingRecord),
        writeFile: () => undefined,
        appendFile: () => undefined,
      }),
    /evidence write failed/,
  );
});

test("rejects invalid, oversized, or secret-bearing pending checkpoints", () => {
  const { record: pendingRecord } = writePending();
  const environment = normalEnvironment({
    STAGING_ROLLOUT_EVIDENCE_STAGE: "smoke_passed",
    STAGING_ROLLOUT_PENDING_EVIDENCE_FILE: "/tmp/pending-evidence.json",
    STAGING_ROLLOUT_EVIDENCE_FILE: "/tmp/final-evidence.json",
  });
  const invalidValues = [
    "not-json",
    JSON.stringify({ ...pendingRecord, result: "drained" }),
    JSON.stringify({ ...pendingRecord, secret: "must-not-pass" }),
    JSON.stringify({
      ...pendingRecord,
      cloudflareDrain: {
        ...pendingRecord.cloudflareDrain,
        apiToken: "must-not-pass",
      },
    }),
    `${JSON.stringify(pendingRecord)}${" ".repeat(16 * 1024)}`,
  ];

  for (const value of invalidValues) {
    assert.throws(
      () =>
        writeStagingRolloutEvidence({
          argv: [],
          env: environment,
          readEvidenceFile: () => value,
          writeFile: () => undefined,
          appendFile: () => undefined,
        }),
      /evidence write failed/,
    );
  }

  for (const stage of [undefined, "drain", "SMOKE_PASSED"]) {
    assert.throws(
      () =>
        writeStagingRolloutEvidence({
          argv: [],
          env: {
            ...environment,
            STAGING_ROLLOUT_EVIDENCE_STAGE: stage,
          },
          readEvidenceFile: () => JSON.stringify(pendingRecord),
          writeFile: () => undefined,
          appendFile: () => undefined,
        }),
      /evidence write failed/,
    );
  }
});
