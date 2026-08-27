import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  accountCorrelation,
  deriveBootstrapUUIDv7,
  parseAnonymousSession,
  parseStagingBaseURL,
  retryPublicAccountDelete,
  validateStagingInviteToken,
} from "../lib/staging-critical.mjs";

const canonicalBaseURL = "https://cycle.staging.fukamu.matoruru.com";
const userID = "0198c20b-7b95-7000-8000-000000000001";

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

test("hashes account identifiers into a body-free correlation", () => {
  const expected = createHash("sha256").update(userID).digest("hex");
  const correlation = accountCorrelation(userID);
  assert.equal(correlation, `sha256:${expected}`);
  assert.equal(correlation.includes(userID), false);
  assert.throws(() => accountCorrelation("not-a-user-id"));
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
  assert.doesNotMatch(source, /\bconsole\./);
  assert.doesNotMatch(
    source,
    /\b(?:recordVideo|screenshot|trace:|tracing\.)\b/,
  );
  assert.doesNotMatch(source, /\bcatch\s*\(\s*[A-Za-z_$]/);
  assert.equal(
    source.match(/process\.env\.STAGING_E2E_INVITE_TOKEN/g)?.length,
    2,
  );
  for (const name of ["DEBUG", "PWDEBUG", "STAGING_E2E_INVITE_TOKEN"]) {
    assert.match(source, new RegExp(`delete process\\.env\\.${name}`));
  }

  const cleanup = source.slice(
    source.indexOf("async function deleteAccount("),
    source.indexOf("async function verifySessionDeleted("),
  );
  assert.notEqual(cleanup, "");
  assert.doesNotMatch(cleanup, /response\.(?:body|json|text)\(/);
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
