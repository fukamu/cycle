#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_WALK_ENTRIES = 100000;
const excludedDirectories = new Set([
  ".git",
  ".pnpm-store",
  ".tmp",
  ".terraform",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);
const pinnedImagePattern =
  /^([a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)*):([A-Za-z0-9][A-Za-z0-9._-]*)@sha256:([0-9a-f]{64})$/;
const versionCommentPattern =
  /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const errors = [];
const fileCache = new Map();
const imageDigests = new Map();
let immutableImageReferences = 0;
let localBuildAliasCount = 0;
let walkedEntries = 0;

if (process.argv.length !== 3) {
  process.stderr.write("usage: check-supply-chain.mjs ROOT\n");
  process.exit(2);
}

const root = path.resolve(process.argv[2]);

function report(relativePath, line, message) {
  const normalizedLine = Number.isInteger(line) && line > 0 ? line : 1;
  errors.push(relativePath + ":" + normalizedLine + ": " + message);
}

function rootIsSafe() {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    process.stderr.write(".:1: policy root is unavailable\n");
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    process.stderr.write(".:1: policy root must be a real directory\n");
    return false;
  }
  return true;
}

function toAbsolute(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("unsafe relative path");
  }
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("path escapes root");
  }
  return absolute;
}

function readFile(relativePath, required = true) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (fileCache.has(normalized)) return fileCache.get(normalized);
  let absolute;
  try {
    absolute = toAbsolute(normalized);
  } catch {
    report(normalized || ".", 1, "path is outside the policy root");
    fileCache.set(normalized, null);
    return null;
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    if (required) report(normalized, 1, "required policy input is missing");
    fileCache.set(normalized, null);
    return null;
  }
  if (stat.isSymbolicLink()) {
    report(normalized, 1, "policy inputs must not be symbolic links");
    fileCache.set(normalized, null);
    return null;
  }
  if (!stat.isFile()) {
    report(normalized, 1, "policy inputs must be regular files");
    fileCache.set(normalized, null);
    return null;
  }
  if (stat.size > MAX_FILE_BYTES) {
    report(normalized, 1, "policy input exceeds the file-size bound");
    fileCache.set(normalized, null);
    return null;
  }
  try {
    const source = decoder.decode(fs.readFileSync(absolute));
    fileCache.set(normalized, source);
    return source;
  } catch {
    report(normalized, 1, "policy input is not valid UTF-8 text");
    fileCache.set(normalized, null);
    return null;
  }
}

function walkDirectory(relativeDirectory, selectFile, required = false) {
  const results = [];
  let start;
  try {
    start = toAbsolute(relativeDirectory);
  } catch {
    report(relativeDirectory, 1, "directory is outside the policy root");
    return results;
  }
  let startStat;
  try {
    startStat = fs.lstatSync(start);
  } catch {
    if (required) {
      report(relativeDirectory, 1, "required policy directory is missing");
    }
    return results;
  }
  if (startStat.isSymbolicLink() || !startStat.isDirectory()) {
    report(relativeDirectory, 1, "policy directory must be a real directory");
    return results;
  }

  const pending = [relativeDirectory.replaceAll("\\", "/")];
  while (pending.length > 0) {
    const currentRelative = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(toAbsolute(currentRelative), {
        withFileTypes: true,
      });
    } catch {
      report(currentRelative, 1, "policy directory could not be enumerated");
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      walkedEntries += 1;
      if (walkedEntries > MAX_WALK_ENTRIES) {
        report(
          relativeDirectory,
          1,
          "policy inventory exceeds the entry-count bound",
        );
        return results.sort();
      }
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const childRelative =
        currentRelative === "."
          ? entry.name
          : currentRelative.replace(/\/$/, "") + "/" + entry.name;
      let childStat;
      try {
        childStat = fs.lstatSync(toAbsolute(childRelative));
      } catch {
        report(childRelative, 1, "policy input disappeared during enumeration");
        continue;
      }
      if (childStat.isSymbolicLink()) {
        report(
          childRelative,
          1,
          "policy inventory must not contain symbolic links",
        );
      } else if (childStat.isDirectory()) {
        pending.push(childRelative);
      } else if (childStat.isFile()) {
        if (selectFile(childRelative)) results.push(childRelative);
      } else {
        report(
          childRelative,
          1,
          "policy inventory must contain only regular files and directories",
        );
      }
    }
  }
  return results.sort();
}

function sourceLines(source) {
  return source.split(/\r?\n/);
}

function countOccurrences(source, needle) {
  if (needle === "") return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function lineOf(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function rememberImage(reference, relativePath, line) {
  const match = pinnedImagePattern.exec(reference);
  if (!match) {
    report(
      relativePath,
      line,
      "external image must use a readable tag plus an exact sha256 digest",
    );
    return null;
  }
  const identity = match[1] + ":" + match[2];
  const digest = match[3];
  const previous = imageDigests.get(identity);
  if (previous !== undefined && previous !== digest) {
    report(
      relativePath,
      line,
      "the same image tag resolves to more than one reviewed digest",
    );
  } else if (previous === undefined) {
    imageDigests.set(identity, digest);
  }
  immutableImageReferences += 1;
  return { identity, tag: match[2], digest };
}

function normalizedVersion(value) {
  return value.startsWith("v") ? value.slice(1) : value;
}

function validateVersionComment(comment, relativePath, line) {
  if (!versionCommentPattern.test(comment || "")) {
    report(
      relativePath,
      line,
      "remote Action pins require a same-line semantic version comment",
    );
    return false;
  }
  return true;
}

function validateWorkflow(relativePath) {
  const source = readFile(relativePath);
  if (source === null) return;
  const lines = sourceLines(source);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/\buses\s*:/.test(line)) {
      const match =
        /^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(?:#\s*(\S.*?))?\s*$/.exec(line);
      if (!match) {
        report(
          relativePath,
          index + 1,
          "Action reference must use the canonical single-line form",
        );
        continue;
      }
      const reference = match[1];
      const comment = match[2] || "";
      if (reference.startsWith("./")) {
        if (comment !== "") {
          report(
            relativePath,
            index + 1,
            "local Actions must not carry a remote version comment",
          );
        }
        continue;
      }
      if (reference.startsWith("docker://")) {
        const image = rememberImage(
          reference.slice("docker://".length),
          relativePath,
          index + 1,
        );
        const commentIsValid = validateVersionComment(
          comment,
          relativePath,
          index + 1,
        );
        if (
          image !== null &&
          commentIsValid &&
          normalizedVersion(comment) !== normalizedVersion(image.tag)
        ) {
          report(
            relativePath,
            index + 1,
            "Docker Action tag and version comment must agree",
          );
        }
        continue;
      }
      const remoteMatch =
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@([0-9a-f]{40})$/.exec(
          reference,
        );
      if (!remoteMatch) {
        report(
          relativePath,
          index + 1,
          "third-party Action must be pinned to a full lowercase 40-character commit SHA",
        );
      }
      validateVersionComment(comment, relativePath, index + 1);
    }

    if (/^\s*image\s*:/.test(line)) {
      const match = /^\s*image:\s*([^\s#]+)\s*$/.exec(line);
      if (!match) {
        report(
          relativePath,
          index + 1,
          "workflow image must use the canonical single-line form",
        );
      } else {
        rememberImage(match[1], relativePath, index + 1);
      }
    }
  }
}

function validateDockerfile(relativePath) {
  const source = readFile(relativePath);
  if (source === null) return;
  const lines = sourceLines(source);
  const isRootDockerfile =
    path.posix.dirname(relativePath) === "." &&
    (path.posix.basename(relativePath) === "Dockerfile" ||
      path.posix.basename(relativePath) === "Dockerfile.local");

  if (isRootDockerfile) {
    const syntaxMatch = /^# syntax=([^\s#]+)$/.exec(lines[0] || "");
    if (!syntaxMatch) {
      report(
        relativePath,
        1,
        "root Dockerfile must begin with an immutable BuildKit syntax reference",
      );
    } else {
      rememberImage(syntaxMatch[1], relativePath, 1);
    }
  }

  const stages = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*FROM\b/i.test(line)) continue;
    const match = /^\s*FROM\s+([^\s]+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?\s*$/i.exec(
      line,
    );
    if (!match) {
      report(
        relativePath,
        index + 1,
        "Dockerfile FROM must use the canonical immutable form",
      );
      continue;
    }
    const input = match[1];
    const lowerInput = input.toLowerCase();
    if (lowerInput !== "scratch" && !stages.has(lowerInput)) {
      rememberImage(input, relativePath, index + 1);
    }
    if (match[2]) stages.add(match[2].toLowerCase());
  }
}

function indentation(line) {
  const match = /^( *)/.exec(line);
  return match ? match[1].length : 0;
}

function validateCompose(relativePath) {
  const source = readFile(relativePath);
  if (source === null) return;
  const lines = sourceLines(source);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*image\s*:/.test(lines[index])) continue;
    const match = /^\s*image:\s*([^\s#]+)\s*$/.exec(lines[index]);
    if (!match) {
      report(
        relativePath,
        index + 1,
        "Compose image must use the canonical single-line form",
      );
      continue;
    }
    const reference = match[1];
    if (reference !== "fukamu-cycle-local-app:dev") {
      rememberImage(reference, relativePath, index + 1);
      continue;
    }

    localBuildAliasCount += 1;
    const imageIndent = indentation(lines[index]);
    let blockStart = index - 1;
    while (blockStart >= 0) {
      const candidate = lines[blockStart];
      if (
        candidate.trim() !== "" &&
        !candidate.trimStart().startsWith("#") &&
        indentation(candidate) < imageIndent
      ) {
        break;
      }
      blockStart -= 1;
    }
    const serviceIndent = blockStart >= 0 ? indentation(lines[blockStart]) : -1;
    let blockEnd = index + 1;
    while (blockEnd < lines.length) {
      const candidate = lines[blockEnd];
      if (
        candidate.trim() !== "" &&
        !candidate.trimStart().startsWith("#") &&
        indentation(candidate) <= serviceIndent
      ) {
        break;
      }
      blockEnd += 1;
    }
    const hasBuild = lines
      .slice(blockStart + 1, blockEnd)
      .some(
        (candidate) =>
          indentation(candidate) === imageIndent &&
          /^\s*build\s*:/.test(candidate),
      );
    if (!hasBuild) {
      report(
        relativePath,
        index + 1,
        "the approved local image alias must be paired with build in the same service",
      );
    }
  }
}

function parseImageConstants(
  relativePath,
  expectedNames,
  vulnerableFixtureName = null,
) {
  const source = readFile(relativePath);
  if (source === null) return;
  const found = new Map();
  const lines = sourceLines(source);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^readonly\s+([A-Z0-9_]*IMAGE)='([^']+)'$/.exec(lines[index]);
    if (!match) continue;
    if (found.has(match[1])) {
      report(
        relativePath,
        index + 1,
        `duplicate image constant ${match[1]} is not allowed`,
      );
      continue;
    }
    found.set(match[1], { reference: match[2], line: index + 1 });
  }

  for (const name of expectedNames) {
    if (!found.has(name)) {
      report(relativePath, 1, "required immutable image constant is missing");
    }
  }
  for (const [name, value] of found) {
    if (!expectedNames.has(name)) {
      report(
        relativePath,
        value.line,
        "unreviewed image constant is outside the policy set",
      );
      continue;
    }
    if (name === vulnerableFixtureName) {
      const expected =
        "alpine@sha256:ca1c944a4f8486a153024d9965aafbe24f5723c1d5c02f4964c045a16d19dc54";
      if (value.reference !== expected) {
        report(
          relativePath,
          value.line,
          "the isolated vulnerable fixture must retain its exact reviewed digest-only pin",
        );
      }
    } else {
      rememberImage(value.reference, relativePath, value.line);
    }
  }
}

function validateOperationalScript(relativePath, requiredVariables) {
  const source = readFile(relativePath);
  if (source === null) return;
  const sourceStatement = 'source "' + "$" + '{script_dir}/lib/tool-images.sh"';
  if (countOccurrences(source, sourceStatement) !== 1) {
    report(
      relativePath,
      1,
      "operational image consumers must source the immutable tool-image registry exactly once",
    );
  }
  for (const variable of requiredVariables) {
    if (countOccurrences(source, "$" + "{" + variable + "}") !== 1) {
      report(
        relativePath,
        1,
        "operational image consumer does not use its approved immutable image variable exactly once",
      );
    }
  }
  const forbiddenRepositories = [
    "rhysd/actionlint:",
    "koalaman/shellcheck:",
    "mvdan/shfmt:",
    "sqlc/sqlc:",
    "postgres:18.6-alpine3.24",
  ];
  for (const repository of forbiddenRepositories) {
    const offset = source.indexOf(repository);
    if (offset !== -1) {
      report(
        relativePath,
        lineOf(source, offset),
        "operational script contains a raw image reference outside the registry",
      );
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

function validateDocumentation(relativePath) {
  const source = readFile(relativePath, false);
  if (source === null) return;
  const lines = sourceLines(source);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const [identity, digest] of imageDigests) {
      const matcher = new RegExp(
        escapeRegExp(identity) + "(?=@|[^A-Za-z0-9._-]|$)",
        "g",
      );
      for (const match of line.matchAll(matcher)) {
        const pinned = identity + "@sha256:" + digest;
        if (!line.startsWith(pinned, match.index)) {
          report(
            relativePath,
            index + 1,
            "documented image reference must include the reviewed digest",
          );
          break;
        }
      }
    }
  }
}

const canonicalDependabot = [
  "version: 2",
  "updates:",
  '  - package-ecosystem: "github-actions"',
  '    directory: "/"',
  "    schedule:",
  '      interval: "weekly"',
  '      day: "monday"',
  '      time: "05:00"',
  '      timezone: "Asia/Tokyo"',
  "    groups:",
  "      github-actions-version-updates:",
  '        applies-to: "version-updates"',
  "        patterns:",
  '          - "*"',
  "    open-pull-requests-limit: 1",
  '  - package-ecosystem: "docker"',
  '    directory: "/"',
  "    schedule:",
  '      interval: "weekly"',
  '      day: "tuesday"',
  '      time: "05:00"',
  '      timezone: "Asia/Tokyo"',
  "    groups:",
  "      docker-version-updates:",
  '        applies-to: "version-updates"',
  "        patterns:",
  '          - "*"',
  "    open-pull-requests-limit: 1",
  '  - package-ecosystem: "docker-compose"',
  '    directory: "/"',
  "    schedule:",
  '      interval: "weekly"',
  '      day: "wednesday"',
  '      time: "05:00"',
  '      timezone: "Asia/Tokyo"',
  "    groups:",
  "      docker-compose-version-updates:",
  '        applies-to: "version-updates"',
  "        patterns:",
  '          - "*"',
  "    open-pull-requests-limit: 1",
  "",
].join("\n");

if (!rootIsSafe()) process.exit(2);

const workflowFiles = walkDirectory(
  ".github/workflows",
  (relativePath) => /\.ya?ml$/.test(relativePath),
  true,
);
if (workflowFiles.length === 0) {
  report(".github/workflows", 1, "at least one workflow is required");
}
for (const workflowFile of workflowFiles) validateWorkflow(workflowFile);

const inventoryFiles = walkDirectory(".", (relativePath) => {
  const basename = path.posix.basename(relativePath);
  return (
    /^Dockerfile(?:\.|$)/.test(basename) ||
    /\.Dockerfile$/.test(basename) ||
    /^(?:docker-)?compose(?:[.-].*)?\.ya?ml$/.test(basename)
  );
});
const dockerfiles = inventoryFiles.filter((relativePath) => {
  const basename = path.posix.basename(relativePath);
  return /^Dockerfile(?:\.|$)/.test(basename) || /\.Dockerfile$/.test(basename);
});
const composeFiles = inventoryFiles.filter((relativePath) =>
  /^(?:docker-)?compose(?:[.-].*)?\.ya?ml$/.test(
    path.posix.basename(relativePath),
  ),
);
for (const requiredDockerfile of ["Dockerfile", "Dockerfile.local"]) {
  if (!dockerfiles.includes(requiredDockerfile)) {
    report(
      requiredDockerfile,
      1,
      "required root Dockerfile is missing from the immutable inventory",
    );
  }
}
if (!composeFiles.includes("compose.local.yaml")) {
  report(
    "compose.local.yaml",
    1,
    "required Compose file is missing from the immutable inventory",
  );
}
for (const dockerfile of dockerfiles) validateDockerfile(dockerfile);
for (const composeFile of composeFiles) validateCompose(composeFile);
if (localBuildAliasCount !== 2) {
  report(
    "compose.local.yaml",
    1,
    "the approved build-only local image alias must occur exactly twice",
  );
}

parseImageConstants(
  "scripts/lib/tool-images.sh",
  new Set([
    "SUPPLY_CHAIN_ACTIONLINT_IMAGE",
    "SUPPLY_CHAIN_SHELLCHECK_IMAGE",
    "SUPPLY_CHAIN_SHFMT_IMAGE",
    "SUPPLY_CHAIN_SQLC_IMAGE",
    "SUPPLY_CHAIN_POSTGRES_IMAGE",
  ]),
);
parseImageConstants(
  "scripts/lib/security-tools.sh",
  new Set([
    "SECURITY_PNPM_IMAGE",
    "SECURITY_NODE_IMAGE",
    "SECURITY_GO_IMAGE",
    "SECURITY_GITLEAKS_IMAGE",
    "SECURITY_TRIVY_IMAGE",
    "SECURITY_TERRAFORM_IMAGE",
    "SECURITY_VULNERABLE_FIXTURE_IMAGE",
  ]),
  "SECURITY_VULNERABLE_FIXTURE_IMAGE",
);

validateOperationalScript("scripts/check-before-commit.sh", [
  "SUPPLY_CHAIN_ACTIONLINT_IMAGE",
]);
validateOperationalScript("scripts/check-shell.sh", [
  "SUPPLY_CHAIN_SHELLCHECK_IMAGE",
  "SUPPLY_CHAIN_SHFMT_IMAGE",
]);
validateOperationalScript("scripts/invoke-sqlc.sh", [
  "SUPPLY_CHAIN_SQLC_IMAGE",
]);
validateOperationalScript("scripts/reset-local-db.sh", [
  "SUPPLY_CHAIN_POSTGRES_IMAGE",
]);

const dependabotSource = readFile(".github/dependabot.yml");
if (dependabotSource !== null && dependabotSource !== canonicalDependabot) {
  report(
    ".github/dependabot.yml",
    1,
    "Dependabot must retain the reviewed weekly, one-group-per-ecosystem update contract",
  );
}

const documentationFiles = ["README.md"];
documentationFiles.push(
  ...walkDirectory("docs", (relativePath) => relativePath.endsWith(".md")),
);
documentationFiles.push(
  ...walkDirectory("infra", (relativePath) => relativePath.endsWith(".md")),
);
for (const documentationFile of [...new Set(documentationFiles)].sort()) {
  validateDocumentation(documentationFile);
}

errors.sort((left, right) => left.localeCompare(right));
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(error + "\n");
  process.exit(1);
}

process.stdout.write(
  "Supply-chain policy passed (" +
    workflowFiles.length +
    " workflows, " +
    dockerfiles.length +
    " Dockerfiles, " +
    immutableImageReferences +
    " immutable image references).\n",
);
