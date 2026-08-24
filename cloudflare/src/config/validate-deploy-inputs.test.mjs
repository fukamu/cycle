import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateDeploymentInputs } from "../../../scripts/validate-deploy-inputs.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const contract = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "config/deployment-contract.json"),
    "utf8",
  ),
);
const validatorPath = resolve(
  repositoryRoot,
  "scripts/validate-deploy-inputs.mjs",
);
const stagingOrigin = "https://cycle.staging.fukamu.matoruru.com";
const productionReferralURL = "https://cycle.fukamu.com/";
const benignCookieKey = Buffer.alloc(32, 7).toString("base64url");

test("deployment validator accepts valid off and closed inputs", () => {
  assert.deepEqual(validateDeploymentInputs(validEnvironment()), []);
  assert.deepEqual(validateDeploymentInputs(validClosedEnvironment()), []);
});

test("deployment validator trims required inputs for presence", () => {
  assert.deepEqual(
    validateDeploymentInputs(validEnvironment({ AI_MODEL: " \t " })),
    [{ code: "MISSING_REQUIRED_INPUT", key: "AI_MODEL" }],
  );
  assert.deepEqual(
    validateDeploymentInputs(validEnvironment({ AI_REASONING_EFFORT: " \t " })),
    [{ code: "MISSING_REQUIRED_INPUT", key: "AI_REASONING_EFFORT" }],
  );
});

test("deployment validator derives every required input from the contract", () => {
  for (const name of requiredNames()) {
    assert.deepEqual(
      validateDeploymentInputs(validEnvironment({ [name]: " \t " })),
      [{ code: "MISSING_REQUIRED_INPUT", key: name }],
      name,
    );
  }
});

test("deployment validator delegates strict invite validation", () => {
  const cases = [
    ["entry schema", "[{}]"],
    [
      "duplicate entry",
      JSON.stringify([inviteEntry("beta-001", 1), inviteEntry("beta-001", 2)]),
    ],
    ["entry limit", JSON.stringify(inviteEntries(1_001))],
  ];
  for (const [name, invites] of cases) {
    const problems = validateDeploymentInputs(
      validClosedEnvironment({ BETA_INVITES: invites }),
    );
    assert.deepEqual(
      problems,
      [{ code: "INVALID_INPUT", key: "BETA_INVITES" }],
      name,
    );
  }
});

test("closed-only inputs are ignored off and required closed", () => {
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({
        BETA_ADMISSION_COOKIE_TTL_DAYS: "invalid",
        BETA_INVITES: "invalid",
        BETA_ADMISSION_COOKIE_KEY: "invalid",
      }),
    ),
    [],
  );

  for (const name of [
    ...contract.closedBeta.conditionalVariables,
    ...contract.closedBeta.conditionalSecrets,
  ]) {
    const environment = validClosedEnvironment();
    environment[name] = " \t ";
    const problems = validateDeploymentInputs(environment);
    assert.equal(
      problems.some(
        (problem) =>
          problem.code === "MISSING_REQUIRED_INPUT" && problem.key === name,
      ),
      true,
    );
  }
});

test("deployment-specific URL policies remain exact", () => {
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({ APP_REFERRAL_URL: productionReferralURL }),
    ),
    [],
  );
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({ PUBLIC_ORIGIN: `${stagingOrigin}/` }),
    ),
    [{ code: "INVALID_INPUT", key: "PUBLIC_ORIGIN" }],
  );
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({ APP_REFERRAL_URL: "https://example.invalid/" }),
    ),
    [{ code: "INVALID_INPUT", key: "APP_REFERRAL_URL" }],
  );
});

test("CLI reports stable identifiers without input values", () => {
  const inviteCanary = "RAW_TOKEN_CANARY";
  const digestCanary = "DIGEST_CANARY";
  const keyCanary = "KEY_CANARY";
  const inviteResult = runCLI({
    BETA_INVITES: JSON.stringify([
      { id: "beta-001", digest: digestCanary, token: inviteCanary },
    ]),
  });
  const keyResult = runCLI({
    BETA_ADMISSION_COOKIE_KEY: keyCanary,
  });

  assert.equal(inviteResult.status, 1);
  assert.equal(keyResult.status, 1);
  assert.equal(inviteResult.stdout, "");
  assert.equal(keyResult.stdout, "");
  assert.match(inviteResult.stderr, /::error::INVALID_INPUT:BETA_INVITES/);
  assert.match(
    keyResult.stderr,
    /::error::INVALID_INPUT:BETA_ADMISSION_COOKIE_KEY/,
  );
  const output = `${inviteResult.stderr}\n${keyResult.stderr}`;
  for (const canary of [inviteCanary, digestCanary, keyCanary]) {
    assert.equal(output.includes(canary), false);
  }
});

function runCLI(overrides) {
  return spawnSync(process.execPath, [validatorPath], {
    encoding: "utf8",
    env: validClosedEnvironment(overrides),
  });
}

function validEnvironment(overrides = {}) {
  const environment = {};
  for (const name of requiredNames()) environment[name] = "fixture";
  return {
    ...environment,
    PUBLIC_ORIGIN: stagingOrigin,
    BETA_ADMISSION_MODE: "off",
    APP_REFERRAL_URL: "",
    ...overrides,
  };
}

function validClosedEnvironment(overrides = {}) {
  return validEnvironment({
    BETA_ADMISSION_MODE: "closed",
    BETA_ADMISSION_COOKIE_TTL_DAYS: "180",
    BETA_INVITES: JSON.stringify([inviteEntry("beta-001", 1)]),
    BETA_ADMISSION_COOKIE_KEY: benignCookieKey,
    ...overrides,
  });
}

function requiredNames() {
  return [
    ...new Set([
      ...contract.backend.githubVariables,
      ...contract.backend.secrets,
      contract.closedBeta.mode.name,
      ...Object.values(contract.frontend.required),
      ...contract.deploy.requiredOnly,
    ]),
  ];
}

function inviteEntries(count) {
  return Array.from({ length: count }, (_, index) =>
    inviteEntry(`beta-${index}`, index),
  );
}

function inviteEntry(id, digestIndex) {
  return { id, digest: digestIndex.toString(16).padStart(64, "0") };
}
