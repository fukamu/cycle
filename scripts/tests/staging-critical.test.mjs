import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enterStagingCritical } from "../../frontend/e2e/staging-critical-entry.mjs";
import {
  deriveBootstrapUUIDv7,
  formatStagingCriticalDiagnostic,
  parseAnonymousSession,
  parsePublicAnonymousSession,
  parseStagingBaseURL,
  parseStagingCriticalMode,
  retryPublicAccountDelete,
  runStagingCritical,
  stagingCriticalCleanupStates,
  stagingCriticalExecution,
  StagingCriticalFailure,
  stagingCriticalFailureReasons,
  stagingCriticalPhases,
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
  assert.throws(() => parseStagingCriticalMode("private-mode"));
  assert.throws(
    () => new StagingCriticalFailure("private-phase", "unexpected_status"),
  );
});

test("parses a public anonymous Session body without an authenticated response identity", () => {
  const payload = {
    user: {
      id: userID,
      googleConnected: false,
      googleEmail: null,
    },
    csrfToken: "csrf-private-value",
  };
  assert.deepEqual(parsePublicAnonymousSession(payload), {
    userID,
    csrfToken: "csrf-private-value",
  });

  for (const invalid of [
    { ...payload, csrfToken: "" },
    {
      ...payload,
      user: { ...payload.user, googleConnected: true },
    },
  ]) {
    assert.throws(
      () => parsePublicAnonymousSession(invalid),
      (error) =>
        error instanceof Error &&
        error.message === "staging session response is invalid" &&
        !error.message.includes(userID) &&
        !error.message.includes("csrf-private-value"),
    );
  }
});

test("binds an authenticated Session body to its exact response identity", () => {
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

  for (const authenticatedUserID of [
    undefined,
    "not-a-user-id",
    "0198c20b-7b95-7000-8000-000000000002",
  ]) {
    assert.throws(
      () => parseAnonymousSession(payload, authenticatedUserID),
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
  const anonymousCapture = source.slice(
    source.indexOf("function captureAnonymousSession("),
    source.indexOf("async function discoverSession("),
  );
  assert.notEqual(anonymousCapture, "");
  assert.match(anonymousCapture, /parsePublicAnonymousSession/);
  assert.match(
    anonymousCapture,
    /response\.headers\(\)\[authenticatedUserIDHeader\] !== undefined/,
  );
  assert.doesNotMatch(anonymousCapture, /parseAnonymousSession/);
  for (const name of ["DEBUG", "NODE_DEBUG", "NODE_OPTIONS", "PWDEBUG"]) {
    assert.match(source, new RegExp(`delete process\\.env\\.${name}`));
  }

  const cleanup = source.slice(
    source.indexOf("async function deleteAccount("),
    source.indexOf("async function sessionStatus("),
  );
  assert.notEqual(cleanup, "");
  assert.doesNotMatch(cleanup, /response\.(?:body|json|text)\(/);
});

function entryFixture({
  failEntry = false,
  showRetry = false,
  showRateLimit = false,
  showApplicationError = false,
  keepRetryVisible = false,
  failRetryTransition = false,
  onRetryClick,
} = {}) {
  const calls = [];
  let retryVisible = showRetry;
  const newGoalButton = {
    or() {
      return entryButtons;
    },
    async waitFor(options) {
      assert.deepEqual(options, { state: "visible" });
      calls.push("wait-new-goal");
    },
  };
  const retryButton = {
    async isVisible() {
      return retryVisible;
    },
    async click() {
      calls.push("click-retry");
      await onRetryClick?.();
      if (!keepRetryVisible) retryVisible = false;
    },
  };
  const initialSessionRetryBoundary = {
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(options.name, "\u518d\u8a66\u884c");
      assert.equal(options.exact, true);
      return retryButton;
    },
    async isVisible() {
      return retryVisible;
    },
    async waitFor(options) {
      assert.deepEqual(options, { state: "hidden" });
      calls.push("wait-retry-hidden");
      if (retryVisible)
        throw new Error("private retry did not leave error state");
    },
  };
  const initialSessionRateLimitBoundary = {
    async isVisible() {
      return showRateLimit;
    },
  };
  const applicationErrorBoundary = {
    async isVisible() {
      return showApplicationError;
    },
  };
  const entryButtons = {
    or() {
      return entryButtons;
    },
    first() {
      return {
        async waitFor(options) {
          assert.deepEqual(options, { state: "visible" });
          if (calls.includes("click-retry")) {
            calls.push("wait-entry-after-retry");
            if (failRetryTransition) {
              throw new Error("private retry transition failure");
            }
            return;
          }
          calls.push("wait-entry-cta");
          if (failEntry) throw new Error("private entry failure");
        },
      };
    },
  };
  return {
    calls,
    page: {
      async goto(URL, options) {
        assert.equal(URL, canonicalBaseURL);
        assert.deepEqual(options, { waitUntil: "domcontentloaded" });
        calls.push("goto");
      },
      getByRole(role, options) {
        assert.equal(role, "button");
        assert.equal(
          options.name,
          "\u65b0\u3057\u3044\u76ee\u6a19\u3092\u8a2d\u5b9a",
        );
        return newGoalButton;
      },
      locator(selector) {
        if (selector === '[data-initial-session-state="retryable"]') {
          return initialSessionRetryBoundary;
        }
        if (selector === '[data-initial-session-state="rate-limited"]') {
          return initialSessionRateLimitBoundary;
        }
        if (selector === '[data-application-error-boundary="true"]') {
          return applicationErrorBoundary;
        }
        assert.fail(`unexpected selector: ${selector}`);
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
      async enter() {
        calls.push("entry");
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

async function runFake(mode, overrides = {}) {
  const fake = fakeAdapter(overrides);
  const result = await runStagingCritical({
    mode,
    adapter: fake.adapter,
    retryOptions: {
      retryDelaysMilliseconds: [],
      sleep: async () => undefined,
    },
  });
  return { ...fake, ...result };
}

test("limits the blocking preflight to health and readiness", async () => {
  const { calls, failures, cleanupState } = await runFake("preflight");
  assert.deepEqual(failures, []);
  assert.equal(cleanupState, "not_applicable");
  assert.deepEqual(calls, ["launch", "health", "readiness", "close"]);
});

test("fails the preflight before any anonymous operation", async () => {
  const unhealthy = await runFake("preflight", {
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

  const unready = await runFake("preflight", {
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

test("runs the baseline with discovery and public cleanup", async () => {
  const { calls, failures, cleanupState } = await runFake("baseline");
  assert.deepEqual(failures, []);
  assert.equal(cleanupState, "verified");
  assert.deepEqual(calls, [
    "launch",
    "health",
    "readiness",
    "seed",
    "entry",
    "discover",
    "before-cleanup",
    "discover",
    "delete",
    "verify",
    "close",
  ]);
  assert.equal(calls.includes("full"), false);
});

test("entry opens New Goal directly", async () => {
  const fixture = entryFixture();
  const session = { userID, csrfToken: "private-csrf-token" };
  const result = await enterStagingCritical({
    page: fixture.page,
    baseURL: canonicalBaseURL,
    captureAnonymousSession() {
      fixture.calls.push("capture-session");
      return Promise.resolve(session);
    },
  });
  assert.equal(result, session);
  assert.deepEqual(fixture.calls, [
    "capture-session",
    "goto",
    "wait-entry-cta",
    "wait-new-goal",
  ]);
});

test("observes a pending anonymous session capture before entry can fail", async () => {
  const fixture = entryFixture({ failEntry: true });
  const pendingCapture = new Promise(() => undefined);
  const originalThen = pendingCapture.then.bind(pendingCapture);
  let rejectionObserved = false;
  pendingCapture.then = (onFulfilled, onRejected) => {
    rejectionObserved = typeof onRejected === "function";
    return originalThen(onFulfilled, onRejected);
  };

  await assert.rejects(
    enterStagingCritical({
      page: fixture.page,
      baseURL: canonicalBaseURL,
      captureAnonymousSession() {
        fixture.calls.push("capture-session");
        return pendingCapture;
      },
    }),
    (error) =>
      error instanceof StagingCriticalFailure &&
      error.phase === "entry" &&
      error.reason === "entry_cta_timeout" &&
      !error.message.includes("private entry failure"),
  );
  assert.equal(rejectionObserved, true);
  assert.deepEqual(fixture.calls, [
    "capture-session",
    "goto",
    "wait-entry-cta",
  ]);
});

test("maps an anonymous session capture rejection to an unobserved session", async () => {
  const fixture = entryFixture();
  const result = await enterStagingCritical({
    page: fixture.page,
    baseURL: canonicalBaseURL,
    captureAnonymousSession() {
      fixture.calls.push("capture-session");
      return Promise.reject(new Error("private response failure"));
    },
  });
  assert.equal(result, undefined);
  assert.deepEqual(fixture.calls, [
    "capture-session",
    "goto",
    "wait-entry-cta",
    "wait-new-goal",
  ]);
});

test("preserves a closed anonymous session rejection when entry also fails", async () => {
  const fixture = entryFixture({ failEntry: true });
  const captureFailure = new StagingCriticalFailure(
    "entry",
    "anonymous_session_rate_limited",
  );
  await assert.rejects(
    enterStagingCritical({
      page: fixture.page,
      baseURL: canonicalBaseURL,
      captureAnonymousSession() {
        fixture.calls.push("capture-session");
        return Promise.reject(captureFailure);
      },
    }),
    (error) => error === captureFailure,
  );
  assert.deepEqual(fixture.calls, [
    "capture-session",
    "goto",
    "wait-entry-cta",
  ]);
});

test("does not retry an unobserved anonymous session without an accepted claim", async (t) => {
  for (const [name, claimInitialSessionRetry] of [
    ["missing", undefined],
    ["denied", () => false],
  ]) {
    await t.test(name, async () => {
      const fixture = entryFixture({ showRetry: true });
      await assert.rejects(
        enterStagingCritical({
          page: fixture.page,
          baseURL: canonicalBaseURL,
          captureAnonymousSession() {
            fixture.calls.push("capture-session");
            return new Promise(() => undefined);
          },
          claimInitialSessionRetry,
        }),
        (error) =>
          error instanceof StagingCriticalFailure &&
          error.phase === "entry" &&
          error.reason === "anonymous_session_request_not_observed",
      );
      assert.deepEqual(fixture.calls, [
        "capture-session",
        "goto",
        "wait-entry-cta",
      ]);
    });
  }
});

test("does not confuse other entry boundaries with the initial Session Retry", async (t) => {
  for (const [name, options, reason] of [
    ["rate limit", { showRateLimit: true }, "anonymous_session_rate_limited"],
    [
      "application error boundary",
      { showApplicationError: true },
      "unexpected_entry_boundary",
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = entryFixture(options);
      await assert.rejects(
        enterStagingCritical({
          page: fixture.page,
          baseURL: canonicalBaseURL,
          captureAnonymousSession() {
            fixture.calls.push("capture-session");
            return new Promise(() => undefined);
          },
        }),
        (error) =>
          error instanceof StagingCriticalFailure &&
          error.phase === "entry" &&
          error.reason === reason,
      );
      assert.equal(fixture.calls.includes("click-retry"), false);
    });
  }
});

test("retries the initial pre-request state once with the same capture", async () => {
  const fixture = entryFixture({ showRetry: true });
  const session = { userID, csrfToken: "private-csrf-token" };
  let captures = 0;
  let claims = 0;
  const result = await enterStagingCritical({
    page: fixture.page,
    baseURL: canonicalBaseURL,
    captureAnonymousSession() {
      captures += 1;
      fixture.calls.push("capture-session");
      return Promise.resolve(session);
    },
    claimInitialSessionRetry() {
      claims += 1;
      return true;
    },
  });
  assert.equal(result, session);
  assert.equal(captures, 1);
  assert.equal(claims, 1);
  assert.deepEqual(fixture.calls, [
    "capture-session",
    "goto",
    "wait-entry-cta",
    "click-retry",
    "wait-retry-hidden",
    "wait-entry-after-retry",
    "wait-new-goal",
  ]);
});

test("fails closed after the claimed retry reaches Retry again", async () => {
  const fixture = entryFixture({
    showRetry: true,
    keepRetryVisible: true,
  });
  let claims = 0;
  await assert.rejects(
    enterStagingCritical({
      page: fixture.page,
      baseURL: canonicalBaseURL,
      captureAnonymousSession() {
        fixture.calls.push("capture-session");
        return new Promise(() => undefined);
      },
      claimInitialSessionRetry() {
        claims += 1;
        return true;
      },
    }),
    (error) =>
      error instanceof StagingCriticalFailure &&
      error.phase === "entry" &&
      error.reason === "initial_session_retry_exhausted",
  );
  assert.equal(
    fixture.calls.filter((call) => call === "click-retry").length,
    1,
  );
  assert.equal(claims, 1);
  assert.deepEqual(fixture.calls, [
    "capture-session",
    "goto",
    "wait-entry-cta",
    "click-retry",
    "wait-retry-hidden",
  ]);
});

test("does not await capture when a POST is unobserved or observation is unavailable", async (t) => {
  for (const [name, hasObservedAnonymousSessionRequest] of [
    ["observation callback unavailable", undefined],
    ["POST unobserved", () => false],
  ]) {
    await t.test(name, async () => {
      const fixture = entryFixture({
        showRetry: true,
        failRetryTransition: true,
      });
      const entry = enterStagingCritical({
        page: fixture.page,
        baseURL: canonicalBaseURL,
        captureAnonymousSession() {
          fixture.calls.push("capture-session");
          return new Promise(() => undefined);
        },
        claimInitialSessionRetry: () => true,
        hasObservedAnonymousSessionRequest,
      });
      let timeoutID;
      const failure = await Promise.race([
        entry.catch((error) => error),
        new Promise((resolve) => {
          timeoutID = globalThis.setTimeout(resolve, 500);
        }),
      ]);
      globalThis.clearTimeout(timeoutID);
      assert.equal(
        failure instanceof StagingCriticalFailure &&
          failure.phase === "entry" &&
          failure.reason === "initial_session_retry_exhausted" &&
          !failure.message.includes("private retry transition failure"),
        true,
      );
      assert.equal(
        fixture.calls.filter((call) => call === "click-retry").length,
        1,
      );
    });
  }
});

test("retains a delayed successful POST session when the Retry transition times out", async () => {
  const session = { userID, csrfToken: "private-csrf-token" };
  const retained = [];
  let captures = 0;
  let resolveCapture;
  const fixture = entryFixture({
    showRetry: true,
    failRetryTransition: true,
    onRetryClick() {
      globalThis.setTimeout(() => resolveCapture(session), 10);
    },
  });
  await assert.rejects(
    enterStagingCritical({
      page: fixture.page,
      baseURL: canonicalBaseURL,
      captureAnonymousSession() {
        captures += 1;
        fixture.calls.push("capture-session");
        return new Promise((resolve) => {
          resolveCapture = resolve;
        });
      },
      claimInitialSessionRetry: () => true,
      hasObservedAnonymousSessionRequest: () => true,
      retainAnonymousSessionForCleanup(currentSession) {
        retained.push(currentSession);
      },
    }),
    (error) =>
      error instanceof StagingCriticalFailure &&
      error.phase === "entry" &&
      error.reason === "initial_session_retry_exhausted",
  );
  assert.equal(captures, 1);
  assert.deepEqual(retained, [session]);
  assert.equal(
    fixture.calls.filter((call) => call === "click-retry").length,
    1,
  );
});

test("waits boundedly for a late classified POST failure before entry failure", async () => {
  const captureFailure = new StagingCriticalFailure(
    "entry",
    "anonymous_session_unavailable",
  );
  let rejectCapture;
  const fixture = entryFixture({
    showRetry: true,
    failRetryTransition: true,
    onRetryClick() {
      globalThis.setTimeout(() => rejectCapture(captureFailure), 5);
    },
  });
  await assert.rejects(
    enterStagingCritical({
      page: fixture.page,
      baseURL: canonicalBaseURL,
      captureAnonymousSession() {
        fixture.calls.push("capture-session");
        return new Promise((_resolve, reject) => {
          rejectCapture = reject;
        });
      },
      claimInitialSessionRetry: () => true,
      hasObservedAnonymousSessionRequest: () => true,
    }),
    (error) => error === captureFailure,
  );
  assert.equal(
    fixture.calls.filter((call) => call === "click-retry").length,
    1,
  );
});

test("prioritizes a classified POST failure during the claimed retry", async () => {
  const captureFailure = new StagingCriticalFailure(
    "entry",
    "anonymous_session_rate_limited",
  );
  let rejectCapture;
  const fixture = entryFixture({
    showRetry: true,
    keepRetryVisible: true,
    onRetryClick() {
      rejectCapture(captureFailure);
    },
  });
  await assert.rejects(
    enterStagingCritical({
      page: fixture.page,
      baseURL: canonicalBaseURL,
      captureAnonymousSession() {
        fixture.calls.push("capture-session");
        return new Promise((_resolve, reject) => {
          rejectCapture = reject;
        });
      },
      claimInitialSessionRetry: () => true,
    }),
    (error) => error === captureFailure,
  );
  assert.equal(
    fixture.calls.filter((call) => call === "click-retry").length,
    1,
  );
});

test("retains the post-deploy full journey", async () => {
  const { calls, failures, cleanupState } = await runFake("full");
  assert.deepEqual(failures, []);
  assert.equal(cleanupState, "verified");
  assert.equal(calls.includes("full"), true);
  assert.ok(calls.indexOf("full") < calls.indexOf("before-cleanup"));
});

test("keeps candidate cleanup hard after a full journey failure", async () => {
  const result = await runFake("full", {
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
  const timedOut = await runFake("baseline", {
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

  const notObserved = await runFake("baseline", {
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
  const deletionFailure = await runFake("baseline", {
    async deleteAccount() {
      throw new Error("private body https://example.invalid/?token=secret");
    },
  });
  assert.deepEqual(
    deletionFailure.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "account_delete", reason: "account_delete_failed" }],
  );
  assert.equal(deletionFailure.cleanupState, "unverified");

  const proofFailure = await runFake("baseline", {
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
      fake.calls.push("entry");
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
      fake.calls.push("entry");
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
  const unhealthy = await runFake("baseline", {
    async checkHealth() {
      throw new Error("private upstream response body");
    },
  });
  assert.deepEqual(
    unhealthy.failures.map(({ phase, reason }) => ({ phase, reason })),
    [{ phase: "health", reason: "unexpected_status" }],
  );
  assert.equal(unhealthy.cleanupState, "not_started");

  const discoveryFailure = await runFake("baseline", {
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
    "private-entry-token",
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
    "anonymous_session_request_not_observed",
    "anonymous_session_bad_request",
    "anonymous_session_forbidden",
    "anonymous_session_rate_limited",
    "anonymous_session_unavailable",
    "initial_session_retry_exhausted",
    "unexpected_entry_boundary",
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
