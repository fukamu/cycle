import assert from "node:assert/strict";
import test from "node:test";

import { handleBetaAdmission } from "./beta-admission.ts";

const origin = "https://cycle.fukamu.com";
const token = `fukamu_cycle_beta_${"a".repeat(43)}`;
const now = Date.UTC(2026, 7, 20, 12, 0, 0);
const key = base64url(new Uint8Array(32).fill(7));
const digest = await sha256Hex(token);
const closed = {
  PUBLIC_ORIGIN: origin,
  BETA_ADMISSION_MODE: "closed",
  BETA_ADMISSION_COOKIE_TTL_DAYS: "180",
  BETA_INVITES: JSON.stringify([{ id: "beta-001", digest }]),
  BETA_ADMISSION_COOKIE_KEY: key,
};

test("off mode bypasses every admission endpoint without closed-only settings", async () => {
  for (const [path, method] of [
    ["/api/v1/session", "GET"],
    ["/api/v1/session/anonymous", "POST"],
    ["/api/__beta/admission/redeem", "POST"],
  ]) {
    const response = await handleBetaAdmission(
      new Request(`${origin}${path}`, { method }),
      {
        BETA_ADMISSION_MODE: "off",
        BETA_ADMISSION_COOKIE_TTL_DAYS: "invalid",
        BETA_INVITES: "invalid",
        BETA_ADMISSION_COOKIE_KEY: "invalid",
      },
      now,
    );
    assert.equal(response, null);
  }
});

test("closed mode blocks anonymous creation and early session bootstrap", async () => {
  for (const [path, method] of [
    ["/api/v1/session", "GET"],
    ["/api/v1/session/anonymous", "POST"],
  ]) {
    const response = await handleBetaAdmission(
      new Request(`${origin}${path}`, { method }),
      closed,
      now,
    );
    assert.equal(response?.status, 403);
    assert.equal(
      (await response?.json()).error.code,
      "BETA_ADMISSION_REQUIRED",
    );
  }
});

test("existing sessions bypass the early admission prompt", async () => {
  const response = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session`, {
      headers: { Cookie: "__Host-fukamu_cycle_session=existing" },
    }),
    closed,
    now,
  );
  assert.equal(response, null);
});

test("existing sessions survive invalid closed-mode configuration", async () => {
  const response = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session`, {
      headers: { Cookie: "__Host-fukamu_cycle_session=existing" },
    }),
    { BETA_ADMISSION_MODE: "closed" },
    now,
  );
  assert.equal(response, null);
});

test("closed mode fails closed when configuration is invalid", async () => {
  const response = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session/anonymous`, { method: "POST" }),
    { ...closed, BETA_INVITES: "[]" },
    now,
  );
  assert.equal(response?.status, 503);
  assert.equal(
    (await response?.json()).error.code,
    "BETA_ADMISSION_UNAVAILABLE",
  );
});

test("closed config validates TTL boundaries", async (t) => {
  const cases = [
    ["lower boundary", "1", true],
    ["upper boundary", "730", true],
    ["below range", "0", false],
    ["above range", "731", false],
    ["noninteger", "1.5", false],
  ];
  for (const [name, value, accepted] of cases) {
    await t.test(name, () =>
      assertClosedConfig({ BETA_ADMISSION_COOKIE_TTL_DAYS: value }, accepted),
    );
  }
});

test("closed config validates invite schema and boundaries", async (t) => {
  const validCases = [
    ["one entry", [inviteEntry("beta-001", 1)]],
    ["one-character ID", [inviteEntry("a", 1)]],
    ["sixty-four-character ID", [inviteEntry("a".repeat(64), 1)]],
    ["one thousand entries", inviteEntries(1_000)],
  ];
  for (const [name, entries] of validCases) {
    await t.test(name, () =>
      assertClosedConfig({ BETA_INVITES: JSON.stringify(entries) }, true),
    );
  }

  const invalidCases = [
    ["empty array", []],
    ["more than one thousand entries", inviteEntries(1_001)],
    ["non-object entry", ["entry"]],
    ["missing field", [{ id: "beta-001" }]],
    ["extra field", [{ ...inviteEntry("beta-001", 1), extra: true }]],
    ["empty ID", [inviteEntry("", 1)]],
    ["uppercase ID", [inviteEntry("Beta-001", 1)]],
    ["ID longer than sixty-four characters", [inviteEntry("a".repeat(65), 1)]],
    ["short digest", [{ id: "beta-001", digest: "a".repeat(63) }]],
    ["long digest", [{ id: "beta-001", digest: "a".repeat(65) }]],
    ["uppercase digest", [{ id: "beta-001", digest: "A".repeat(64) }]],
    ["duplicate ID", [inviteEntry("beta-001", 1), inviteEntry("beta-001", 2)]],
    [
      "duplicate digest",
      [inviteEntry("beta-001", 1), inviteEntry("beta-002", 1)],
    ],
  ];
  for (const [name, entries] of invalidCases) {
    await t.test(name, () =>
      assertClosedConfig({ BETA_INVITES: JSON.stringify(entries) }, false),
    );
  }
});

test("closed config validates cookie key byte length and alphabet", async (t) => {
  const cases = [
    ["thirty-two bytes", key, true],
    ["thirty-one bytes", base64url(new Uint8Array(31).fill(7)), false],
    ["thirty-three bytes", base64url(new Uint8Array(33).fill(7)), false],
    ["invalid alphabet", "!".repeat(43), false],
  ];
  for (const [name, value, accepted] of cases) {
    await t.test(name, () =>
      assertClosedConfig({ BETA_ADMISSION_COOKIE_KEY: value }, accepted),
    );
  }
});

test("closed config requires a canonical HTTPS public origin", async (t) => {
  const cases = [
    ["canonical origin", origin, true],
    ["missing origin", undefined, false],
    ["HTTP origin", "http://cycle.fukamu.com", false],
    ["trailing slash", `${origin}/`, false],
    ["path", `${origin}/app`, false],
    ["credentials", "https://user@cycle.fukamu.com", false],
  ];
  for (const [name, value, accepted] of cases) {
    await t.test(name, () =>
      assertClosedConfig({ PUBLIC_ORIGIN: value }, accepted),
    );
  }
});

test("redeem requires the exact configured Origin and rejects unknown tokens", async (t) => {
  const originCases = [
    ["exact origin", origin, true],
    ["missing origin", null, false],
    ["trailing slash", `${origin}/`, false],
    ["origin suffix", `${origin}.evil`, false],
    ["other origin", "https://evil.example", false],
  ];
  for (const [name, value, accepted] of originCases) {
    await t.test(name, async () => {
      const response = await redeem(token, { Origin: value });
      assert.equal(response.status, accepted ? 204 : 403);
      if (!accepted) {
        assert.equal((await response.json()).error.code, "CSRF_INVALID");
      }
    });
  }

  const invalid = await redeem(`fukamu_cycle_beta_${"b".repeat(43)}`);
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).error.code, "BETA_INVITE_INVALID");
});

test("valid redeem issues an HttpOnly cookie that admits anonymous creation", async () => {
  const response = await redeem(token);
  assert.equal(response.status, 204);
  const setCookie = response.headers.get("Set-Cookie");
  assert.match(setCookie, /^__Host-fukamu_cycle_beta_admission=/);
  assert.match(setCookie, /; Secure; HttpOnly; SameSite=Lax;/);
  assert.match(setCookie, /Max-Age=/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const cookie = setCookie.split(";", 1)[0];
  const admitted = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session/anonymous`, {
      method: "POST",
      headers: { Cookie: cookie },
    }),
    closed,
    now + 1_000,
  );
  assert.equal(admitted, null);

  const tampered = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session/anonymous`, {
      method: "POST",
      headers: { Cookie: `${cookie}x` },
    }),
    closed,
    now + 1_000,
  );
  assert.equal(tampered?.status, 403);

  const expired = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session/anonymous`, {
      method: "POST",
      headers: { Cookie: cookie },
    }),
    closed,
    now + 181 * 86_400_000,
  );
  assert.equal(expired?.status, 403);
});

test("unrelated API requests are never intercepted", async () => {
  const response = await handleBetaAdmission(
    new Request(`${origin}/api/v1/home`),
    { BETA_ADMISSION_MODE: "invalid" },
    now,
  );
  assert.equal(response, null);
});

async function redeem(inviteToken, headers = {}) {
  const requestHeaders = new Headers({
    "Content-Type": "application/json",
    Origin: origin,
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) requestHeaders.delete(name);
    else requestHeaders.set(name, value);
  }
  return handleBetaAdmission(
    new Request(`${origin}/api/__beta/admission/redeem`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ token: inviteToken }),
    }),
    closed,
    now,
  );
}

async function assertClosedConfig(overrides, accepted) {
  const response = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session/anonymous`, { method: "POST" }),
    { ...closed, ...overrides },
    now,
  );
  assert.equal(response?.status, accepted ? 403 : 503);
  assert.equal(
    (await response?.json()).error.code,
    accepted ? "BETA_ADMISSION_REQUIRED" : "BETA_ADMISSION_UNAVAILABLE",
  );
}

function inviteEntries(count) {
  return Array.from({ length: count }, (_, index) =>
    inviteEntry(`beta-${index}`, index),
  );
}

function inviteEntry(id, digestIndex) {
  return { id, digest: fixedDigest(digestIndex) };
}

function fixedDigest(index) {
  return index.toString(16).padStart(64, "0");
}

async function sha256Hex(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
