#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const profileMatrix = Object.freeze({
  docs: ["quality"],
  frontend: ["quality", "frontend", "e2e"],
  backend: ["quality", "backend", "e2e"],
  application: ["quality", "frontend", "backend", "e2e"],
  full: [
    "workflow",
    "quality",
    "frontend",
    "backend",
    "infrastructure",
    "e2e",
  ],
});
const jobOrder = Object.freeze([
  "workflow",
  "quality",
  "frontend",
  "backend",
  "infrastructure",
  "e2e",
]);
const resultOrder = Object.freeze(["reuse_pr_ci", "classify", ...jobOrder]);

function fail(message) {
  throw new Error(`CI profile verification failed: ${message}`);
}

export function verifyCiChangeProfile(profile, assignments) {
  if (!Object.hasOwn(profileMatrix, profile)) {
    fail("unknown change profile");
  }
  if (assignments.length !== resultOrder.length) {
    fail("incomplete job result inventory");
  }

  const actual = new Map();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const name = separator === -1 ? "" : assignment.slice(0, separator);
    const result = separator === -1 ? "" : assignment.slice(separator + 1);
    if (!resultOrder.includes(name) || actual.has(name)) {
      fail("unknown or duplicate job result");
    }
    if (!new Set(["success", "skipped", "failure", "cancelled"]).has(result)) {
      fail("unknown job conclusion");
    }
    actual.set(name, result);
  }
  if (actual.size !== resultOrder.length) {
    fail("incomplete job result inventory");
  }

  if (actual.get("reuse_pr_ci") !== "skipped") {
    fail("PR reuse job must be skipped");
  }
  if (actual.get("classify") !== "success") {
    fail("change classifier must succeed");
  }

  const required = new Set(profileMatrix[profile]);
  for (const name of jobOrder) {
    const expected = required.has(name) ? "success" : "skipped";
    if (actual.get(name) !== expected) {
      fail(`${name} must be ${expected}`);
    }
  }

  return profileMatrix[profile].join(",");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [profile, ...assignments] = process.argv.slice(2);
    process.stdout.write(`required_jobs=${verifyCiChangeProfile(profile, assignments)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CI profile verification failed"}\n`);
    process.exitCode = 1;
  }
}
