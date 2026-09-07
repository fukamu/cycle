import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import typescript from "typescript";
import {
  LegacyRetirementBlockedError,
  legacyDraftDatabaseName,
  legacyDraftDatabaseVersion,
  retireLegacyDrafts,
} from "../../legacy-retirement/public/retire.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readRepositoryFile = (path) =>
  readFileSync(join(repositoryRoot, path), "utf8");
const currentDraftDatabaseName = "fukamu-cycle-browser-drafts-v2";
const now = Date.parse("2026-09-07T00:00:00.000Z");
const hour = 60 * 60 * 1000;
const factories = [];

afterEach(async () => {
  await Promise.all(
    factories
      .splice(0)
      .flatMap((factory) => [
        deleteDatabase(factory, legacyDraftDatabaseName),
        deleteDatabase(factory, currentDraftDatabaseName),
      ]),
  );
});

test("fences the v1 writer and keeps only valid fresh records for every user", async () => {
  const factory = createFactory();
  await seedDrafts(factory, legacyDraftDatabaseName, [
    draft("current", "fresh", now - hour),
    draft("other", "fresh", now - 23 * hour),
    draft("deleted", "fresh", now - 2 * hour),
    draft("current", "expired", now - 24 * hour),
    { ...draft("current", "invalid-date", now), updatedAt: "not-a-date" },
    {
      ...draft("current", "non-canonical-date", now),
      updatedAt: "2026-09-07T00:00:00Z",
    },
    { ...draft("current", "future", now), updatedAt: iso(now + 1) },
    { ...draft("current", "wrong-key", now), key: "mismatch" },
    { ...draft("current", "negative-revision", now), baseRevision: -1 },
  ]);

  await retireLegacyDrafts({ factory, now });

  const database = await openDatabase(factory, legacyDraftDatabaseName);
  assert.equal(database.version, legacyDraftDatabaseVersion);
  assert.deepEqual(
    (await readAll(database)).map((record) => record.key).sort(),
    ["current:fresh", "deleted:fresh", "other:fresh"],
  );
  database.close();

  await assert.rejects(
    openDatabase(factory, legacyDraftDatabaseName, 1),
    (error) => error?.name === "VersionError",
  );
});

test("deletes retained drafts at the exact 24 hour boundary and is idempotent", async () => {
  const factory = createFactory();
  await seedDrafts(factory, legacyDraftDatabaseName, [
    draft("current", "boundary", now),
  ]);

  await retireLegacyDrafts({ factory, now });
  await retireLegacyDrafts({ factory, now });
  assert.equal(await draftCount(factory, legacyDraftDatabaseName), 1);

  await retireLegacyDrafts({ factory, now: now + 24 * hour });
  await retireLegacyDrafts({ factory, now: now + 48 * hour });
  assert.equal(await draftCount(factory, legacyDraftDatabaseName), 0);
});

test("reports a blocked v1 connection and succeeds only after the old tab closes and retries", async () => {
  const factory = createFactory();
  const legacyTab = await seedDrafts(
    factory,
    legacyDraftDatabaseName,
    [draft("current", "blocked", now)],
    false,
  );

  await assert.rejects(
    retireLegacyDrafts({ factory, now }),
    (error) =>
      error instanceof LegacyRetirementBlockedError && error.code === "BLOCKED",
  );

  legacyTab.close();
  await nextTask();
  await retireLegacyDrafts({ factory, now });
  assert.equal(await draftCount(factory, legacyDraftDatabaseName), 1);
});

test("closes successful retirement connections", async () => {
  const factory = createFactory();
  await seedDrafts(factory, legacyDraftDatabaseName, []);

  await retireLegacyDrafts({ factory, now });

  const upgraded = await openDatabase(
    factory,
    legacyDraftDatabaseName,
    legacyDraftDatabaseVersion + 1,
  );
  assert.equal(upgraded.version, legacyDraftDatabaseVersion + 1);
  upgraded.close();
});

test("rejects transaction abort and synchronous transaction errors without leaking a connection", async () => {
  for (const failure of ["abort", "throw"]) {
    const factory = createFactory();
    await seedDrafts(factory, legacyDraftDatabaseName, [
      draft("current", failure, now),
    ]);
    await retireLegacyDrafts({ factory, now });

    const failingFactory = interceptOpenedDatabase(factory, (database) => ({
      get objectStoreNames() {
        return database.objectStoreNames;
      },
      set onversionchange(listener) {
        database.onversionchange = listener;
      },
      close: () => database.close(),
      transaction: (...arguments_) => {
        if (failure === "throw") throw new Error("fixture transaction error");
        const transaction = database.transaction(...arguments_);
        queueMicrotask(() => transaction.abort());
        return transaction;
      },
    }));

    await assert.rejects(
      retireLegacyDrafts({ factory: failingFactory, now }),
      (error) => error?.name === "LegacyRetirementUnavailableError",
    );

    const upgraded = await openDatabase(
      factory,
      legacyDraftDatabaseName,
      legacyDraftDatabaseVersion + 1,
    );
    upgraded.close();
  }
});

test("does not open or modify the current FUKAMU Cycle draft database", async () => {
  const factory = createFactory();
  await seedDrafts(factory, currentDraftDatabaseName, [
    draft("current", "cycle", now - 48 * hour),
  ]);
  await seedDrafts(factory, legacyDraftDatabaseName, [
    draft("legacy", "expired", now - 48 * hour),
  ]);

  await retireLegacyDrafts({ factory, now });

  const currentDatabase = await openDatabase(factory, currentDraftDatabaseName);
  assert.equal(currentDatabase.version, 1);
  assert.deepEqual(
    (await readAll(currentDatabase)).map((record) => record.key),
    ["current:cycle"],
  );
  currentDatabase.close();
  assert.equal(await draftCount(factory, legacyDraftDatabaseName), 0);
});

test("legacy deployment is static, manual, origin-bound, and data-silent", () => {
  const parsedConfig = typescript.parseConfigFileTextToJson(
    "cloudflare/legacy-retirement/wrangler.jsonc",
    readRepositoryFile("cloudflare/legacy-retirement/wrangler.jsonc"),
  );
  assert.equal(parsedConfig.error, undefined);
  const config = parsedConfig.config;
  assert.equal(config.name, "pdcai-staging");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [
    { pattern: "pdcai.matoruru.com", custom_domain: true },
  ]);
  assert.deepEqual(config.assets, { directory: "./public" });
  for (const forbidden of [
    "main",
    "containers",
    "durable_objects",
    "migrations",
    "secrets",
    "vars",
  ]) {
    assert.equal(config[forbidden], undefined, forbidden);
  }

  const module = readRepositoryFile(
    "cloudflare/legacy-retirement/public/retire.mjs",
  );
  assert.match(module, /pdcai-browser-drafts-v2/);
  assert.doesNotMatch(
    module,
    /deleteDatabase|fetch\s*\(|localStorage|sessionStorage|console\./,
  );
  assert.doesNotMatch(module, /fukamu-cycle-browser-drafts-v2/);

  const html = readRepositoryFile(
    "cloudflare/legacy-retirement/public/index.html",
  );
  assert.match(html, /data-legacy-retirement="v2"/);
  assert.match(html, /https:\/\/cycle\.staging\.fukamu\.matoruru\.com\//);
  assert.doesNotMatch(html, /<form|target=|https?:\/\/(?!cycle\.)/);

  const headers = readRepositoryFile(
    "cloudflare/legacy-retirement/public/_headers",
  );
  assert.match(headers, /Cache-Control: no-store/);
  assert.match(headers, /connect-src 'none'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /X-Robots-Tag: noindex, nofollow/);

  const workflow = readFileSync(
    join(repositoryRoot, ".github/workflows/retire-legacy-origin.yml"),
    "utf8",
  );
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(
    workflow,
    /^  (?:pull_request|push|schedule|workflow_run):/m,
  );
  assert.match(workflow, /LEGACY_RETIREMENT_APPROVER/);
  assert.match(workflow, /RETIRE pdcai\.matoruru\.com WITHOUT RECOVERY/);
  assert.match(workflow, /legacy-retirement\/wrangler\.jsonc/);
  assert.match(workflow, /--containers-rollout=none/);
  assert.doesNotMatch(
    workflow,
    /NEON_|DATABASE_URL|OPENAI_API_KEY|migrate|terraform|secret delete/,
  );
});

function createFactory() {
  const factory = new IDBFactory();
  factories.push(factory);
  return factory;
}

function draft(userId, subjectKey, updatedAt) {
  return {
    key: `${userId}:${subjectKey}`,
    userId,
    subjectKey,
    body: `${subjectKey} body`,
    baseRevision: 0,
    updatedAt: iso(updatedAt),
  };
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

async function seedDrafts(factory, name, records, close = true) {
  const database = await openDatabase(factory, name, 1, (upgradeDatabase) => {
    upgradeDatabase.createObjectStore("drafts", { keyPath: "key" });
  });
  const transaction = database.transaction("drafts", "readwrite");
  for (const record of records) transaction.objectStore("drafts").put(record);
  await transactionCompletion(transaction);
  if (close) database.close();
  return database;
}

async function draftCount(factory, name) {
  const database = await openDatabase(factory, name);
  const transaction = database.transaction("drafts", "readonly");
  const count = await requestResult(transaction.objectStore("drafts").count());
  await transactionCompletion(transaction);
  database.close();
  return count;
}

async function readAll(database) {
  const transaction = database.transaction("drafts", "readonly");
  const records = await requestResult(
    transaction.objectStore("drafts").getAll(),
  );
  await transactionCompletion(transaction);
  return records;
}

function openDatabase(factory, name, version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined ? factory.open(name) : factory.open(name, version);
    request.onupgradeneeded = () => onUpgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function deleteDatabase(factory, name) {
  return new Promise((resolve) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function interceptOpenedDatabase(factory, transform) {
  return {
    open(name, version) {
      const request = factory.open(name, version);
      return new Proxy(request, {
        get(target, property) {
          if (property === "result") return transform(target.result);
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, property, value) {
          target[property] = value;
          return true;
        },
      });
    },
  };
}
