import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readRepositoryFile = (path) =>
  readFileSync(join(repositoryRoot, path), "utf8");
const contract = JSON.parse(
  readRepositoryFile("config/deployment-contract.json"),
);
const workflow = readRepositoryFile(".github/workflows/deploy.yml");
const validationStep = extractStep(
  workflow,
  "Validate required deployment inputs",
);
const validationCommand = extractRunCommand(validationStep);
const validationRequiredKeys = requiredInputNames(contract);

test("deployment contract is the exact repository handoff classification", () => {
  const { backend, closedBeta, deploy, frontend } = contract;
  assert.equal(contract.version, 1);
  assert.equal(backend.fixed.length, 5);
  assert.deepEqual(backend.omitted, ["STATIC_DIR"]);
  assert.equal(backend.githubVariables.length, 35);
  assert.deepEqual(backend.derived, { AI_PRICING_MODEL: "AI_MODEL" });
  assert.equal(backend.secrets.length, 8);

  const backendKeys = [
    ...backend.fixed,
    ...backend.omitted,
    ...backend.githubVariables,
    ...Object.keys(backend.derived),
    ...backend.secrets,
  ];
  assertExactSet(backendKeys, configLookupKeys(), "Backend contract/config.go");
  assertExactSet(
    backendKeys,
    environmentExampleKeys(),
    "Backend contract/.env.example",
  );
  assertExactSet(
    backendKeys,
    documentedBackendKeys(),
    "Backend contract/environment docs",
  );

  const handedToBackend = backendKeys.filter(
    (key) => !backend.omitted.includes(key),
  );
  const indexEnvBody = between(
    readRepositoryFile("cloudflare/src/index.ts"),
    "  envVars = {",
    "\n  };",
  );
  const indexEnvKeys = matches(indexEnvBody, /^    ([A-Z][A-Z0-9_]*):/gm);
  assertExactSet(
    handedToBackend,
    indexEnvKeys,
    "Backend contract/Container envVars",
  );
  const requiredIndexKeys = matches(
    indexEnvBody,
    /required\(\s*"([A-Z][A-Z0-9_]*)"/g,
  );
  assertExactSet(
    [
      ...backend.githubVariables,
      ...Object.keys(backend.derived),
      ...backend.secrets,
    ],
    requiredIndexKeys,
    "classified dynamic Container envVars",
  );

  const wrangler = parseJSONC(readRepositoryFile("cloudflare/wrangler.jsonc"));
  assertExactSet(
    [
      ...backend.githubVariables,
      ...Object.keys(backend.derived),
      closedBeta.mode.name,
      ...closedBeta.conditionalVariables,
    ],
    Object.keys(wrangler.vars),
    "deployment contract/Wrangler vars",
  );
  assertExactSet(
    backend.secrets,
    wrangler.secrets.required,
    "deployment contract/Wrangler required secrets",
  );

  const jobEnvironment = between(
    between(workflow, "  deploy:\n", "\n    steps:\n"),
    "    env:\n",
    "",
  );
  const workflowVariableMappings = expressionMappings(jobEnvironment, "vars");
  const expectedVariableSources = unique([
    ...backend.githubVariables,
    closedBeta.mode.name,
    ...closedBeta.conditionalVariables,
    ...Object.values(frontend.required),
    ...Object.values(frontend.optional),
  ]);
  assert.deepEqual(
    workflowVariableMappings,
    Object.fromEntries(expectedVariableSources.map((name) => [name, name])),
  );

  const workflowSecretMappings = expressionMappings(jobEnvironment, "secrets");
  const expectedSecretTargets = unique([
    ...backend.secrets,
    ...deploy.requiredOnly,
    ...closedBeta.conditionalSecrets,
  ]);
  assert.deepEqual(
    workflowSecretMappings,
    Object.fromEntries(
      expectedSecretTargets.map((target) => [
        target,
        deploy.aliases[target] ?? target,
      ]),
    ),
  );

  const expectedRequiredInputs = requiredInputNames(contract);
  assertExactSet(
    expectedRequiredInputs,
    validationRequiredKeys,
    "deployment contract/workflow required inputs",
  );
  assert.equal(validationCommand, "node ./scripts/validate-deploy-inputs.mjs");
  assert.doesNotMatch(validationStep, /run:\s*\|/);
  assert.doesNotMatch(
    validationStep,
    /\brequired=\(|\bjq\b|BETA_INVITES must|BETA_ADMISSION_COOKIE_TTL_DAYS must/,
  );

  const workerDeployStep = extractStep(
    workflow,
    "Deploy Worker, static assets, and Container",
  );
  assertExactSet(
    [...backend.githubVariables, closedBeta.mode.name],
    extractBashArray(workerDeployStep, "variable_names"),
    "deployment contract/workflow Worker variables",
  );
  assertExactSet(
    [...closedBeta.conditionalVariables, ...Object.keys(backend.derived)],
    matches(workerDeployStep, /--var "([A-Z][A-Z0-9_]*):/g),
    "deployment contract/workflow conditional and derived variables",
  );

  const secretFileStep = extractStep(
    workflow,
    "Create ephemeral Worker secrets file",
  );
  const secretNamesBody = between(secretFileStep, "const names = [", "];", 0);
  assertExactSet(
    backend.secrets,
    matches(secretNamesBody, /"([A-Z][A-Z0-9_]*)"/g),
    "deployment contract/workflow Worker secrets",
  );
  assertExactSet(
    closedBeta.conditionalSecrets,
    matches(secretFileStep, /names\.push\("([A-Z][A-Z0-9_]*)"\)/g),
    "deployment contract/workflow conditional Worker secrets",
  );

  const frontendExampleKeys = matches(
    readRepositoryFile("frontend/.env.example"),
    /^([A-Z][A-Z0-9_]*)=/gm,
  );
  assertExactSet(
    [
      ...Object.keys(frontend.fixed),
      ...Object.keys(frontend.required),
      ...Object.keys(frontend.optional),
    ],
    frontendExampleKeys,
    "deployment contract/frontend example",
  );
  assert.deepEqual(
    buildEnvironmentMappings(extractStep(workflow, "Build static frontend")),
    { ...frontend.fixed, ...frontend.required, ...frontend.optional },
  );

  const backendValidationStep = extractStep(
    workflow,
    "Validate Backend runtime configuration",
  );
  assert.equal(
    extractStepProperty(backendValidationStep, "working-directory"),
    "backend",
  );
  assert.equal(
    extractRunCommand(backendValidationStep),
    "go run ./cmd/configcheck",
  );
  const backendValidationEnvironment = stepEnvironmentMappings(
    backendValidationStep,
  );
  assertExactSet(
    [...backend.fixed, ...backend.omitted, ...Object.keys(backend.derived)],
    Object.keys(backendValidationEnvironment),
    "deployment contract/configcheck fixed and derived inputs",
  );
  assert.deepEqual(backendValidationEnvironment, {
    APP_ENV: { kind: "literal", value: "production" },
    HTTP_ADDRESS: { kind: "literal", value: ":8080" },
    STATIC_DIR: { kind: "literal", value: "" },
    AI_PROVIDER: { kind: "literal", value: "openai" },
    AI_PRICING_MODEL: {
      kind: "environment",
      value: backend.derived.AI_PRICING_MODEL,
    },
    TURNSTILE_ENABLED: { kind: "literal", value: "true" },
    TURNSTILE_EXPECTED_ACTION: {
      kind: "literal",
      value: "anonymous_bootstrap",
    },
  });
  const backendValidationFixedLiterals = Object.fromEntries(
    Object.entries(backendValidationEnvironment)
      .filter(
        ([key, mapping]) => key !== "STATIC_DIR" && mapping.kind === "literal",
      )
      .map(([key, mapping]) => [key, mapping.value]),
  );
  assert.deepEqual(
    stringLiteralMappings(indexEnvBody),
    backendValidationFixedLiterals,
    "Container and configcheck fixed literal inputs",
  );
  assert.ok(
    workflow.indexOf("      - name: Validate Backend runtime configuration\n") <
      workflow.indexOf("      - name: Apply database migrations\n"),
    "Backend runtime validation must run before database migrations",
  );
});

test("current workflow rejects whitespace-only required input", () => {
  const result = runWorkflowValidation({ AI_MODEL: " \t " });
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.notEqual(
    result.status,
    0,
    "Validate required deployment inputs accepted whitespace-only AI_MODEL",
  );
});

test("current workflow rejects whitespace-only reasoning effort", () => {
  const result = runWorkflowValidation({ AI_REASONING_EFFORT: " \t " });
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.notEqual(
    result.status,
    0,
    "Validate required deployment inputs accepted whitespace-only AI_REASONING_EFFORT",
  );
});

test("current workflow rejects runtime-invalid non-empty BETA_INVITES", () => {
  const result = runWorkflowValidation({
    BETA_ADMISSION_MODE: "closed",
    BETA_ADMISSION_COOKIE_TTL_DAYS: "180",
    BETA_INVITES: "[{}]",
    BETA_ADMISSION_COOKIE_KEY: "A".repeat(43),
  });
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.notEqual(
    result.status,
    0,
    "Validate required deployment inputs accepted BETA_INVITES=[{}]",
  );
});

test("current workflow accepts complete valid off-mode inputs", () => {
  const result = runWorkflowValidation({});
  assert.equal(
    result.error,
    undefined,
    "workflow validator command did not run",
  );
  assert.equal(
    result.status,
    0,
    `Validate required deployment inputs rejected valid inputs:\n${result.stderr}`,
  );
});

function configLookupKeys() {
  return matches(
    readRepositoryFile("backend/internal/config/config.go"),
    /reader\.(?:stringValue|intValue|int32Value|floatValue|floatList|boolValue|durationSeconds|durationMinutes|durationDays)\(\s*"([A-Z][A-Z0-9_]*)"/g,
  );
}

function environmentExampleKeys() {
  return matches(readRepositoryFile(".env.example"), /^([A-Z][A-Z0-9_]*)=/gm);
}

function parseJSONC(source) {
  return JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
}

function documentedBackendKeys() {
  const documented = between(
    readRepositoryFile("docs/environment.md"),
    "## Backend runtime\n",
    "## Frontend build-time\n",
  );
  return matches(documented, /^\| `([A-Z][A-Z0-9_]*)` \|/gm);
}

function runWorkflowValidation(overrides) {
  const environment = {
    PATH: process.env.PATH ?? "",
    APP_REFERRAL_URL: "",
    BETA_ADMISSION_COOKIE_TTL_DAYS: "",
    BETA_INVITES: "",
    BETA_ADMISSION_COOKIE_KEY: "",
  };
  for (const name of validationRequiredKeys) environment[name] = "fixture";
  Object.assign(environment, {
    PUBLIC_ORIGIN: "https://cycle.staging.fukamu.matoruru.com",
    BETA_ADMISSION_MODE: "off",
    ...overrides,
  });
  return spawnSync("bash", ["-c", validationCommand], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  });
}

function requiredInputNames(deploymentContract) {
  return unique([
    ...deploymentContract.backend.githubVariables,
    ...deploymentContract.backend.secrets,
    deploymentContract.closedBeta.mode.name,
    ...Object.values(deploymentContract.frontend.required),
    ...deploymentContract.deploy.requiredOnly,
  ]);
}

function expressionMappings(block, context) {
  const result = {};
  const pattern = new RegExp(
    `^      ([A-Z][A-Z0-9_]*): \\$\\{\\{ ${context}\\.([A-Z][A-Z0-9_]*)`,
    "gm",
  );
  for (const match of block.matchAll(pattern)) result[match[1]] = match[2];
  return result;
}

function buildEnvironmentMappings(step) {
  const block = between(step, "        env:\n", "        run:");
  const result = {};
  for (const line of block.split("\n")) {
    const fixed = /^          ([A-Z][A-Z0-9_]*): ([a-z]+)$/.exec(line);
    if (fixed) result[fixed[1]] = fixed[2];
    const mapped =
      /^          ([A-Z][A-Z0-9_]*): \$\{\{ env\.([A-Z][A-Z0-9_]*) \}\}$/.exec(
        line,
      );
    if (mapped) result[mapped[1]] = mapped[2];
  }
  return result;
}

function stepEnvironmentMappings(step) {
  const block = between(step, "        env:\n", "        run:");
  const result = {};
  for (const line of block.split("\n")) {
    const mapped =
      /^          ([A-Z][A-Z0-9_]*): \$\{\{ env\.([A-Z][A-Z0-9_]*) \}\}$/.exec(
        line,
      );
    if (mapped) {
      result[mapped[1]] = { kind: "environment", value: mapped[2] };
      continue;
    }
    const literal = /^          ([A-Z][A-Z0-9_]*): (.*)$/.exec(line);
    if (!literal) continue;
    const rawValue = literal[2];
    result[literal[1]] = {
      kind: "literal",
      value:
        rawValue.startsWith('"') && rawValue.endsWith('"')
          ? JSON.parse(rawValue)
          : rawValue,
    };
  }
  return result;
}

function stringLiteralMappings(source) {
  const result = {};
  const pattern = /^    ([A-Z][A-Z0-9_]*): ("(?:[^"\\]|\\.)*"),$/gm;
  for (const match of source.matchAll(pattern)) {
    result[match[1]] = JSON.parse(match[2]);
  }
  return result;
}

function extractStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);
  const end = source.indexOf("\n      - ", start + marker.length);
  return source.slice(start, end === -1 ? source.length : end);
}

function extractRunCommand(step) {
  const match = /^        run: ([^\n]+)$/m.exec(step);
  assert.ok(match, "workflow single-line run command not found");
  return match[1];
}

function extractStepProperty(step, name) {
  const match = new RegExp(`^        ${name}: ([^\\n]+)$`, "m").exec(step);
  assert.ok(match, `workflow step property not found: ${name}`);
  return match[1];
}

function extractBashArray(source, name) {
  const match = new RegExp(`${name}=\\(\\n([\\s\\S]*?)\\n\\s*\\)`).exec(source);
  assert.ok(match, `Bash array not found: ${name}`);
  return match[1].trim().split(/\s+/);
}

function between(source, startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const contentStart = start + startMarker.length;
  if (endMarker === "") return source.slice(contentStart);
  const end = source.indexOf(endMarker, contentStart);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return source.slice(contentStart, end);
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function unique(values) {
  return [...new Set(values)].sort();
}

function assertExactSet(expected, actual, label) {
  assert.equal(
    new Set(expected).size,
    expected.length,
    `${label}: expected set contains duplicates`,
  );
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${label}: actual set contains duplicates`,
  );
  assert.deepEqual(unique(actual), unique(expected), label);
}
