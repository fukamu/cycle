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

test("off mode leaves anonymous bootstrap unchanged", async () => {
  const response = await handleBetaAdmission(
    new Request(`${origin}/api/v1/session/anonymous`, { method: "POST" }),
    { BETA_ADMISSION_MODE: "off" },
    now,
  );
  assert.equal(response, null);
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

test("redeem rejects cross-origin and unknown tokens", async () => {
  const crossOrigin = await redeem(token, { Origin: "https://evil.example" });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, "CSRF_INVALID");

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
  return handleBetaAdmission(
    new Request(`${origin}/api/__beta/admission/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...headers,
      },
      body: JSON.stringify({ token: inviteToken }),
    }),
    closed,
    now,
  );
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
