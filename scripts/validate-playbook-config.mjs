#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const rootArgument = process.argv[2] ?? ".";
if (process.argv.length > 3) fail("Usage: node scripts/validate-playbook-config.mjs [consumer-root]");

const root = resolve(rootArgument);
const canonicalRoot = await realpath(root).catch(() => null);
if (canonicalRoot === null || canonicalRoot !== root) {
  fail("consumer root must be an existing canonical path");
}

const requiredPaths = [
  ".fukamu/playbook/PLAYBOOK.md",
  ".fukamu/playbook/config.json",
  ".fukamu/playbook/lock.json",
  ".fukamu/playbook/overrides.json",
  ".fukamu/playbook/validate.py",
  ".github/workflows/playbook.yml",
  "AGENTS.md",
  "README.md",
  "docs/closed-beta-admission.md",
  "docs/database.md",
  "docs/design.md",
  "docs/development.md",
  "docs/environment.md",
  "docs/operations.md",
  "scripts/check-config-parity.sh",
  "scripts/check-docs.sh",
  "scripts/check-security.sh",
  "scripts/tests/run.sh",
];

for (const path of requiredPaths) await requireRegularFile(path);

const playbook = await readText(".fukamu/playbook/PLAYBOOK.md");
const ruleIds = [...playbook.matchAll(/^### (PE-[A-Z]{3}-\d{3}) — .+$/gmu)].map(
  (match) => match[1],
);
if (ruleIds.length === 0 || new Set(ruleIds).size !== ruleIds.length) {
  fail("vendored playbook must contain unique rule IDs");
}

const lock = await readCanonicalJson(".fukamu/playbook/lock.json");
requireExactKeys(lock, [
  "schemaVersion",
  "source",
  "version",
  "revision",
  "tagSignerFingerprint",
  "bundlePath",
  "bundleSha256",
  "validatorPath",
  "validatorSha256",
], "lock");
if (
  lock.schemaVersion !== 1 ||
  lock.source !== "fukamu/product-engineering-playbook" ||
  lock.version !== "0.1.0" ||
  lock.revision !== "670dce251dc72b45c647950c15466b3570e0071a" ||
  lock.tagSignerFingerprint !== "021197A6B3877512E7B708CA8538108E74DEE186" ||
  lock.bundlePath !== ".fukamu/playbook/PLAYBOOK.md" ||
  lock.bundleSha256 !== "af29392a61da4bee622b7eb2cbe22c741cf0d4b846424afe359b5e001b654e5d" ||
  lock.validatorPath !== ".fukamu/playbook/validate.py" ||
  lock.validatorSha256 !== "940668f021442a3fcb27a3db932da4f96aa35fab3ed00c5e3dfc67c934eab6b8"
) {
  fail("playbook lock is not the approved Cycle v0.1.0 identity");
}
if (
  (await fileSha256(".fukamu/playbook/PLAYBOOK.md")) !== lock.bundleSha256 ||
  (await fileSha256(".fukamu/playbook/validate.py")) !== lock.validatorSha256
) {
  fail("vendored Playbook bytes do not match the approved lock hashes");
}

const overrides = await readCanonicalJson(".fukamu/playbook/overrides.json");
requireExactKeys(overrides, ["schemaVersion", "overrides"], "overrides");
if (overrides.schemaVersion !== 1 || !Array.isArray(overrides.overrides)) {
  fail("overrides must use schemaVersion 1 and an array");
}
if (overrides.overrides.length !== 0) {
  fail("Cycle adopts v0.1.0 with an empty override list");
}

const config = await readCanonicalJson(".fukamu/playbook/config.json");
requireExactKeys(config, [
  "schemaVersion",
  "adoptionMode",
  "adoptionIssue",
  "sourceReviewBacklog",
  "ownership",
  "ruleMappings",
], "config");
if (
  config.schemaVersion !== 1 ||
  config.adoptionMode !== "normative" ||
  config.adoptionIssue !== "https://github.com/fukamu/cycle/issues/75" ||
  config.sourceReviewBacklog !==
    "https://github.com/fukamu/product-engineering-playbook/issues/3"
) {
  fail("playbook adoption metadata is not the approved Cycle contract");
}

requireExactKeys(config.ownership, [
  "sharedMethods",
  "cycleProductContract",
  "repositoryInstructions",
  "localProcedureOwners",
], "config.ownership");
if (
  config.ownership.sharedMethods !== ".fukamu/playbook/PLAYBOOK.md" ||
  config.ownership.cycleProductContract !== "docs/design.md" ||
  config.ownership.repositoryInstructions !== "AGENTS.md" ||
  JSON.stringify(config.ownership.localProcedureOwners) !==
    JSON.stringify([
      "docs/closed-beta-admission.md",
      "docs/database.md",
      "docs/development.md",
      "docs/environment.md",
      "docs/operations.md",
    ])
) {
  fail("playbook and Cycle ownership boundary is not exact");
}

if (!Array.isArray(config.ruleMappings)) fail("config.ruleMappings must be an array");
const mappedIds = [];
const localSectionReferences = new Set();
const allowedRelations = new Set([
  "direct-adoption",
  "cycle-concretization",
  "local-stricter",
]);
for (const [index, mapping] of config.ruleMappings.entries()) {
  requireExactKeys(
    mapping,
    ["ruleId", "relation", "localSections"],
    `config.ruleMappings[${index}]`,
  );
  if (typeof mapping.ruleId !== "string") fail(`config.ruleMappings[${index}].ruleId must be a string`);
  if (!allowedRelations.has(mapping.relation)) {
    fail(`config.ruleMappings[${index}].relation is not approved`);
  }
  if (
    !Array.isArray(mapping.localSections) ||
    mapping.localSections.some((reference) => typeof reference !== "string") ||
    new Set(mapping.localSections).size !== mapping.localSections.length
  ) {
    fail(`config.ruleMappings[${index}].localSections must be a unique string array`);
  }
  if (mapping.relation === "direct-adoption" && mapping.localSections.length !== 0) {
    fail(`config.ruleMappings[${index}] direct adoption cannot claim a local section`);
  }
  if (mapping.relation !== "direct-adoption" && mapping.localSections.length === 0) {
    fail(`config.ruleMappings[${index}] must identify its local section`);
  }
  for (const reference of mapping.localSections) {
    const separator = reference.indexOf("#");
    if (separator <= 0 || separator === reference.length - 1 || reference.indexOf("#", separator + 1) !== -1) {
      fail(`config.ruleMappings[${index}] has an invalid local section reference`);
    }
    const path = reference.slice(0, separator);
    const heading = reference.slice(separator + 1);
    if (!requiredPaths.includes(path) || !path.endsWith(".md")) {
      fail(`config.ruleMappings[${index}] references an unapproved local section path`);
    }
    if (localSectionReferences.has(`${mapping.ruleId}:${reference}`)) {
      fail(`config.ruleMappings[${index}] repeats a local section reference`);
    }
    localSectionReferences.add(`${mapping.ruleId}:${reference}`);
    const source = await readText(path);
    const headingMatches = markdownHeadings(source).filter((candidate) => candidate === heading);
    if (headingMatches.length !== 1) {
      fail(`config.ruleMappings[${index}] local section heading is not exact: ${reference}`);
    }
  }
  mappedIds.push(mapping.ruleId);
}
if (JSON.stringify(mappedIds) !== JSON.stringify(ruleIds)) {
  fail("config.ruleMappings must trace every vendored rule exactly once in playbook order");
}

const agents = await readText("AGENTS.md");
for (const reference of [
  ".fukamu/playbook/PLAYBOOK.md",
  ".fukamu/playbook/config.json",
  ".fukamu/playbook/lock.json",
  ".fukamu/playbook/overrides.json",
  "PE-WRK-002",
]) {
  if (!agents.includes(reference)) fail(`AGENTS.md must reference ${reference}`);
}

const readme = await readText("README.md");
for (const reference of [
  ".fukamu/playbook/PLAYBOOK.md",
  ".fukamu/playbook/config.json",
  ".fukamu/playbook/lock.json",
  ".fukamu/playbook/overrides.json",
]) {
  if (!readme.includes(reference)) fail(`README.md must reference ${reference}`);
}

const design = await readText("docs/design.md");
for (const reference of [".fukamu/playbook/PLAYBOOK.md", "PE-WRK-002"]) {
  if (!design.includes(reference)) fail(`docs/design.md must reference ${reference}`);
}

await requireSingleOrderedCall({
  path: "scripts/check-security.sh",
  call: 'if ! bash "${snapshot_root}/scripts/check-playbook-adoption.sh"; then',
  before: 'security_run_gitleaks_normalized_text "${repo_root}" history',
  after: 'security_run_supply_chain_policy "${snapshot_root}"',
});
await requireSingleOrderedCall({
  path: "scripts/check-docs.sh",
  call: 'bash "${candidate_root}/scripts/check-playbook-adoption.sh"',
  before: "create_docs_config_candidate_snapshot",
  after: 'node "${script_dir}/check-docs.mjs" "${candidate_root}"',
});
await requireSingleOrderedCall({
  path: "scripts/check-config-parity.sh",
  call: 'bash "${candidate_root}/scripts/check-playbook-adoption.sh"',
  before: "create_docs_config_candidate_snapshot",
  after: "config_candidate_files=(",
});
await requireSingleOrderedCall({
  path: "scripts/tests/run.sh",
  call: 'bash "${script_dir}/check-playbook-adoption.sh"',
  before: 'bash "${script_dir}/check-supply-chain.sh"',
  after: 'bash "${script_dir}/check-ci-security-model.sh"',
});

console.log(`Validated Cycle playbook trace for ${ruleIds.length} rules`);

async function requireRegularFile(path) {
  if (isAbsolute(path)) fail(`required path must be relative: ${path}`);
  const candidate = resolve(root, path);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    fail(`required path escapes consumer root: ${path}`);
  }
  const stat = await lstat(candidate).catch(() => null);
  const canonical = await realpath(candidate).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || canonical !== candidate) {
    fail(`required path must be a regular non-symlink file: ${path}`);
  }
}

async function readText(path) {
  return readFile(resolve(root, path), "utf8").catch(() => fail(`could not read ${path}`));
}

async function fileSha256(path) {
  const contents = await readFile(resolve(root, path)).catch(() => fail(`could not read ${path}`));
  return createHash("sha256").update(contents).digest("hex");
}

async function readCanonicalJson(path) {
  const source = await readText(path);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail(`invalid JSON: ${path}`);
  }
  if (source !== `${JSON.stringify(value, null, 2)}\n`) {
    fail(`JSON must use the canonical two-space format without duplicate keys: ${path}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`JSON root must be an object: ${path}`);
  }
  return value;
}

function markdownHeadings(source) {
  const headings = [];
  let fence = null;
  for (const line of source.split("\n")) {
    if (fence !== null) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/u);
      if (closing !== null && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (opening !== null) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }
    const match = line.match(/^#{1,6} (.+)$/u);
    if (match !== null) headings.push(match[1]);
  }
  return headings;
}

async function requireSingleOrderedCall({ path, call, before, after }) {
  const source = await readText(path);
  const callLines = source.split("\n").filter((line) => line.trim() === call);
  if (callLines.length !== 1) {
    fail(`${path} must contain the approved Playbook check exactly once`);
  }
  const beforeIndex = source.indexOf(before);
  const callIndex = source.indexOf(call);
  const afterIndex = source.indexOf(after);
  if (beforeIndex < 0 || callIndex <= beforeIndex || afterIndex <= callIndex) {
    fail(`${path} does not run the Playbook check at the approved boundary`);
  }
}

function requireExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} field inventory is not exact`);
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
