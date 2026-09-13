#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const maximumResponseBytes = 64 * 1024;
const commitSHAPattern = /^[0-9a-f]{40}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const workflowName = "Deploy Staging";
const workflowPath = ".github/workflows/deploy.yml";

function fail() {
  throw new Error("staging deploy retry resolution failed");
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

function parseEnvironment(environment) {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_API_URL !== "https://api.github.com" ||
    environment.GITHUB_REPOSITORY !== "fukamu/cycle" ||
    !positiveIntegerPattern.test(environment.GITHUB_RUN_ID ?? "") ||
    environment.GITHUB_RUN_ATTEMPT !== "2" ||
    !commitSHAPattern.test(environment.COMMIT_SHA ?? "") ||
    !/^(?:normal|recovery)$/.test(environment.DEPLOY_MODE ?? "") ||
    !isGitHubLogin(environment.EXPECTED_APPROVER) ||
    !isGitHubLogin(environment.GITHUB_ACTOR) ||
    !isGitHubLogin(environment.GITHUB_TRIGGERING_ACTOR) ||
    environment.GITHUB_ACTOR.toLowerCase() !==
      environment.EXPECTED_APPROVER.toLowerCase() ||
    environment.GITHUB_TRIGGERING_ACTOR.toLowerCase() !==
      environment.EXPECTED_APPROVER.toLowerCase() ||
    typeof environment.GH_TOKEN !== "string" ||
    environment.GH_TOKEN.length === 0
  ) {
    fail();
  }
  return {
    apiURL: environment.GITHUB_API_URL,
    repository: environment.GITHUB_REPOSITORY,
    runID: environment.GITHUB_RUN_ID,
    commitSHA: environment.COMMIT_SHA,
    token: environment.GH_TOKEN,
  };
}

async function readBoundedJSON(response) {
  if (
    typeof response !== "object" ||
    response === null ||
    response.ok !== true ||
    typeof response.arrayBuffer !== "function"
  ) {
    fail();
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > maximumResponseBytes) fail();
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    fail();
  }
}

async function fetchGitHubJSON(fetchImplementation, url, token) {
  let response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail();
  }
  return readBoundedJSON(response);
}

function validateSourceAttempt(value, metadata) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    value.id.toString() !== metadata.runID ||
    value.run_attempt !== 1 ||
    value.name !== workflowName ||
    value.path !== workflowPath ||
    value.event !== "workflow_dispatch" ||
    value.status !== "completed" ||
    value.conclusion !== "failure" ||
    value.head_sha !== metadata.commitSHA ||
    value.head_branch !== "main" ||
    !isRecord(value.repository) ||
    value.repository.full_name !== metadata.repository
  ) {
    fail();
  }
}

export async function resolveStagingDeployRetry({
  environment = process.env,
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (typeof fetchImplementation !== "function") fail();
  const metadata = parseEnvironment(environment);
  const encodedRepository = metadata.repository
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const cacheKey = `staging-deploy-retry-${metadata.commitSHA}-${metadata.runID}-1`;
  const sourceAttempt = await fetchGitHubJSON(
    fetchImplementation,
    `${metadata.apiURL}/repos/${encodedRepository}/actions/runs/${metadata.runID}/attempts/1`,
    metadata.token,
  );
  validateSourceAttempt(sourceAttempt, metadata);
  return cacheKey;
}

export async function runResolveStagingDeployRetryCLI({
  argv = process.argv.slice(2),
  environment = process.env,
  fetchImplementation = globalThis.fetch,
  stdout = process.stdout,
} = {}) {
  if (argv.length !== 0) fail();
  const cacheKey = await resolveStagingDeployRetry({
    environment,
    fetchImplementation,
  });
  stdout.write(`${cacheKey}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runResolveStagingDeployRetryCLI();
  } catch {
    process.stderr.write("Staging deploy retry resolution failed.\n");
    process.exitCode = 1;
  }
}
