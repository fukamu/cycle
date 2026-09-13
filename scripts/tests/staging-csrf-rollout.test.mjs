import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatStagingCSRFRolloutDiagnostic,
  runStagingCSRFRollout,
  StagingCSRFRolloutFailure,
  stagingCSRFRolloutFailureReasons,
  stagingCSRFRolloutPhases,
  validateRolloutSession,
} from "../lib/staging-csrf-rollout.mjs";
import {
  captureStagingAnonymousSession,
  classifyStagingAnonymousSessionStatus,
  createStagingDeployAnonymousSessionRoute,
  markStagingDeployCleanupFromRevokedResult,
  prepareStagingBootstrapStorage,
  selectCloudflareDrainDiagnostic,
} from "../../frontend/e2e/staging-csrf-rollout-entry.mjs";
import { StagingCriticalFailure } from "../lib/staging-critical.mjs";

const userID = "0198c20b-7b95-7000-8000-000000000001";
const otherUserID = "0198c20b-7b95-7000-8000-000000000002";
const stableToken = "S".repeat(43);
const stableSession = { userID, csrfToken: stableToken };

test("establishes the canonical Staging origin before seeding IndexedDB", async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options]);
      return {
        status: () => 200,
        url: () => "https://cycle.staging.fukamu.matoruru.com/healthz",
      };
    },
    async evaluate(_operation, value) {
      calls.push(["evaluate", value]);
    },
  };
  await prepareStagingBootstrapStorage(
    page,
    "https://cycle.staging.fukamu.matoruru.com",
    userID,
  );
  assert.deepEqual(calls, [
    [
      "goto",
      "https://cycle.staging.fukamu.matoruru.com/healthz",
      { waitUntil: "domcontentloaded" },
    ],
    [
      "evaluate",
      {
        databaseName: "fukamu-cycle-bootstrap",
        storeName: "bootstrap",
        key: "pending",
        value: userID,
      },
    ],
  ]);
});

test("does not seed IndexedDB without an exact healthy Staging origin", async () => {
  for (const response of [
    null,
    {
      status: () => 503,
      url: () => "https://cycle.staging.fukamu.matoruru.com/healthz",
    },
    { status: () => 200, url: () => "https://example.com/healthz" },
  ]) {
    let evaluated = false;
    await assert.rejects(() =>
      prepareStagingBootstrapStorage(
        {
          async goto() {
            return response;
          },
          async evaluate() {
            evaluated = true;
          },
        },
        "https://cycle.staging.fukamu.matoruru.com",
        userID,
      ),
    );
    assert.equal(evaluated, false);
  }
});

test("classifies anonymous session HTTP failures without reading response bodies", async () => {
  const cases = [
    [400, "anonymous_session_bad_request"],
    [403, "anonymous_session_forbidden"],
    [429, "anonymous_session_rate_limited"],
    [500, "anonymous_session_unavailable"],
    [503, "anonymous_session_unavailable"],
    [302, "unexpected_status"],
  ];
  for (const [status, reason] of cases) {
    let bodyRead = false;
    const response = {
      url: () =>
        "https://cycle.staging.fukamu.matoruru.com/api/v1/session/anonymous",
      request: () => ({ method: () => "POST" }),
      status: () => status,
      async json() {
        bodyRead = true;
        throw new Error("private response body");
      },
    };
    await assert.rejects(
      captureStagingAnonymousSession({
        async waitForResponse(predicate, options) {
          assert.equal(predicate(response), true);
          assert.deepEqual(options, { timeout: 120_000 });
          return response;
        },
      }),
      (error) =>
        error instanceof StagingCriticalFailure &&
        error.phase === "entry" &&
        error.reason === reason &&
        !error.message.includes("private response body"),
    );
    assert.equal(bodyRead, false);
    assert.equal(classifyStagingAnonymousSessionStatus(status), reason);
  }
});

test("captures a successful anonymous session response", async () => {
  const response = {
    url: () =>
      "https://cycle.staging.fukamu.matoruru.com/api/v1/session/anonymous",
    request: () => ({ method: () => "POST" }),
    status: () => 201,
    headers: () => ({ "x-fukamu-authenticated-user-id": userID }),
    async json() {
      return {
        user: { id: userID, googleConnected: false, googleEmail: null },
        csrfToken: stableToken,
      };
    },
  };
  const session = await captureStagingAnonymousSession({
    async waitForResponse(predicate) {
      assert.equal(predicate(response), true);
      return response;
    },
  });
  assert.deepEqual(session, stableSession);
  assert.equal(classifyStagingAnonymousSessionStatus(201), undefined);
});

test("preserves closed candidate anonymous session failures after drain", async () => {
  for (const reason of [
    "anonymous_session_request_not_observed",
    "anonymous_session_bad_request",
    "anonymous_session_forbidden",
    "anonymous_session_rate_limited",
    "anonymous_session_unavailable",
  ]) {
    const fake = createFakeAdapter({
      async prepareCandidateSession() {
        fake.calls.push("prepare-candidate");
        throw new StagingCriticalFailure("entry", reason);
      },
    });
    const failures = await runFake(fake.adapter);
    assert.deepEqual(classifications(failures), [
      `candidate_session:${reason}`,
    ]);
    assert.equal(fake.calls.includes("deploy-drain"), true);
  }
});

test("writes the cleanup fence before releasing anonymous account creation", async () => {
  const calls = [];
  const checkpoint = createStagingDeployAnonymousSessionRoute({
    checkpointEnabled: true,
    markCleanupUnverified() {
      calls.push("cleanup-unverified");
    },
  });
  await checkpoint.handle({
    async continue() {
      calls.push("request-continued");
    },
    async abort() {
      calls.push("request-aborted");
    },
  });
  assert.deepEqual(calls, ["cleanup-unverified", "request-continued"]);
  assert.equal(checkpoint.failure(), undefined);
});

test("aborts anonymous account creation when the cleanup fence cannot be written", async () => {
  const calls = [];
  const checkpointFailure = new Error("private checkpoint detail");
  const checkpoint = createStagingDeployAnonymousSessionRoute({
    checkpointEnabled: true,
    markCleanupUnverified() {
      calls.push("cleanup-unverified");
      throw checkpointFailure;
    },
  });
  await checkpoint.handle({
    async continue() {
      calls.push("request-continued");
    },
    async abort(reason) {
      calls.push(`request-aborted:${reason}`);
    },
  });
  assert.deepEqual(calls, ["cleanup-unverified", "request-aborted:failed"]);
  assert.equal(checkpoint.failure(), checkpointFailure);
});

test("marks cleanup verified only from the exact revoked-session proof", () => {
  const verified = [];
  const record = (result, checkpointEnabled = true) =>
    markStagingDeployCleanupFromRevokedResult(result, {
      checkpointEnabled,
      markCleanupVerified() {
        verified.push(result);
      },
    });
  const exact = {
    status: 401,
    code: "SESSION_EXPIRED",
    authenticatedUserIDAbsent: true,
  };
  record(exact);
  record({ ...exact, status: 403 });
  record({ ...exact, code: "SESSION_MISSING" });
  record({ ...exact, authenticatedUserIDAbsent: false });
  record(exact, false);
  assert.deepEqual(verified, [exact]);
});

test("accepts only UUIDv7 identities and exact base64url CSRF tokens", () => {
  assert.deepEqual(validateRolloutSession(stableSession), stableSession);
  for (const invalid of [
    {
      userID: otherUserID.replace("7b95-7", "7b95-6"),
      csrfToken: stableToken,
    },
    { userID, csrfToken: "short" },
    { userID, csrfToken: `${"A".repeat(42)}=` },
    { userID, csrfToken: `${"A".repeat(42)}+` },
  ]) {
    assert.throws(
      () => validateRolloutSession(invalid),
      (error) =>
        error instanceof StagingCSRFRolloutFailure &&
        error.phase === "candidate_session" &&
        error.reason === "stable_token_invalid" &&
        !error.message.includes(userID) &&
        !error.message.includes(stableToken),
    );
  }
});

test("runs the one-time candidate rollout after deploy and drain", async () => {
  const fake = createFakeAdapter();
  const failures = await runFake(fake.adapter);
  assert.deepEqual(failures, []);
  assert.deepEqual(fake.calls, [
    "launch",
    "deploy-drain",
    "prepare-candidate",
    "capture-probe",
    "prepare-tab-b",
    "candidate-unsafe",
    "discover-both",
    "reload-a",
    "autosave-a",
    "command-a",
    "command-b",
    "autosave-b",
    "reject:invalid_token",
    "reject:invalid_origin",
    "close-pages",
    "discover-cleanup",
    "delete-candidate",
    "verify-revoked",
    "close",
  ]);
  assert.deepEqual(fake.deletedSessions, [stableSession]);
});

test("does not create a candidate session when deploy or drain fails", async () => {
  const fake = createFakeAdapter({
    async runDeployAndDrain() {
      fake.calls.push("deploy-drain");
      throw new Error("private provider response");
    },
  });
  const failures = await runFake(fake.adapter);
  assert.deepEqual(classifications(failures), [
    "deploy_and_drain:deploy_or_drain_failed",
  ]);
  assert.equal(fake.calls.includes("prepare-candidate"), false);
  assert.equal(fake.calls.includes("discover-both"), false);
  assert.deepEqual(fake.deletedSessions, []);
});

test("fails closed when the candidate session cannot be created", async () => {
  const fake = createFakeAdapter({
    async prepareCandidateSession() {
      fake.calls.push("prepare-candidate");
      throw new Error("private browser response");
    },
  });
  const failures = await runFake(fake.adapter);
  assert.deepEqual(classifications(failures), [
    "candidate_session:unexpected_status",
  ]);
  assert.equal(fake.calls.includes("deploy-drain"), true);
  assert.equal(fake.calls.includes("discover-both"), false);
  assert.deepEqual(fake.deletedSessions, []);
});

test("cleans a known candidate identity when its captured token is malformed", async () => {
  const fake = createFakeAdapter({
    async prepareCandidateSession() {
      fake.calls.push("prepare-candidate");
      return { userID, csrfToken: "malformed" };
    },
  });
  const failures = await runFake(fake.adapter);
  assert.deepEqual(classifications(failures), [
    "candidate_session:stable_token_invalid",
  ]);
  assert.deepEqual(fake.deletedSessions, [stableSession]);
  assert.equal(fake.calls.includes("prepare-tab-b"), false);
});

test("keeps the active operation phase when an adapter reports failure", async () => {
  const fake = createFakeAdapter({
    async runTabAAutosave() {
      fake.calls.push("autosave-a");
      return false;
    },
  });
  const failures = await runFake(fake.adapter);
  assert.deepEqual(classifications(failures), [
    "tab_a_autosave:unexpected_status",
  ]);
  assert.equal(fake.calls.includes("command-a"), false);
  assert.deepEqual(fake.deletedSessions, [stableSession]);
});

test("never selects a rediscovered different identity for deletion", async () => {
  let cleanupDiscoveries = 0;
  const fake = createFakeAdapter({
    async discoverTwoTabsConcurrently() {
      fake.calls.push("discover-both");
      return [stableSession, { userID: otherUserID, csrfToken: stableToken }];
    },
    async discoverForCleanup() {
      fake.calls.push("discover-cleanup");
      cleanupDiscoveries += 1;
      return { userID: otherUserID, csrfToken: "O".repeat(43) };
    },
  });
  const failures = await runFake(fake.adapter);
  assert.deepEqual(classifications(failures), [
    "two_tab_convergence:session_identity_changed",
    "account_delete:session_identity_changed",
  ]);
  assert.equal(cleanupDiscoveries, 1);
  assert.deepEqual(fake.deletedSessions, [stableSession]);
  assert.equal(
    fake.deletedSessions.some((session) => session.userID === otherUserID),
    false,
  );
});

test("requires exact CSRF and revoked-session error contracts", async () => {
  const fake = createFakeAdapter({
    async verifyCSRFRejection(kind) {
      fake.calls.push(`reject:${kind}`);
      return kind === "invalid_token"
        ? {
            status: 403,
            code: "PRIVATE_DETAIL",
            authenticatedUserIDVerified: true,
          }
        : csrfRejection();
    },
  });
  const failures = await runFake(fake.adapter);
  assert.deepEqual(classifications(failures), [
    "security_rejections:security_rejection_invalid",
  ]);
  assert.equal(fake.calls.includes("reject:invalid_origin"), false);
  assert.deepEqual(fake.deletedSessions, [stableSession]);

  const revokedFake = createFakeAdapter({
    async verifyRevokedSession() {
      revokedFake.calls.push("verify-revoked");
      return {
        status: 401,
        code: "SESSION_MISSING",
        authenticatedUserIDAbsent: true,
      };
    },
  });
  const revokedFailures = await runFake(revokedFake.adapter);
  assert.deepEqual(classifications(revokedFailures), [
    "cleanup_verification:cleanup_unverified",
  ]);
});

test("retries deletion but records only closed diagnostic values", async () => {
  let attempts = 0;
  const fake = createFakeAdapter({
    async deleteCandidateAccount(session) {
      fake.calls.push("delete-candidate");
      fake.deletedSessions.push(session);
      attempts += 1;
      if (attempts === 1) return { status: 503 };
      return { status: 204, authenticatedUserIDVerified: true };
    },
  });
  assert.deepEqual(await runFake(fake.adapter, [0]), []);
  assert.equal(attempts, 2);

  const failure = new StagingCSRFRolloutFailure(
    "security_rejections",
    "security_rejection_invalid",
  );
  const diagnostic = formatStagingCSRFRolloutDiagnostic(failure, {
    runID: "123",
    runAttempt: "2",
    commitSHA: "a".repeat(40),
  });
  assert.equal(
    diagnostic,
    `::error::Staging CSRF rollout failed; phase=security_rejections; reason=security_rejection_invalid; run_id=123; run_attempt=2; commit_sha=${"a".repeat(40)}.`,
  );
  assert.doesNotMatch(diagnostic, /L{10}|S{10}|0198c20b/);
  assert.throws(
    () => new StagingCSRFRolloutFailure("private", "private"),
    /classification is invalid/,
  );
  assert.equal(
    new Set(stagingCSRFRolloutPhases).size,
    stagingCSRFRolloutPhases.length,
  );
  assert.equal(
    new Set(stagingCSRFRolloutFailureReasons).size,
    stagingCSRFRolloutFailureReasons.length,
  );
});

test("reports adapter cleanup failure without hiding prior failures", async () => {
  const fake = createFakeAdapter({
    async runTabAAutosave() {
      fake.calls.push("autosave-a");
      return false;
    },
    async close() {
      fake.calls.push("close");
      throw new Error("private cleanup detail");
    },
  });
  const failures = await runFake(fake.adapter);
  assert.deepEqual(classifications(failures), [
    "tab_a_autosave:unexpected_status",
    "cleanup_verification:cleanup_unverified",
  ]);
});

test("keeps browser evidence memory-only and invokes one fixed child adapter", () => {
  const harness = readFileSync(
    fileURLToPath(
      new URL("../../frontend/e2e/staging-csrf-rollout.mjs", import.meta.url),
    ),
    "utf8",
  );
  const entry = readFileSync(
    fileURLToPath(
      new URL(
        "../../frontend/e2e/staging-csrf-rollout-entry.mjs",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const browserSources = `${harness}\n${entry}`;
  assert.doesNotMatch(browserSources, /\bconsole\./);
  assert.doesNotMatch(
    browserSources,
    /\b(?:recordVideo|screenshot|trace:|tracing\.|storageState)\b/,
  );
  assert.doesNotMatch(browserSources, /stdio:\s*["']inherit["']/);
  assert.match(
    entry,
    /stdio:\s*\[["']ignore["'], ["']ignore["'], ["']pipe["']\]/,
  );
  assert.match(entry, /detached:\s*true/);
  assert.match(entry, /process\.kill\(-child\.pid, signal\)/);
  assert.match(entry, /process\.kill\(-child\.pid, 0\)/);
  assert.match(entry, /env:\s*\{ LANG: ["']C\.UTF-8["'], TZ: ["']UTC["'] \}/);
  assert.match(
    entry,
    /["']\.\/scripts\/run-staging-candidate-deploy-and-drain\.sh["']/,
  );
  assert.match(entry, /Object\.defineProperty\(globalThis, "BroadcastChannel"/);
  assert.match(entry, /const \[sessionA, sessionB\] = await Promise\.all/);
  assert.doesNotMatch(entry, /process\.env\.STAGING_E2E_INVITE_TOKEN/);
  assert.doesNotMatch(entry, /process\.env/);
  assert.equal(
    harness.match(/process\.env\.STAGING_E2E_INVITE_TOKEN/g)?.length,
    2,
  );
  for (const name of [
    "DEBUG",
    "NODE_DEBUG",
    "NODE_OPTIONS",
    "PWDEBUG",
    "STAGING_E2E_INVITE_TOKEN",
  ]) {
    assert.match(harness, new RegExp(`delete process\\.env\\.${name}`));
  }
});

test("forwards only one closed Cloudflare drain diagnostic", () => {
  const diagnostic = `::error::Cloudflare drain evidence failed; phase=baseline; reason=invalid_evidence; run_id=123; run_attempt=2; commit_sha=${"a".repeat(40)}.`;
  assert.equal(
    selectCloudflareDrainDiagnostic(
      `private provider output\n${diagnostic}\nStaging candidate deployment failed\n`,
    ),
    diagnostic,
  );
  for (const invalid of [
    "private provider output",
    `${diagnostic}\n${diagnostic}\n`,
    `${diagnostic}\n${"x".repeat(4 * 1024)}\n`,
  ]) {
    assert.equal(selectCloudflareDrainDiagnostic(invalid), undefined);
  }
});

function createFakeAdapter(overrides = {}) {
  const calls = [];
  const deletedSessions = [];
  const adapter = {
    async launch() {
      calls.push("launch");
    },
    async prepareCandidateSession() {
      calls.push("prepare-candidate");
      return stableSession;
    },
    async captureRevokedSessionProbe() {
      calls.push("capture-probe");
    },
    async prepareSecondTab() {
      calls.push("prepare-tab-b");
    },
    async runCandidateUnsafeRequest() {
      calls.push("candidate-unsafe");
      return true;
    },
    async runDeployAndDrain() {
      calls.push("deploy-drain");
    },
    async discoverTwoTabsConcurrently() {
      calls.push("discover-both");
      return [stableSession, stableSession];
    },
    async reloadTabAAndDiscover() {
      calls.push("reload-a");
      return stableSession;
    },
    async runTabAAutosave() {
      calls.push("autosave-a");
      return true;
    },
    async runTabACommand() {
      calls.push("command-a");
      return true;
    },
    async runTabBCommand() {
      calls.push("command-b");
      return true;
    },
    async runTabBAutosave() {
      calls.push("autosave-b");
      return true;
    },
    async verifyCSRFRejection(kind) {
      calls.push(`reject:${kind}`);
      return csrfRejection();
    },
    async closePages() {
      calls.push("close-pages");
    },
    async discoverForCleanup() {
      calls.push("discover-cleanup");
      return stableSession;
    },
    async deleteCandidateAccount(session) {
      calls.push("delete-candidate");
      deletedSessions.push(session);
      return { status: 204, authenticatedUserIDVerified: true };
    },
    async verifyRevokedSession() {
      calls.push("verify-revoked");
      return {
        status: 401,
        code: "SESSION_EXPIRED",
        authenticatedUserIDAbsent: true,
      };
    },
    async close() {
      calls.push("close");
    },
    ...overrides,
  };
  return { calls, deletedSessions, adapter };
}

function csrfRejection() {
  return {
    status: 403,
    code: "CSRF_INVALID",
    authenticatedUserIDVerified: true,
  };
}

async function runFake(adapter, retryDelaysMilliseconds = []) {
  return runStagingCSRFRollout({
    adapter,
    retryOptions: {
      retryDelaysMilliseconds,
      sleep: async () => undefined,
    },
  });
}

function classifications(failures) {
  return failures.map(({ phase, reason }) => `${phase}:${reason}`);
}
