import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const retirementAssets = fileURLToPath(
  new URL("../../cloudflare/legacy-retirement/public/", import.meta.url),
);
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "object-src 'none'",
].join("; ");

let server: Server;
let retirementOrigin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://retirement.test")
      .pathname;
    if (pathname === "/fixture") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end("<!doctype html><title>Legacy fixture</title>");
      return;
    }

    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!["index.html", "retire.mjs", "style.css"].includes(fileName)) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const body = readFileSync(join(retirementAssets, fileName));
    response.writeHead(200, {
      "Content-Type":
        contentTypes[extname(fileName)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy,
      "X-Robots-Tag": "noindex, nofollow",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("legacy retirement fixture server is unavailable");
  }
  retirementOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("legacy retirement fences a real v1 tab before cleanup and leaves the current database untouched", async ({
  context,
}) => {
  const legacyTab = await context.newPage();
  await legacyTab.goto(`${retirementOrigin}/fixture`);
  await legacyTab.evaluate(async () => {
    const now = Date.now();
    const open = indexedDB.open("pdcai-browser-drafts-v2", 1);
    open.onupgradeneeded = () =>
      open.result.createObjectStore("drafts", { keyPath: "key" });
    const legacyDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const transaction = legacyDatabase.transaction("drafts", "readwrite");
    const store = transaction.objectStore("drafts");
    store.put({
      key: "current:fresh",
      userId: "current",
      subjectKey: "fresh",
      body: "fresh input",
      baseRevision: 0,
      updatedAt: new Date(now).toISOString(),
    });
    store.put({
      key: "other:expired",
      userId: "other",
      subjectKey: "expired",
      body: "expired input",
      baseRevision: 0,
      updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    Object.assign(globalThis, { legacyDatabase });

    const currentOpen = indexedDB.open("fukamu-cycle-browser-drafts-v2", 1);
    currentOpen.onupgradeneeded = () =>
      currentOpen.result.createObjectStore("drafts", { keyPath: "key" });
    const currentDatabase = await new Promise<IDBDatabase>(
      (resolve, reject) => {
        currentOpen.onsuccess = () => resolve(currentOpen.result);
        currentOpen.onerror = () => reject(currentOpen.error);
      },
    );
    const currentTransaction = currentDatabase.transaction(
      "drafts",
      "readwrite",
    );
    currentTransaction.objectStore("drafts").put({
      key: "cycle:untouched",
      userId: "cycle",
      subjectKey: "untouched",
      body: "current origin record",
      baseRevision: 0,
      updatedAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
    });
    await new Promise<void>((resolve, reject) => {
      currentTransaction.oncomplete = () => resolve();
      currentTransaction.onerror = () => reject(currentTransaction.error);
      currentTransaction.onabort = () => reject(currentTransaction.error);
    });
    currentDatabase.close();
  });

  const retirementTab = await context.newPage();
  await retirementTab.goto(retirementOrigin);
  const status = retirementTab.locator("[data-retirement-status]");
  await expect(status).toHaveAttribute("data-state", "blocked");
  await expect(status).toContainText("他のPDCAIタブをすべて閉じて");

  await legacyTab.close();
  await retirementTab.locator("[data-retirement-retry]").click();
  await expect(status).toHaveAttribute("data-state", "complete");

  const outcome = await retirementTab.evaluate(async () => {
    const read = async (name: string) => {
      const open = indexedDB.open(name);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const transaction = database.transaction("drafts", "readonly");
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const request = transaction.objectStore("drafts").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return { version: database.version, count: records.length };
    };
    const versionOneOpen = await new Promise<string>((resolve) => {
      const request = indexedDB.open("pdcai-browser-drafts-v2", 1);
      request.onsuccess = () => {
        request.result.close();
        resolve("unexpected-success");
      };
      request.onerror = () => resolve(request.error?.name ?? "unknown-error");
    });
    return {
      legacy: await read("pdcai-browser-drafts-v2"),
      current: await read("fukamu-cycle-browser-drafts-v2"),
      versionOneOpen,
    };
  });

  expect(outcome).toEqual({
    legacy: { version: 2, count: 1 },
    current: { version: 1, count: 1 },
    versionOneOpen: "VersionError",
  });
});
