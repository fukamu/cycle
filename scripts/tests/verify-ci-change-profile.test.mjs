import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyCiChangeProfile } from "../verify-ci-change-profile.mjs";
const jobs = [
  "workflow",
  "quality",
  "frontend",
  "backend",
  "infrastructure",
  "e2e",
];
const controls = ["reuse_pr_ci", "classify"];
const matrix = {
  docs: ["quality"],
  frontend: ["quality", "frontend", "e2e"],
  backend: ["quality", "backend", "e2e"],
  application: ["quality", "frontend", "backend", "e2e"],
  full: jobs,
};

function invoke(profile, required = matrix[profile], overrides = {}) {
  const requiredSet = new Set(required ?? []);
  return verifyCiChangeProfile(profile, [
    ...controls.map(
      (job) => `${job}=${overrides[job] ?? (job === "reuse_pr_ci" ? "skipped" : "success")}`,
    ),
    ...jobs.map(
      (job) => `${job}=${overrides[job] ?? (requiredSet.has(job) ? "success" : "skipped")}`,
    ),
  ]);
}

for (const [profile, required] of Object.entries(matrix)) {
  test(`${profile} accepts its exact result matrix`, () => {
    assert.equal(invoke(profile), required.join(","));
  });
}

test("required jobs cannot be skipped", () => {
  assert.throws(() => invoke("frontend", undefined, { frontend: "skipped" }));
});

test("reuse and classifier control results fail closed", () => {
  assert.throws(() => invoke("docs", undefined, { reuse_pr_ci: "success" }));
  assert.throws(() => invoke("docs", undefined, { classify: "failure" }));
});

test("non-required jobs cannot report success", () => {
  assert.throws(() => invoke("docs", undefined, { backend: "success" }));
});

test("failures, cancellations, unknown profiles, and incomplete inventories fail closed", () => {
  assert.throws(() => invoke("backend", undefined, { backend: "failure" }));
  assert.throws(() => invoke("backend", undefined, { backend: "cancelled" }));
  assert.throws(() => invoke("unknown"));
  assert.throws(() => verifyCiChangeProfile("docs", []));
});
