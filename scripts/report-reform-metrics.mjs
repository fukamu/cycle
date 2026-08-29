#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const usage = `Usage: node ./scripts/report-reform-metrics.mjs \\
  --before-root PATH --after-root PATH [--format markdown|json]

Compare two clean, fully materialized Git worktrees. Run setup and the
frontend production build in both worktrees before collecting metrics.`;

class MetricsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new MetricsError(code, message);
}

function parseArguments(argv) {
  const options = { format: "markdown" };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      if (argv.length !== 1) {
        fail("METRICS_ARGUMENT_INVALID", "--help must be used alone.");
      }
      return { help: true };
    }

    if (
      argument !== "--before-root" &&
      argument !== "--after-root" &&
      argument !== "--format"
    ) {
      fail("METRICS_ARGUMENT_INVALID", `Unknown option: ${argument}`);
    }
    if (index + 1 >= argv.length) {
      fail("METRICS_ARGUMENT_INVALID", `${argument} requires a value.`);
    }

    const key = argument.slice(2).replaceAll("-", "_");
    if (options[key] !== undefined && key !== "format") {
      fail("METRICS_ARGUMENT_INVALID", `${argument} was provided twice.`);
    }
    options[key] = argv[index + 1];
    index += 1;
  }

  if (!options.before_root || !options.after_root) {
    fail(
      "METRICS_ARGUMENT_INVALID",
      "--before-root and --after-root are required.",
    );
  }
  if (options.format !== "markdown" && options.format !== "json") {
    fail("METRICS_ARGUMENT_INVALID", "--format must be markdown or json.");
  }

  return options;
}

function controlledGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
}

function runCommand(command, arguments_, options, errorCode, description) {
  try {
    return execFileSync(command, arguments_, {
      ...options,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const status = Number.isInteger(error?.status)
      ? ` (exit ${error.status})`
      : "";
    fail(errorCode, `${description} failed${status}.`);
  }
}

function runGit(root, arguments_, encoding = "utf8") {
  return runCommand(
    "git",
    [
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-C",
      root,
      ...arguments_,
    ],
    {
      encoding,
      env: controlledGitEnvironment(),
    },
    "METRICS_GIT_FAILED",
    "Git metrics input inspection",
  );
}

function resolveCleanWorktree(input, label) {
  let root;
  try {
    root = realpathSync(resolve(input));
  } catch {
    fail("METRICS_ROOT_INVALID", `${label} root does not exist.`);
  }

  if (!lstatSync(root).isDirectory()) {
    fail("METRICS_ROOT_INVALID", `${label} root is not a directory.`);
  }

  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]).trim();
  let canonicalTopLevel;
  try {
    canonicalTopLevel = realpathSync(topLevel);
  } catch {
    fail("METRICS_ROOT_INVALID", `${label} Git top-level cannot be resolved.`);
  }
  if (canonicalTopLevel !== root) {
    fail("METRICS_ROOT_INVALID", `${label} root must be the Git top-level.`);
  }

  const status = runGit(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    null,
  );
  if (status.length !== 0) {
    fail("METRICS_CHECKOUT_DIRTY", `${label} worktree is not clean.`);
  }

  return root;
}

function splitNul(buffer) {
  const entries = buffer.toString("utf8").split("\0");
  if (entries.at(-1) === "") {
    entries.pop();
  }
  return entries;
}

function createFileReader(root, trackedFiles) {
  const tracked = new Set(trackedFiles);
  const buffers = new Map();
  const texts = new Map();
  const lineCounts = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const rootPrefix = `${root}${sep}`;

  function absolutePath(relativePath) {
    if (!tracked.has(relativePath)) {
      fail("METRICS_FILE_INVALID", "A requested metrics file is not tracked.");
    }
    const absolute = resolve(root, ...relativePath.split("/"));
    if (!absolute.startsWith(rootPrefix)) {
      fail("METRICS_FILE_INVALID", "A tracked path escapes the worktree.");
    }
    return absolute;
  }

  function buffer(relativePath) {
    if (!buffers.has(relativePath)) {
      const absolute = absolutePath(relativePath);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail(
          "METRICS_FILE_INVALID",
          "Metrics inputs must be tracked regular files.",
        );
      }
      buffers.set(relativePath, readFileSync(absolute));
    }
    return buffers.get(relativePath);
  }

  function text(relativePath) {
    if (!texts.has(relativePath)) {
      const content = buffer(relativePath);
      if (content.includes(0)) {
        fail(
          "METRICS_FILE_INVALID",
          "A text metrics input contains a NUL byte.",
        );
      }
      try {
        texts.set(relativePath, decoder.decode(content));
      } catch {
        fail(
          "METRICS_FILE_INVALID",
          "A text metrics input is not valid UTF-8.",
        );
      }
    }
    return texts.get(relativePath);
  }

  function lines(relativePath) {
    if (!lineCounts.has(relativePath)) {
      let count = 0;
      for (const byte of buffer(relativePath)) {
        if (byte === 0x0a) {
          count += 1;
        }
      }
      lineCounts.set(relativePath, count);
    }
    return lineCounts.get(relativePath);
  }

  return { buffer, lines, text };
}

function summarizeFiles(files, reader) {
  return {
    files: files.length,
    loc: files.reduce((total, file) => total + reader.lines(file), 0),
  };
}

function parseFrontendDependencies(reader) {
  let manifest;
  try {
    manifest = JSON.parse(reader.text("frontend/package.json"));
  } catch {
    fail("METRICS_MANIFEST_INVALID", "frontend/package.json is invalid JSON.");
  }
  return {
    runtime: Object.keys(manifest.dependencies ?? {}).length,
    development: Object.keys(manifest.devDependencies ?? {}).length,
  };
}

function parseGoDependencies(reader) {
  const lines = reader.text("backend/go.mod").split(/\r?\n/);
  let inRequireBlock = false;
  let direct = 0;
  let indirect = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ")") {
      inRequireBlock = false;
      continue;
    }
    if (!inRequireBlock && !line.startsWith("require ")) {
      continue;
    }

    const entry = inRequireBlock ? line : line.slice("require ".length).trim();
    if (!entry || entry.startsWith("//")) {
      continue;
    }
    if (!/^\S+\s+\S+(?:\s+\/\/\s*indirect)?$/.test(entry)) {
      fail(
        "METRICS_MANIFEST_INVALID",
        "backend/go.mod has an unsupported require entry.",
      );
    }
    if (/\/\/\s*indirect$/.test(entry)) {
      indirect += 1;
    } else {
      direct += 1;
    }
  }

  return { direct, indirect };
}

function countGoModuleGraph(root) {
  const environment = { ...process.env };
  for (const key of ["GOENV", "GOFLAGS", "GOTOOLCHAIN", "GOWORK"]) {
    delete environment[key];
  }
  Object.assign(environment, {
    CGO_ENABLED: "0",
    GOENV: "off",
    GOFLAGS: "-mod=readonly",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
  });

  const output = runCommand(
    "go",
    ["list", "-m", "all"],
    {
      cwd: join(root, "backend"),
      encoding: "utf8",
      env: environment,
    },
    "METRICS_GO_LIST_FAILED",
    "Go module graph collection",
  );
  return output.split(/\r?\n/).filter(Boolean).length;
}

function collectBundle(root) {
  const distRoot = join(root, "frontend", "dist");
  let stat;
  try {
    stat = lstatSync(distRoot);
  } catch {
    fail(
      "METRICS_BUILD_MISSING",
      "frontend/dist is missing; build both worktrees before measurement.",
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("METRICS_BUILD_INVALID", "frontend/dist must be a real directory.");
  }

  const assets = { js: [], css: [] };
  const pending = [distRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(
          "METRICS_BUILD_INVALID",
          "frontend/dist must not contain symlinks.",
        );
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        assets.js.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        assets.css.push(absolute);
      }
    }
  }

  if (assets.js.length === 0 || assets.css.length === 0) {
    fail(
      "METRICS_BUILD_INVALID",
      "frontend/dist must contain JavaScript and CSS production assets.",
    );
  }

  function summarize(paths) {
    let rawBytes = 0;
    let gzipBytes = 0;
    for (const path of paths.sort()) {
      const content = readFileSync(path);
      rawBytes += content.length;
      gzipBytes += gzipSync(content).length;
    }
    return { files: paths.length, raw_bytes: rawBytes, gzip_bytes: gzipBytes };
  }

  return { javascript: summarize(assets.js), css: summarize(assets.css) };
}

function countHandwrittenPostgresqlCalls(files, reader) {
  const candidates = files.filter(
    (file) =>
      file.startsWith("backend/internal/infrastructure/postgres/") &&
      file.endsWith(".go") &&
      !file.endsWith("_test.go") &&
      !file.includes("/generated/"),
  );
  let calls = 0;
  for (const file of candidates) {
    calls +=
      reader.text(file).match(/\.(?:Exec|Query|QueryRow)\(/g)?.length ?? 0;
  }
  return calls;
}

function countMigrationPairs(files) {
  const migrations = new Map();
  for (const file of files) {
    const match = file.match(
      /^backend\/migrations\/(\d+_[^/]+)\.(up|down)\.sql$/,
    );
    if (!match) {
      continue;
    }
    const directions = migrations.get(match[1]) ?? new Set();
    directions.add(match[2]);
    migrations.set(match[1], directions);
  }
  for (const directions of migrations.values()) {
    if (
      directions.size !== 2 ||
      !directions.has("up") ||
      !directions.has("down")
    ) {
      fail("METRICS_MIGRATION_INVALID", "A migration pair is incomplete.");
    }
  }
  return migrations.size;
}

function collectMetrics(root) {
  const trackedFiles = splitNul(runGit(root, ["ls-files", "-z"], null));
  const reader = createFileReader(root, trackedFiles);

  const frontendAll = trackedFiles.filter((file) =>
    /^frontend\/(?:src|e2e|vite)\//.test(file),
  );
  const frontendProduction = trackedFiles.filter(
    (file) =>
      /^frontend\/src\/.*\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
  );
  const frontendTests = trackedFiles.filter(
    (file) =>
      /^frontend\/(?:src|vite)\/.*\.test\.tsx?$/.test(file) &&
      !file.startsWith("frontend/src/test/"),
  );
  const frontendE2e = trackedFiles.filter((file) =>
    /^frontend\/e2e\//.test(file),
  );
  const largestFrontend = frontendProduction
    .map((path) => ({ path, loc: reader.lines(path) }))
    .sort(
      (left, right) =>
        right.loc - left.loc || left.path.localeCompare(right.path),
    )
    .slice(0, 3);

  const backendGo = trackedFiles.filter((file) =>
    /^backend\/.*\.go$/.test(file),
  );
  const backendProductionGo = backendGo.filter(
    (file) => !file.endsWith("_test.go"),
  );
  const backendTestGo = backendGo.filter((file) => file.endsWith("_test.go"));
  const backendPackages = new Set(backendGo.map((file) => posix.dirname(file)))
    .size;
  const goDependencies = parseGoDependencies(reader);

  const backendSql = trackedFiles.filter((file) =>
    /^backend\/.*\.sql$/.test(file),
  );
  const cloudflareSource = trackedFiles.filter((file) =>
    /^cloudflare\/src\/.*\.(?:ts|mjs)$/.test(file),
  );
  const scripts = trackedFiles.filter(
    (file) =>
      file.startsWith("scripts/") || file.startsWith(".github/scripts/"),
  );
  const workflows = trackedFiles.filter((file) =>
    file.startsWith(".github/workflows/"),
  );
  const terraform = trackedFiles.filter(
    (file) =>
      /^infra\/terraform\//.test(file) &&
      (file.endsWith(".tf") || file.endsWith("/.terraform.lock.hcl")),
  );
  const documents = trackedFiles.filter((file) => file.endsWith(".md"));

  return {
    commit: runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
    tracked_files: trackedFiles.length,
    frontend: {
      production_ts_tsx: summarizeFiles(frontendProduction, reader),
      all: summarizeFiles(frontendAll, reader),
      tests: summarizeFiles(frontendTests, reader),
      e2e: summarizeFiles(frontendE2e, reader),
      largest_production: largestFrontend,
      dependencies: parseFrontendDependencies(reader),
      bundle: collectBundle(root),
    },
    backend: {
      go: summarizeFiles(backendGo, reader),
      production_go: summarizeFiles(backendProductionGo, reader),
      test_go: summarizeFiles(backendTestGo, reader),
      packages: backendPackages,
      dependencies: {
        ...goDependencies,
        module_graph: countGoModuleGraph(root),
      },
      handwritten_postgresql_calls: countHandwrittenPostgresqlCalls(
        trackedFiles,
        reader,
      ),
      sql: {
        ...summarizeFiles(backendSql, reader),
        migration_pairs: countMigrationPairs(trackedFiles),
      },
    },
    cloudflare: summarizeFiles(cloudflareSource, reader),
    scripts: summarizeFiles(scripts, reader),
    workflows: summarizeFiles(workflows, reader),
    terraform: summarizeFiles(terraform, reader),
    documents: {
      ...summarizeFiles(documents, reader),
      design_loc: reader.lines("docs/design.md"),
    },
  };
}

function markdownReport(before, after) {
  const rows = [
    ["Tracked files", (metrics) => metrics.tracked_files],
    [
      "Frontend production TS/TSX files",
      (metrics) => metrics.frontend.production_ts_tsx.files,
    ],
    [
      "Frontend production TS/TSX LOC",
      (metrics) => metrics.frontend.production_ts_tsx.loc,
    ],
    ["Frontend all files", (metrics) => metrics.frontend.all.files],
    ["Frontend all LOC", (metrics) => metrics.frontend.all.loc],
    ["Frontend test LOC", (metrics) => metrics.frontend.tests.loc],
    ["Frontend E2E LOC", (metrics) => metrics.frontend.e2e.loc],
    [
      "Frontend runtime dependencies",
      (metrics) => metrics.frontend.dependencies.runtime,
    ],
    [
      "Frontend dev dependencies",
      (metrics) => metrics.frontend.dependencies.development,
    ],
    [
      "Frontend JS raw bytes",
      (metrics) => metrics.frontend.bundle.javascript.raw_bytes,
    ],
    [
      "Frontend JS gzip bytes",
      (metrics) => metrics.frontend.bundle.javascript.gzip_bytes,
    ],
    [
      "Frontend CSS raw bytes",
      (metrics) => metrics.frontend.bundle.css.raw_bytes,
    ],
    [
      "Frontend CSS gzip bytes",
      (metrics) => metrics.frontend.bundle.css.gzip_bytes,
    ],
    ["Backend Go files", (metrics) => metrics.backend.go.files],
    ["Backend Go LOC", (metrics) => metrics.backend.go.loc],
    [
      "Backend production Go LOC",
      (metrics) => metrics.backend.production_go.loc,
    ],
    ["Backend test Go LOC", (metrics) => metrics.backend.test_go.loc],
    ["Backend packages", (metrics) => metrics.backend.packages],
    [
      "Go direct dependencies",
      (metrics) => metrics.backend.dependencies.direct,
    ],
    [
      "Go indirect dependencies",
      (metrics) => metrics.backend.dependencies.indirect,
    ],
    ["Go module graph", (metrics) => metrics.backend.dependencies.module_graph],
    [
      "Handwritten PostgreSQL calls",
      (metrics) => metrics.backend.handwritten_postgresql_calls,
    ],
    ["Backend SQL files", (metrics) => metrics.backend.sql.files],
    ["Backend SQL LOC", (metrics) => metrics.backend.sql.loc],
    ["Migration pairs", (metrics) => metrics.backend.sql.migration_pairs],
    ["Cloudflare source files", (metrics) => metrics.cloudflare.files],
    ["Cloudflare source LOC", (metrics) => metrics.cloudflare.loc],
    ["Script files", (metrics) => metrics.scripts.files],
    ["Script LOC", (metrics) => metrics.scripts.loc],
    ["Workflow files", (metrics) => metrics.workflows.files],
    ["Workflow LOC", (metrics) => metrics.workflows.loc],
    ["Terraform files", (metrics) => metrics.terraform.files],
    ["Terraform LOC", (metrics) => metrics.terraform.loc],
    ["Document files", (metrics) => metrics.documents.files],
    ["Document LOC", (metrics) => metrics.documents.loc],
    ["docs/design.md LOC", (metrics) => metrics.documents.design_loc],
  ];

  const output = [
    `Before commit: \`${before.commit}\``,
    `After commit: \`${after.commit}\``,
    "",
    "| Metric | Before | After | Delta |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const [label, read] of rows) {
    const beforeValue = read(before);
    const afterValue = read(after);
    const delta = afterValue - beforeValue;
    output.push(
      `| ${label} | ${beforeValue} | ${afterValue} | ${delta >= 0 ? "+" : ""}${delta} |`,
    );
  }

  output.push(
    "",
    "| Rank | Before largest production file | After largest production file |",
    "| ---: | --- | --- |",
  );
  for (let index = 0; index < 3; index += 1) {
    const beforeFile = before.frontend.largest_production[index];
    const afterFile = after.frontend.largest_production[index];
    output.push(
      `| ${index + 1} | \`${beforeFile?.path ?? "n/a"}\` (${beforeFile?.loc ?? 0}) | \`${afterFile?.path ?? "n/a"}\` (${afterFile?.loc ?? 0}) |`,
    );
  }

  return `${output.join("\n")}\n`;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
  } else {
    const beforeRoot = resolveCleanWorktree(options.before_root, "Before");
    const afterRoot = resolveCleanWorktree(options.after_root, "After");
    const report = {
      schema_version: 1,
      before: collectMetrics(beforeRoot),
      after: collectMetrics(afterRoot),
    };
    process.stdout.write(
      options.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : markdownReport(report.before, report.after),
    );
  }
} catch (error) {
  const code = error instanceof MetricsError ? error.code : "METRICS_FAILED";
  const message =
    error instanceof Error ? error.message : "Unknown metrics failure.";
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}
