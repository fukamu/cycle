import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveStagingDeployRetry,
  runResolveStagingDeployRetryCLI,
} from "../resolve-staging-deploy-retry.mjs";

const commitSHA = "a".repeat(40);
const cacheKey = `staging-deploy-retry-${commitSHA}-123-1`;

function environment(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "fukamu/cycle",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_ACTOR: "Owner",
    GITHUB_TRIGGERING_ACTOR: "owner",
    EXPECTED_APPROVER: "OWNER",
    COMMIT_SHA: commitSHA,
    DEPLOY_MODE: "normal",
    GH_TOKEN: "private-token",
    ...overrides,
  };
}

function sourceAttempt(overrides = {}) {
  return {
    id: 123,
    run_attempt: 1,
    name: "Deploy Staging",
    path: ".github/workflows/deploy.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    head_sha: commitSHA,
    head_branch: "main",
    repository: { full_name: "fukamu/cycle" },
    ...overrides,
  };
}

function response(value, { ok = true } = {}) {
  return {
    ok,
    async arrayBuffer() {
      return Buffer.from(
        typeof value === "string" ? value : JSON.stringify(value),
      );
    },
  };
}

function fakeFetch({ source = sourceAttempt() } = {}) {
  const calls = [];
  const implementation = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer private-token",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(
      url,
      "https://api.github.com/repos/fukamu/cycle/actions/runs/123/attempts/1",
    );
    return typeof source === "function" ? source() : response(source);
  };
  return { calls, implementation };
}

test("resolves the exact immutable cache key from failed attempt one", async () => {
  const fake = fakeFetch();
  assert.equal(
    await resolveStagingDeployRetry({
      environment: environment(),
      fetchImplementation: fake.implementation,
    }),
    cacheKey,
  );
  assert.equal(fake.calls.length, 1);
});

test("accepts the same strict provenance in recovery mode", async () => {
  const fake = fakeFetch();
  assert.equal(
    await resolveStagingDeployRetry({
      environment: environment({ DEPLOY_MODE: "recovery" }),
      fetchImplementation: fake.implementation,
    }),
    cacheKey,
  );
});

test("rejects attempts outside the single rerun and unauthorized actors", async () => {
  for (const overrides of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_API_URL: "https://example.com" },
    { GITHUB_REPOSITORY: "attacker/cycle" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ATTEMPT: "1" },
    { GITHUB_RUN_ATTEMPT: "3" },
    { GITHUB_ACTOR: "Attacker" },
    { GITHUB_TRIGGERING_ACTOR: "Attacker" },
    { EXPECTED_APPROVER: "bad--login" },
    {
      EXPECTED_APPROVER: "bad--login",
      GITHUB_ACTOR: "bad--login",
      GITHUB_TRIGGERING_ACTOR: "bad--login",
    },
    { COMMIT_SHA: "invalid" },
    { DEPLOY_MODE: "other" },
    { GH_TOKEN: "" },
  ]) {
    await assert.rejects(() =>
      resolveStagingDeployRetry({
        environment: environment(overrides),
        fetchImplementation: fakeFetch().implementation,
      }),
    );
  }
});

test("rejects any source attempt that is not the exact completed failure", async () => {
  for (const overrides of [
    { id: 124 },
    { id: "123" },
    { run_attempt: 2 },
    { name: "Deploy Staging Renamed" },
    { path: ".github/workflows/other.yml" },
    { event: "push" },
    { status: "in_progress" },
    { conclusion: "success" },
    { conclusion: "cancelled" },
    { conclusion: "timed_out" },
    { head_sha: "c".repeat(40) },
    { head_branch: "topic" },
    { repository: { full_name: "attacker/cycle" } },
  ]) {
    const fake = fakeFetch({ source: sourceAttempt(overrides) });
    await assert.rejects(() =>
      resolveStagingDeployRetry({
        environment: environment(),
        fetchImplementation: fake.implementation,
      }),
    );
    assert.equal(fake.calls.length, 1);
  }
});

test("fails closed on GitHub API, JSON, and response-size errors", async () => {
  for (const source of [
    () => response({}, { ok: false }),
    () => response("{"),
    () => response("x".repeat(64 * 1024 + 1)),
    () => {
      throw new Error("private network detail");
    },
  ]) {
    await assert.rejects(() =>
      resolveStagingDeployRetry({
        environment: environment(),
        fetchImplementation: fakeFetch({ source }).implementation,
      }),
    );
  }
});

test("CLI prints only the resolved public cache key", async () => {
  let output = "";
  await runResolveStagingDeployRetryCLI({
    environment: environment(),
    fetchImplementation: fakeFetch().implementation,
    stdout: { write: (value) => (output += value) },
  });
  assert.equal(output, `${cacheKey}\n`);
  assert.doesNotMatch(output, /private-token|Owner/);
  await assert.rejects(() =>
    runResolveStagingDeployRetryCLI({
      argv: ["unexpected"],
      environment: environment(),
      fetchImplementation: fakeFetch().implementation,
    }),
  );
});
