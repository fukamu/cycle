import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const metricsScript = resolve(testDirectory, "../report-reform-metrics.mjs");

function write(root, relativePath, content) {
  const absolutePath = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function gitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) {
      delete environment[key];
    }
  }
  return environment;
}

function git(root, arguments_) {
  return execFileSync("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createFixture(parent, name, expanded) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });

  write(root, ".gitignore", "frontend/dist/\n");
  write(
    root,
    "frontend/package.json",
    `${JSON.stringify(
      {
        dependencies: expanded
          ? { react: "1.0.0", zod: "1.0.0" }
          : { react: "1.0.0" },
        devDependencies: { vitest: "1.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    "frontend/src/App.tsx",
    expanded
      ? "export const first = 1;\nexport const second = 2;\n"
      : "export const first = 1;\n",
  );
  write(root, "frontend/src/App.test.tsx", "export const testCase = true;\n");
  write(root, "frontend/src/styles.css", ":root { color: black; }\n");
  write(
    root,
    "frontend/e2e/critical.spec.ts",
    "export const journey = true;\n",
  );
  write(root, "frontend/vite/helper.ts", "export const helper = true;\n");

  write(
    root,
    "backend/go.mod",
    `module example.test/metrics

go 1.26.0

require example.test/direct v1.0.0

require example.test/indirect v1.0.0 // indirect
`,
  );
  write(root, "backend/cmd/server/main.go", "package main\n\nfunc main() {}\n");
  write(root, "backend/cmd/server/main_test.go", "package main\n");
  write(
    root,
    "backend/internal/infrastructure/postgres/store.go",
    "package postgres\n\nfunc calls() {\n\ttx.Exec(ctx)\n\ttx.QueryRow(ctx)\n}\n",
  );
  write(root, "backend/migrations/000001_base.up.sql", "SELECT 1;\n");
  write(root, "backend/migrations/000001_base.down.sql", "SELECT 1;\n");
  write(root, "backend/queries/read.sql", "SELECT 1;\n");

  write(root, "cloudflare/src/index.ts", "export default {};\n");
  write(root, "scripts/check.sh", "#!/usr/bin/env bash\nexit 0\n");
  write(root, ".github/scripts/helper.sh", "#!/usr/bin/env bash\nexit 0\n");
  write(root, ".github/workflows/ci.yml", "name: CI\n");
  write(root, "infra/terraform/staging/main.tf", "terraform {}\n");
  write(root, "infra/terraform/staging/.terraform.lock.hcl", "provider lock\n");
  write(root, "README.md", "# Fixture\n");
  write(root, "docs/design.md", "# Design\n\nContract.\n");
  write(root, "docs/development.md", "# Development\n");
  if (expanded) {
    write(root, "docs/operations.md", "# Operations\n");
  }

  execFileSync("git", ["init", "--initial-branch=main", root], {
    env: gitEnvironment(),
    stdio: "ignore",
  });
  git(root, ["add", "--all"]);
  git(root, [
    "-c",
    "user.name=Metrics Test",
    "-c",
    "user.email=metrics@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);

  write(
    root,
    "frontend/dist/assets/app.js",
    expanded ? "console.log('after');\n" : "console.log('before');\n",
  );
  write(root, "frontend/dist/assets/app.css", "body { color: black; }\n");
  return root;
}

function createFakeGo(parent) {
  const bin = join(parent, "bin");
  const executable = join(bin, "go");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "list" && "$2" == "-m" && "$3" == "all" ]]
printf '%s\n' 'example.test/metrics' 'example.test/direct v1.0.0' 'example.test/indirect v1.0.0'
`,
    "utf8",
  );
  chmodSync(executable, 0o755);
  return bin;
}

test("repository metrics compare clean checkouts and reject dirty input", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cycle-repository-metrics-"));
  try {
    const beforeRoot = createFixture(fixtureRoot, "before", false);
    const afterRoot = createFixture(fixtureRoot, "after", true);
    const fakeBin = createFakeGo(fixtureRoot);
    const environment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };

    const output = execFileSync(
      process.execPath,
      [
        metricsScript,
        "--before-root",
        beforeRoot,
        "--after-root",
        afterRoot,
        "--format",
        "json",
      ],
      { encoding: "utf8", env: environment },
    );
    const report = JSON.parse(output);

    assert.equal(report.schema_version, 1);
    assert.equal(report.before.frontend.production_ts_tsx.files, 1);
    assert.equal(report.before.frontend.all.files, 5);
    assert.equal(report.before.frontend.dependencies.runtime, 1);
    assert.equal(report.after.frontend.dependencies.runtime, 2);
    assert.equal(report.before.backend.dependencies.direct, 1);
    assert.equal(report.before.backend.dependencies.indirect, 1);
    assert.equal(report.before.backend.dependencies.module_graph, 3);
    assert.equal(report.before.backend.handwritten_postgresql_calls, 2);
    assert.equal(report.before.backend.sql.files, 3);
    assert.equal(report.before.backend.sql.migration_pairs, 1);
    assert.equal(report.before.scripts.files, 2);
    assert.equal(report.before.terraform.files, 2);
    assert.equal(report.before.documents.files, 3);
    assert.equal(report.before.documents.design_loc, 3);
    assert.equal(report.after.tracked_files, report.before.tracked_files + 1);
    assert.ok(
      report.after.frontend.production_ts_tsx.loc >
        report.before.frontend.production_ts_tsx.loc,
    );
    assert.ok(report.before.frontend.bundle.javascript.gzip_bytes > 0);

    write(afterRoot, "frontend/src/App.tsx", "dirty\n");
    const dirty = spawnSync(
      process.execPath,
      [
        metricsScript,
        "--before-root",
        beforeRoot,
        "--after-root",
        afterRoot,
        "--format",
        "json",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /^METRICS_CHECKOUT_DIRTY:/);
    assert.doesNotMatch(dirty.stderr, /dirty\n/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
