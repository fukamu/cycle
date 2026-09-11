import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enterStagingCritical } from "../../frontend/e2e/staging-critical-entry.mjs";
import {
  deriveBootstrapUUIDv7,
  formatStagingCriticalDiagnostic,
  parseAnonymousSession,
  parseStagingAdmissionMode,
  parseStagingBaseURL,
  parseStagingCriticalMode,
  retryPublicAccountDelete,
  runStagingCritical,
  stagingCriticalCleanupStates,
  stagingCriticalExecution,
  StagingCriticalFailure,
  stagingCriticalFailureReasons,
  stagingCriticalPhases,
  validateStagingInviteToken,
} from "../lib/staging-critical.mjs";

const canonicalBaseURL = "https://cycle.staging.fukamu.matoruru.com";
const userID = "0198c20b-7b95-7000-8000-000000000001";
const otherUserID = "0198c20b-7b95-7000-8000-000000000002";

test("accepts only the canonical staging origin without exposing rejected input", () => {
  assert.equal(parseStagingBaseURL(canonicalBaseURL), canonicalBaseURL);
  for (const invalid of [
    `${canonicalBaseURL}/`,
    "http://cycle.staging.fukamu.matoruru.com",
    "https://user@cycle.staging.fukamu.matoruru.com",
    "https://cycle.staging.fukamu.matoruru.com/path",
    " https://cycle.staging.fukamu.matoruru.com",
  ]) {
    assert.throws(
      () => parseStagingBaseURL(invalid),
      (error) =>
        error instanceof Error &&
        error.message === "staging base URL is not canonical" &&
        !error.message.includes(invalid),
    );
  }
});

test("validates the generated invite-token contract without echoing candidates", () => {
  const token = `fukamu_cycle_beta_${"A".repeat(43)}`;
  assert.equal(validateStagingInviteToken(token), token);
  const invalid = `${token}private-suffix`;
  assert.throws(
    () => validateStagingInviteToken(invalid),
    (error) =>
      error instanceof Error &&
      error.message === "staging invite token is invalid" &&
      !error.message.includes(invalid),
  );
});

test("derives a deterministic UUIDv7 with the supplied stable timestamp", () => {
  const timestamp = Date.UTC(2026, 7, 26, 12, 34, 56);
  const first = deriveBootstrapUUIDv7("owner/repository:123:commit", timestamp);
  const second = deriveBootstrapUUIDv7(
    "owner/repository:123:commit",
    timestamp,
  );
  const different = deriveBootstrapUUIDv7(
    "owner/repository:124:commit",
    timestamp,
  );
  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    Number.parseInt(first.replaceAll("-", "").slice(0, 12), 16),
    timestamp,
  );
  assert.throws(() => deriveBootstrapUUIDv7("", timestamp));
  assert.throws(() => deriveBootstrapUUIDv7("run\0key", timestamp));
  assert.throws(() => deriveBootstrapUUIDv7("run", -1));
});

test("accepts only closed staging mode enums", () => {
  assert.equal(parseStagingCriticalMode("preflight"), "preflight");
  assert.equal(parseStagingCriticalMode("baseline"), "baseline");
  assert.equal(parseStagingCriticalMode("full"), "full");
  assert.equal(parseStagingAdmissionMode("auto"), "auto");
  assert.equal(parseStagingAdmissionMode("off"), "off");
  assert.equal(parseStagingAdmissionMode("closed"), "closed");
  assert.throws(() => parseStagingCriticalMode("private-mode"));
  assert.throws(() => parseStagingAdmissionMode("private-mode"));
  assert.throws(
    () => new StagingCriticalFailure("private-phase", "unexpected_status"),
  );
});

test("accepts only an anonymous session bound to its response identity", () => {
  const payload = {
    user: {
      id: userID,
      googleConnected: false,
      googleEmail: null,
    },
    csrfToken: "csrf-private-value",
  };
  assert.deepEqual(parseAnonymousSession(payload, userID), {
    userID,
    csrfToken: "csrf-private-value",
  });

  for (const invalid of [
    [payload, "0198c20b-7b95-7000-8000-000000000002"],
    [{ ...payload, csrfToken: "" }, userID],
    [
      {
        ...payload,
        user: { ...payload.user, googleConnected: true },
      },
      userID,
    ],
  ]) {
    assert.throws(
      () => parseAnonymousSession(invalid[0], invalid[1]),
      (error) =>
        error instanceof Error &&
        error.message === "staging session response is invalid" &&
        !error.message.includes(userID) &&
        !error.message.includes("csrf-private-value"),
    );
  }
});

test("keeps the browser harness free of secret-bearing diagnostics and artifacts", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../frontend/e2e/staging-critical.mjs", import.meta.url),
    ),
    "utf8",
  );
  const entrySource = readFileSync(
    fileURLToPath(
      new URL("../../frontend/e2e/staging-critical-entry.mjs", import.meta.url),
    ),
    "utf8",
  );
  const browserSources = `${source}\n${entrySource}`;
  assert.doesNotMatch(browserSources, /\bconsole\./);
  assert.doesNotMatch(
    browserSources,
    /\b(?:recordVideo|screenshot|trace:|tracing\.)\b/,
  );
  assert.doesNotMatch(browserSources, /\bcatch\s*\(\s*[A-Za-z_$]/);
  assert.equal(
    source.match(/process\.env\.STAGING_E2E_INVITE_TOKEN/g)?.length,
    4,
  );
  for (const name of [
    "DEBUG",
    "NODE_DEBUG",
    "NODE_OPTIONS",
    "PWDEBUG",
    "STAGING_E2E_INVITE_TOKEN",
  ]) {
    assert.match(source, new RegExp(`delete process\\.env\\.${name}`));
  }

  const cleanup = source.slice(
    source.indexOf("async function deleteAccount("),
    source.indexOf("async function sessionStatus("),
  );
  assert.notEqual(cleanup, "");
  assert.doesNotMatch(cleanup, /response\.(?:body|json|text)\(/);
});

function withBrowserGlobals(location, history, callback) {
  assert.equal(Object.hasOwn(globalThis, "location"), false);
  assert.equal(Object.hasOwn(globalThis, "history"), false);
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: location,
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: history,
  });
  try {
    return callback();
  } finally {
    delete globalThis.location;
    delete globalThis.history;
  }
}

function entryFixture(currentMode) {
  const calls = [];
  const location = { pathname: "/", search: "?source=staging", hash: "" };
  let injectedURL = "";
  const history = {
    state: null,
    replaceState(_state, _unused, nextURL) {
      injectedURL = nextURL;
      const hashStart = nextURL.indexOf("#");
      location.hash = hashStart === -1 ? "" : nextURL.slice(hashStart);
    },
  };
  const newGoalButton = {
    async waitFor(options) {
      assert.deepEqual(options, { state: "visible" });
      calls.push("wait-new-goal");
    },
  };
  const admissionButton = {
    or(candidate) {
      assert.equal(candidate, newGoalButton);
      return {
        first() {
          return {
            async waitFor(options) {
              assert.deepEqual(options, { state: "visible" });
              calls.push("wait-entry-cta");
            },
          };
        },
      };
    },
    async isVisible() {
      return currentMode === "closed";
    },
    async click() {
      calls.push("click-admission");
    },
  };
  return {
    calls,
    get injectedURL() {
      return injectedURL;
    },
    context: {
      async addInitScript(callback, argument) {
        calls.push("install-fragment");
        withBrowserGlobals(location, history, () => callback(argument));
      },
    },
    page: {
      async goto(URL, options) {
        assert.equal(URL, canonicalBaseURL);
        assert.deepEqual(options, { waitUntil: "domcontentloaded" });
        calls.push("goto");
        if (location.hash.includes("beta-invite")) {
          location.hash = "";
          calls.push("consume-fragment");
        }
      },
      getByRole(role, options) {
        assert.equal(role, "button");
        if (options.name === "\u5229\u7528\u3092\u958b\u59cb\u3059\u308b") {
          return admissionButton;
        }
        assert.equal(
          options.name,
          "\u65b0\u3057\u3044\u76ee\u6a19\u3092\u8a2d\u5b9a",
        );
        return newGoalButton;
      },
      async waitForFunction(callback) {
        calls.push("wait-fragment-cleared");
        assert.equal(
          withBrowserGlobals(location, history, () => callback()),
          true,
        );
      },
    },
  };
}

function fakeAdapter(overrides = {}) {
  const calls = [];
  const session = { userID, csrfToken: "private-csrf-token" };
  return {
    calls,
    adapter: {
      async launch() {
        calls.push("launch");
      },
      async checkHealth() {
        calls.push("health");
        return 200;
      },
      async checkReadiness() {
        calls.push("readiness");
        return 200;
      },
      async seedBootstrap() {
        calls.push("seed");
      },
      async enter(admissionMode) {
        calls.push(`entry:${admissionMode}`);
        return session;
      },
      async discoverSession() {
        calls.push("discover");
        return session;
      },
      async runFullJourney(setPhase) {
        calls.push("full");
        setPhase("goal_creation");
      },
      async beforeCleanup() {
        calls.push("before-cleanup");
      },
      async deleteAccount(currentSession) {
        calls.push("delete");
        assert.equal(currentSession, session);
        return { status: 204, authenticatedUserIDVerified: true };
      },
      async verifyDeleted() {
        calls.push("verify");
        return 401;
      },
      async close() {
        calls.push("close");
      },
      ...overrides,
    },
  };
}

async function runFake(mode, admissionMode, overrides = {}) {
  const fake = fakeAdapter(overrides);
  const result = await runStagingCritical({
    mode,
    admissionMode,
    adapter: fake.adapter,
    retryOptions: {
      retryDelaysMilliseconds: [],
      sleep: async () => undefined,
    },
  });
  return { ...fake, ...result };
}

test("limits the blocking preflight to health and readiness", async () => {
  const { calls, failures, cleanupState } = await runFake(
    "preflight",
    undefined,
  );
  assert.deepEqual(failures, []);
  assert.equal(cleanupState, "not_applicable");
  assert.deepEqual(calls, ["launch", "health", "readiness", "close"]);
});

test("fails the preflight before any anonymous operation", async () => {
  const unhealthy = await runFake("preflight", undefined, {
    async checkHealth() {
      return 503;
    },
  });
  assert.deepEqual(
    unhealthy.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "health", reason: "unexpected_status" }],
  );
  assert.equal(unhealthy.cleanupState, "not_applicable");
  assert.deepEqual(unhealthy.calls, ["launch", "close"]);

  const unready = await runFake("preflight", undefined, {
    async checkReadiness() {
      return 503;
    },
  });
  assert.deepEqual(
    unready.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "readiness", reason: "unexpected_status" }],
  );
  assert.equal(unready.cleanupState, "not_applicable");
  assert.deepEqual(unready.calls, ["launch", "health", "close"]);
});

test("runs off and closed baselines with discovery and public cleanup", async () => {
  for (const admissionMode of ["off", "closed"]) {
    const { calls, failures, cleanupState } = await runFake(
      "baseline",
      admissionMode,
    );
    assert.deepEqual(failures, []);
    assert.equal(cleanupState, "verified");
    assert.deepEqual(calls, [
      "launch",
      "health",
      "readiness",
      "seed",
      `entry:${admissionMode}`,
      "discover",
      "before-cleanup",
      "discover",
      "delete",
      "verify",
      "close",
    ]);
    assert.equal(calls.includes("full"), false);
  }
});

test("auto entry follows the current UI across candidate admission transitions", async (t) => {
  for (const currentMode of ["off", "closed"]) {
    for (const candidateMode of ["off", "closed"]) {
      await t.test(`${currentMode} -> ${candidateMode}`, async () => {
        const fixture = entryFixture(currentMode);
        const session = {
          userID,
          csrfToken: "private-csrf-token",
        };
        const result = await enterStagingCritical({
          context: fixture.context,
          page: fixture.page,
          baseURL: canonicalBaseURL,
          admissionMode: "auto",
          inviteToken: `fukamu_cycle_beta_${"A".repeat(43)}`,
          captureAnonymousSession() {
            fixture.calls.push("capture-session");
            return Promise.resolve(session);
          },
        });
        assert.equal(result, session);
        assert.match(
          fixture.injectedURL,
          /^\/\?source=staging#beta-invite=fukamu_cycle_beta_/,
        );
        assert.deepEqual(fixture.calls, [
          "install-fragment",
          "capture-session",
          "goto",
          "consume-fragment",
          "wait-entry-cta",
          "wait-fragment-cleared",
          ...(currentMode === "closed" ? ["click-admission"] : []),
          "wait-new-goal",
        ]);
      });
    }
  }
});

test("off entry skips invite handling and opens New Goal directly", async () => {
  const fixture = entryFixture("off");
  const session = { userID, csrfToken: "private-csrf-token" };
  const result = await enterStagingCritical({
    context: fixture.context,
    page: fixture.page,
    baseURL: canonicalBaseURL,
    admissionMode: "off",
    inviteToken: "",
    captureAnonymousSession() {
      fixture.calls.push("capture-session");
      return Promise.resolve(session);
    },
  });
  assert.equal(result, session);
  assert.equal(fixture.injectedURL, "");
  assert.deepEqual(fixture.calls, [
    "capture-session",
    "goto",
    "wait-entry-cta",
    "wait-new-goal",
  ]);
});

test("retains the post-deploy full journey", async () => {
  const { calls, failures, cleanupState } = await runFake("full", "closed");
  assert.deepEqual(failures, []);
  assert.equal(cleanupState, "verified");
  assert.equal(calls.includes("full"), true);
  assert.ok(calls.indexOf("full") < calls.indexOf("before-cleanup"));
});

test("keeps candidate cleanup hard after a full journey failure", async () => {
  const result = await runFake("full", "closed", {
    async runFullJourney(setPhase) {
      setPhase("review_transition");
      throw new Error("private candidate response body");
    },
  });
  assert.deepEqual(
    result.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "review_transition", reason: "unexpected_status" }],
  );
  assert.equal(result.cleanupState, "verified");
  assert.ok(result.calls.indexOf("delete") < result.calls.indexOf("verify"));
});

test("maps entry and anonymous bootstrap failures to closed reasons and still cleans", async () => {
  const timedOut = await runFake("baseline", "off", {
    async enter() {
      throw new StagingCriticalFailure("entry", "entry_cta_timeout");
    },
  });
  assert.deepEqual(
    timedOut.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "entry", reason: "entry_cta_timeout" }],
  );
  assert.equal(timedOut.cleanupState, "verified");
  assert.equal(timedOut.calls.includes("delete"), true);

  const notObserved = await runFake("baseline", "closed", {
    async enter() {
      return undefined;
    },
  });
  assert.deepEqual(
    notObserved.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "entry", reason: "anonymous_session_not_observed" }],
  );
  assert.equal(notObserved.cleanupState, "verified");
  assert.equal(notObserved.calls.includes("delete"), true);
});

test("fails closed when public deletion or the final 401 proof fails", async () => {
  const deletionFailure = await runFake("baseline", "off", {
    async deleteAccount() {
      throw new Error("private body https://example.invalid/?token=secret");
    },
  });
  assert.deepEqual(
    deletionFailure.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "account_delete", reason: "account_delete_failed" }],
  );
  assert.equal(deletionFailure.cleanupState, "unverified");

  const proofFailure = await runFake("baseline", "off", {
    async verifyDeleted() {
      return 200;
    },
  });
  assert.deepEqual(
    proofFailure.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "cleanup_verification", reason: "cleanup_unverified" }],
  );
  assert.equal(proofFailure.cleanupState, "unverified");
});

test("uses the validated session for cleanup when rediscovery fails", async () => {
  const validatedSession = {
    userID,
    csrfToken: "private-validated-csrf-token",
  };
  let discoveryCount = 0;
  let deletedSession;
  const fake = fakeAdapter({
    async discoverSession() {
      fake.calls.push("discover");
      discoveryCount += 1;
      if (discoveryCount === 2) {
        throw new Error("private transient discovery detail");
      }
      return validatedSession;
    },
    async deleteAccount(currentSession) {
      fake.calls.push("delete");
      deletedSession = currentSession;
      return { status: 204, authenticatedUserIDVerified: true };
    },
  });
  const { failures, cleanupState } = await runStagingCritical({
    mode: "baseline",
    admissionMode: "auto",
    adapter: fake.adapter,
    retryOptions: {
      retryDelaysMilliseconds: [],
      sleep: async () => undefined,
    },
  });
  assert.equal(cleanupState, "verified");
  assert.deepEqual(
    failures.map(({ phase, reason }) => ({ phase, reason })),
    [
      {
        phase: "session_discovery",
        reason: "session_discovery_failed",
      },
    ],
  );
  assert.equal(deletedSession, validatedSession);
  assert.ok(fake.calls.indexOf("delete") < fake.calls.indexOf("verify"));
});

test("never promotes a mismatched initial discovery to the deletion target", async () => {
  const capturedSession = {
    userID,
    csrfToken: "private-captured-csrf-token",
  };
  const mismatchedSession = {
    userID: otherUserID,
    csrfToken: "private-other-csrf-token",
  };
  let deletedSession;
  const fake = fakeAdapter({
    async enter() {
      fake.calls.push("entry:auto");
      return capturedSession;
    },
    async discoverSession() {
      fake.calls.push("discover");
      return mismatchedSession;
    },
    async deleteAccount(currentSession) {
      fake.calls.push("delete");
      deletedSession = currentSession;
      return { status: 204, authenticatedUserIDVerified: true };
    },
  });
  const { failures, cleanupState } = await runStagingCritical({
    mode: "baseline",
    admissionMode: "auto",
    adapter: fake.adapter,
    retryOptions: {
      retryDelaysMilliseconds: [],
      sleep: async () => undefined,
    },
  });
  assert.equal(cleanupState, "verified");
  assert.deepEqual(
    failures.map(({ phase, reason }) => ({ phase, reason })),
    [
      {
        phase: "session_discovery",
        reason: "session_discovery_failed",
      },
    ],
  );
  assert.equal(deletedSession, capturedSession);
  assert.notEqual(deletedSession, mismatchedSession);
});

test("never promotes a mismatched cleanup discovery after validation", async () => {
  const capturedSession = {
    userID,
    csrfToken: "private-captured-csrf-token",
  };
  const validatedSession = {
    userID,
    csrfToken: "private-validated-csrf-token",
  };
  const mismatchedSession = {
    userID: otherUserID,
    csrfToken: "private-other-csrf-token",
  };
  let discoveryCount = 0;
  let deletedSession;
  const fake = fakeAdapter({
    async enter() {
      fake.calls.push("entry:auto");
      return capturedSession;
    },
    async discoverSession() {
      fake.calls.push("discover");
      discoveryCount += 1;
      return discoveryCount === 1 ? validatedSession : mismatchedSession;
    },
    async deleteAccount(currentSession) {
      fake.calls.push("delete");
      deletedSession = currentSession;
      return { status: 204, authenticatedUserIDVerified: true };
    },
  });
  const { failures, cleanupState } = await runStagingCritical({
    mode: "baseline",
    admissionMode: "auto",
    adapter: fake.adapter,
    retryOptions: {
      retryDelaysMilliseconds: [],
      sleep: async () => undefined,
    },
  });
  assert.equal(cleanupState, "verified");
  assert.deepEqual(
    failures.map(({ phase, reason }) => ({ phase, reason })),
    [
      {
        phase: "session_discovery",
        reason: "session_discovery_failed",
      },
    ],
  );
  assert.equal(deletedSession, validatedSession);
  assert.notEqual(deletedSession, mismatchedSession);
});

test("classifies health and session discovery failures without exception details", async () => {
  const unhealthy = await runFake("baseline", "off", {
    async checkHealth() {
      throw new Error("private upstream response body");
    },
  });
  assert.deepEqual(
    unhealthy.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "health", reason: "unexpected_status" }],
  );
  assert.equal(unhealthy.cleanupState, "not_started");

  const discoveryFailure = await runFake("baseline", "closed", {
    async discoverSession() {
      throw new Error("private cookie and account id");
    },
  });
  assert.deepEqual(
    discoveryFailure.failures.map(({ phase, reason }) => ({ phase, reason })),
    [
      {
        phase: "session_discovery",
        reason: "session_discovery_failed",
      },
    ],
  );
});

test("formats only closed-enum diagnostics and validated run metadata", () => {
  const privateValues = [
    "https://example.invalid/path?token=secret#fragment",
    "private-invite-token",
    "private-turnstile-token",
    "private-csrf-token",
    "private-cookie-and-session",
    "private-request-and-response-body",
    userID,
  ];
  const line = formatStagingCriticalDiagnostic(
    new StagingCriticalFailure("entry", "entry_cta_timeout"),
    {
      runID: "123",
      runAttempt: "2",
      commitSHA: "a".repeat(40),
      target: "current-public",
      mutationStarted: false,
      diagnosticLevel: "warning",
      cleanupState: "unverified",
    },
  );
  assert.equal(
    line,
    `::warning::Staging critical diagnostic failed; target=current-public; mutation_started=false; cleanup_state=unverified; phase=entry; reason=entry_cta_timeout; run_id=123; run_attempt=2; candidate_sha=${"a".repeat(40)}.`,
  );
  const candidateLine = formatStagingCriticalDiagnostic(
    new StagingCriticalFailure("cleanup_verification", "cleanup_unverified"),
    {
      runID: "123",
      runAttempt: "2",
      commitSHA: "a".repeat(40),
      target: "candidate-public",
      mutationStarted: true,
      diagnosticLevel: "error",
      cleanupState: "unverified",
    },
  );
  assert.equal(
    candidateLine,
    `::error::Staging critical failed; target=candidate-public; mutation_started=true; cleanup_state=unverified; phase=cleanup_verification; reason=cleanup_unverified; run_id=123; run_attempt=2; candidate_sha=${"a".repeat(40)}.`,
  );
  for (const value of privateValues) assert.equal(line.includes(value), false);
  assert.deepEqual(stagingCriticalFailureReasons, [
    "entry_cta_timeout",
    "anonymous_session_not_observed",
    "unexpected_status",
    "session_discovery_failed",
    "account_delete_failed",
    "cleanup_unverified",
  ]);
  assert.deepEqual(stagingCriticalPhases, [
    "configuration",
    "browser_launch",
    "health",
    "readiness",
    "bootstrap_seed",
    "entry",
    "session_discovery",
    "goal_creation",
    "cycle_editing",
    "cycle_completion",
    "review_transition",
    "history_verification",
    "account_delete",
    "cleanup_verification",
  ]);
  assert.deepEqual(stagingCriticalCleanupStates, [
    "not_applicable",
    "not_started",
    "unverified",
    "verified",
  ]);
  assert.deepEqual(stagingCriticalExecution("preflight"), {
    target: "current-public",
    mutationStarted: false,
    diagnosticLevel: "error",
  });
  assert.deepEqual(stagingCriticalExecution("baseline"), {
    target: "current-public",
    mutationStarted: false,
    diagnosticLevel: "warning",
  });
  assert.deepEqual(stagingCriticalExecution("full"), {
    target: "candidate-public",
    mutationStarted: true,
    diagnosticLevel: "error",
  });
  assert.throws(() =>
    formatStagingCriticalDiagnostic(
      new StagingCriticalFailure("entry", "entry_cta_timeout"),
      { runID: "123?secret", runAttempt: "1", commitSHA: "a".repeat(40) },
    ),
  );
});

test("avoids duplicating the current journey before the one-time rollout gate", () => {
  const workflow = readFileSync(
    fileURLToPath(
      new URL("../../.github/workflows/deploy.yml", import.meta.url),
    ),
    "utf8",
  );
  const preflight = workflow.indexOf(
    "- name: Verify current Staging health and readiness before migration",
  );
  const rollout = workflow.indexOf(
    "- name: Run stable CSRF initial rollout and authoritative drain",
  );
  const postDeploy = workflow.indexOf(
    "- name: Run post-deploy staging critical journey",
  );
  assert.ok(0 <= preflight && preflight < rollout && rollout < postDeploy);
  const preflightStep = workflow.slice(preflight, rollout);
  assert.match(preflightStep, /STAGING_CRITICAL_MODE: preflight/);
  assert.doesNotMatch(preflightStep, /STAGING_ADMISSION_MODE:/);
  assert.doesNotMatch(preflightStep, /STAGING_E2E_INVITE_TOKEN:/);
  assert.doesNotMatch(preflightStep, /continue-on-error:/);
  assert.doesNotMatch(workflow, /STAGING_CRITICAL_MODE: baseline/);
  const rolloutStep = workflow.slice(rollout, postDeploy);
  assert.doesNotMatch(rolloutStep, /continue-on-error:/);
  const child = readFileSync(
    fileURLToPath(
      new URL("../run-staging-candidate-deploy-and-drain.sh", import.meta.url),
    ),
    "utf8",
  );
  const drainBaseline = child.indexOf(
    "node ./scripts/check-cloudflare-drain-evidence.mjs",
  );
  const migration = child.indexOf("go run ./cmd/migrate");
  const secrets = child.indexOf(
    "node ./scripts/materialize-staging-worker-secrets.mjs",
  );
  const deploy = child.indexOf("wrangler deploy");
  const drainWake = child.indexOf("candidate_deploy_completed");
  const evidence = child.indexOf(
    "node ./scripts/write-staging-rollout-evidence.mjs",
  );
  assert.ok(
    0 <= drainBaseline &&
      drainBaseline < migration &&
      migration < secrets &&
      secrets < deploy &&
      deploy < drainWake &&
      drainWake < evidence,
  );
  const postDeployStep = workflow.slice(postDeploy);
  assert.match(postDeployStep, /STAGING_CRITICAL_MODE: full/);
  assert.doesNotMatch(postDeployStep, /continue-on-error:/);
  assert.match(
    postDeployStep,
    /STAGING_ADMISSION_MODE: \$\{\{ env\.BETA_ADMISSION_MODE \}\}/,
  );
});

test("retries public deletion without reading or exposing response bodies", async () => {
  let attempts = 0;
  const sleeps = [];
  const completedAttempt = await retryPublicAccountDelete(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("private transport detail");
      if (attempts === 2) return { status: 503 };
      if (attempts === 3) {
        return { status: 204, authenticatedUserIDVerified: false };
      }
      return { status: 204, authenticatedUserIDVerified: true };
    },
    {
      retryDelaysMilliseconds: [1, 2, 3],
      sleep: async (delay) => {
        sleeps.push(delay);
      },
    },
  );
  assert.equal(completedAttempt, 4);
  assert.deepEqual(sleeps, [1, 2, 3]);

  const privateBody = "private-account-body";
  await assert.rejects(
    retryPublicAccountDelete(
      async () => {
        throw new Error(privateBody);
      },
      {
        retryDelaysMilliseconds: [0],
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof Error &&
      error.message === "staging public account cleanup failed" &&
      !error.message.includes(privateBody),
  );
});
