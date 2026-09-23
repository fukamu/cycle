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
const stagingTurnstileSiteKey = "1x00000000000000000000BB";
const stagingTurnstileSecretKey = "1x0000000000000000000000000000000AA";

test("deployment validator accepts valid inputs", () => {
  assert.deepEqual(validateDeploymentInputs(validEnvironment()), []);
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
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: " \t " }),
    ),
    [{ code: "MISSING_REQUIRED_INPUT", key: "OTEL_EXPORTER_OTLP_ENDPOINT" }],
  );
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({ OTEL_EXPORTER_OTLP_HEADERS: " \t " }),
    ),
    [{ code: "MISSING_REQUIRED_INPUT", key: "OTEL_EXPORTER_OTLP_HEADERS" }],
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
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({ PRIVACY_CONTACT_URL: "http://support.example.test/" }),
    ),
    [{ code: "INVALID_INPUT", key: "PRIVACY_CONTACT_URL" }],
  );
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({
        PRIVACY_CONTACT_URL: "https://user:secret@support.example.test/",
      }),
    ),
    [{ code: "INVALID_INPUT", key: "PRIVACY_CONTACT_URL" }],
  );
  assert.deepEqual(
    validateDeploymentInputs(
      validEnvironment({
        PRIVACY_CONTACT_URL: "https://support.example.test/#private",
      }),
    ),
    [{ code: "INVALID_INPUT", key: "PRIVACY_CONTACT_URL" }],
  );
});

test("deployment validator requires a positive backup retention maximum", () => {
  for (const value of ["0", "-1", "1.5", "not-a-number"]) {
    assert.deepEqual(
      validateDeploymentInputs(
        validEnvironment({ ACCOUNT_DELETION_BACKUP_MAX_DAYS: value }),
      ),
      [
        {
          code: "INVALID_INPUT",
          key: "ACCOUNT_DELETION_BACKUP_MAX_DAYS",
        },
      ],
      value,
    );
  }
});

test("deployment validator binds the official Turnstile test pair to staging", () => {
  for (const [name, value] of [
    ["TURNSTILE_SITE_KEY", "live-site-key"],
    ["TURNSTILE_SECRET_KEY", "live-secret-key"],
  ]) {
    assert.deepEqual(
      validateDeploymentInputs(validEnvironment({ [name]: value })),
      [{ code: "INVALID_INPUT", key: name }],
    );
  }
});

test("CLI reports stable identifiers without input values", () => {
  const originCanary = "https://PRIVATE_ORIGIN_CANARY.invalid";
  const result = runCLI({ PUBLIC_ORIGIN: originCanary });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /::error::INVALID_INPUT:PUBLIC_ORIGIN/);
  assert.equal(result.stderr.includes(originCanary), false);
});

function runCLI(overrides) {
  return spawnSync(process.execPath, [validatorPath], {
    encoding: "utf8",
    env: validEnvironment(overrides),
  });
}

function validEnvironment(overrides = {}) {
  const environment = {};
  for (const name of requiredNames()) environment[name] = "fixture";
  return {
    ...environment,
    ACCOUNT_DELETION_BACKUP_MAX_DAYS: "30",
    PUBLIC_ORIGIN: stagingOrigin,
    APP_REFERRAL_URL: "",
    PRIVACY_CONTACT_URL: "https://support.example.test/cycle",
    PRIVACY_OPERATOR_NAME: "Example Cycle Operator",
    TURNSTILE_SITE_KEY: stagingTurnstileSiteKey,
    TURNSTILE_SECRET_KEY: stagingTurnstileSecretKey,
    ...overrides,
  };
}

function requiredNames() {
  return [
    ...new Set([
      ...contract.backend.githubVariables,
      ...contract.backend.secrets,
      ...Object.values(contract.frontend.required),
      ...contract.deploy.requiredOnly,
    ]),
  ];
}
