import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  accountCorrelation,
  deriveBootstrapUUIDv7,
  parseAnonymousSession,
  parseStagingBaseURL,
  retryPublicAccountDelete,
  validateStagingInviteToken,
} from "../../scripts/lib/staging-critical.mjs";

const actionTimeoutMilliseconds = 45_000;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const authenticatedUserIDHeader = "x-fukamu-authenticated-user-id";
const expectedUserIDHeader = "X-Fukamu-Expected-User-ID";

let phase = "configuration";
let inviteToken = "";
let browser;
let context;
let page;
let session;
let bootstrapMayHaveRun = false;
let interrupted = false;
let journeyFailurePhase;
let cleanupFailed = false;
let cleanupAccountCorrelation;

const interrupt = () => {
  interrupted = true;
  if (page !== undefined && !page.isClosed()) {
    void page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const baseURL = parseStagingBaseURL(process.env.STAGING_BASE_URL);
  inviteToken = validateStagingInviteToken(
    process.env.STAGING_E2E_INVITE_TOKEN,
  );
  delete process.env.STAGING_E2E_INVITE_TOKEN;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;

  const run = stagingRunIdentity();
  const bootstrapID = deriveBootstrapUUIDv7(run.key, run.timestampMilliseconds);
  const marker = randomBytes(6).toString("hex");
  const goalText = `Staging critical ${marker}`;

  phase = "browser-launch";
  throwIfInterrupted();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    baseURL,
    locale: "ja-JP",
    serviceWorkers: "block",
  });
  page = await context.newPage();
  page.setDefaultTimeout(actionTimeoutMilliseconds);
  page.setDefaultNavigationTimeout(actionTimeoutMilliseconds);

  phase = "bootstrap-seed";
  throwIfInterrupted();
  const healthResponse = await page.goto(`${baseURL}/healthz`, {
    waitUntil: "domcontentloaded",
  });
  if (healthResponse === null || healthResponse.status() !== 200) {
    throw new Error("staging health check failed");
  }
  await seedBootstrapID(page, bootstrapID);
  await context.addInitScript((token) => {
    if (
      globalThis.location.pathname !== "/" ||
      globalThis.location.hash !== ""
    ) {
      return;
    }
    const fragment = new globalThis.URLSearchParams();
    fragment.set("beta-invite", token);
    globalThis.history.replaceState(
      globalThis.history.state,
      "",
      `${globalThis.location.pathname}${globalThis.location.search}#${fragment.toString()}`,
    );
  }, inviteToken);
  inviteToken = "";

  phase = "admission";
  throwIfInterrupted();
  const sessionCapturePromise = captureAnonymousSession(page);
  bootstrapMayHaveRun = true;
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  const admissionButton = page.getByRole("button", {
    name: "\u5229\u7528\u3092\u958b\u59cb\u3059\u308b",
  });
  const newGoalButton = page.getByRole("button", {
    name: "\u65b0\u3057\u3044\u76ee\u6a19\u3092\u8a2d\u5b9a",
  });
  await admissionButton.or(newGoalButton).first().waitFor({
    state: "visible",
  });
  await page.waitForFunction(
    () => !globalThis.location.hash.includes("beta-invite"),
  );
  if (await admissionButton.isVisible()) {
    await admissionButton.click();
  }
  await newGoalButton.waitFor({ state: "visible" });

  phase = "session";
  throwIfInterrupted();
  session = await sessionCapturePromise;
  if (session === undefined) {
    throw new Error("anonymous session was not established");
  }
  cleanupAccountCorrelation = accountCorrelation(session.userID);

  phase = "goal-creation";
  throwIfInterrupted();
  await newGoalButton.click();
  const goalEditor = page.getByRole("textbox", {
    name: "\u3042\u306a\u305f\u306e\u76ee\u6a19",
  });
  await goalEditor.waitFor({ state: "visible" });
  await saveText(page, goalEditor, goalText, "/api/v1/goal-drafts/");
  await page
    .getByRole("button", {
      name: "\u3053\u306e\u76ee\u6a19\u3067\u59cb\u3081\u308b",
    })
    .click();
  await page
    .getByText(/Goal v1 .* Cycle 1/)
    .first()
    .waitFor({
      state: "visible",
    });

  phase = "cycle-editing";
  throwIfInterrupted();
  await saveFrame(page, "P", `Plan ${marker}`, "D");
  await saveFrame(page, "D", `Do ${marker}`, "C");
  await saveFrame(page, "C", `Check ${marker}`, "A");
  await saveFrame(page, "A", `Action ${marker}`, "A");

  phase = "cycle-completion";
  throwIfInterrupted();
  const completeCycleName = "\u30b5\u30a4\u30af\u30eb\u3092\u5b8c\u4e86";
  await page.getByRole("button", { name: completeCycleName }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: completeCycleName })
    .click();

  phase = "review-transition";
  throwIfInterrupted();
  await page.getByRole("heading", { name: goalText }).waitFor({
    state: "visible",
  });
  await page
    .getByRole("button", {
      name: "\u3053\u306e\u76ee\u6a19\u3067\u6b21\u306e\u30b5\u30a4\u30af\u30eb\u3078",
    })
    .click();
  await page
    .getByText(/Goal v1 .* Cycle 2/)
    .first()
    .waitFor({
      state: "visible",
    });

  phase = "history-verification";
  throwIfInterrupted();
  await page.goto(`${baseURL}/history`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", {
      name: "\u76ee\u6a19\u306e\u5c65\u6b74",
    })
    .waitFor({ state: "visible" });
  const historyGoal = page
    .locator('a[href^="/history/goals/"]')
    .filter({ hasText: goalText });
  if ((await historyGoal.count()) !== 1) {
    throw new Error("staging history goal cardinality is invalid");
  }
  await historyGoal.click();
  const firstVersion = page.locator('[data-version-number="1"]');
  await firstVersion.getByText("GOAL V1", { exact: true }).waitFor({
    state: "visible",
  });
  await page.getByRole("link", { name: /Cycle 1/ }).waitFor({
    state: "visible",
  });
  await page.getByRole("link", { name: /Cycle 2/ }).waitFor({
    state: "visible",
  });
} catch {
  journeyFailurePhase = phase;
}

try {
  if (context !== undefined) {
    if (page !== undefined && !page.isClosed()) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }

    if (bootstrapMayHaveRun) {
      try {
        const discoveredSession = await discoverSession(
          context,
          parseStagingBaseURL(process.env.STAGING_BASE_URL),
        );
        if (discoveredSession === undefined) {
          cleanupFailed = true;
        } else {
          if (
            session !== undefined &&
            session.userID !== discoveredSession.userID
          ) {
            cleanupFailed = true;
          }
          session = discoveredSession;
          cleanupAccountCorrelation = accountCorrelation(session.userID);
        }
      } catch {
        if (session === undefined) {
          cleanupFailed = true;
        }
      }
    }

    if (session !== undefined) {
      try {
        const baseURL = parseStagingBaseURL(process.env.STAGING_BASE_URL);
        await retryPublicAccountDelete(() =>
          deleteAccount(context, baseURL, session),
        );
        await verifySessionDeleted(context, baseURL);
      } catch {
        cleanupFailed = true;
      }
    }
  }
} finally {
  inviteToken = "";
  if (context !== undefined) {
    await context.close().catch(() => undefined);
  }
  if (browser !== undefined) {
    await browser.close().catch(() => undefined);
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

if (cleanupFailed) {
  const correlation = cleanupAccountCorrelation ?? "unavailable";
  process.stderr.write(
    `::error::Staging account cleanup failed; account_correlation=${correlation}; retry only the public account-delete workflow path.\n`,
  );
}
if (journeyFailurePhase !== undefined) {
  process.stderr.write(
    `::error::Staging critical journey failed at phase=${journeyFailurePhase}.\n`,
  );
}
if (cleanupFailed || journeyFailurePhase !== undefined || interrupted) {
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Staging critical journey and public account cleanup succeeded.\n",
  );
}

function throwIfInterrupted() {
  if (interrupted) {
    throw new Error("staging journey interrupted");
  }
}

function stagingRunIdentity() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return {
      key: randomBytes(32).toString("hex"),
      timestampMilliseconds: Date.now(),
    };
  }

  const repository = process.env.GITHUB_REPOSITORY;
  const runID = process.env.GITHUB_RUN_ID;
  const commitSHA = process.env.COMMIT_SHA;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    typeof runID !== "string" ||
    !/^[1-9][0-9]*$/.test(runID) ||
    typeof commitSHA !== "string" ||
    !/^[0-9a-f]{40}$/.test(commitSHA)
  ) {
    throw new Error("GitHub staging run identity is invalid");
  }

  const commitSeconds = execFileSync(
    "git",
    [
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
      "show",
      "-s",
      "--format=%ct",
      commitSHA,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
  if (!/^[0-9]{1,12}$/.test(commitSeconds)) {
    throw new Error("GitHub staging commit timestamp is invalid");
  }
  const timestampMilliseconds = Number(commitSeconds) * 1_000;
  if (!Number.isSafeInteger(timestampMilliseconds)) {
    throw new Error("GitHub staging commit timestamp is invalid");
  }
  return {
    key: `${repository}:${runID}:${commitSHA}`,
    timestampMilliseconds,
  };
}

async function seedBootstrapID(currentPage, bootstrapID) {
  await currentPage.evaluate(
    ({ databaseName, storeName, key, value }) =>
      new Promise((resolve, reject) => {
        const openRequest = globalThis.indexedDB.open(databaseName, 1);
        openRequest.onupgradeneeded = () => {
          if (!openRequest.result.objectStoreNames.contains(storeName)) {
            openRequest.result.createObjectStore(storeName);
          }
        };
        openRequest.onerror = () => reject(new Error("bootstrap open failed"));
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          const transaction = database.transaction(storeName, "readwrite");
          transaction.objectStore(storeName).put(value, key);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(new Error("bootstrap write failed"));
          };
          transaction.onabort = () => {
            database.close();
            reject(new Error("bootstrap write aborted"));
          };
        };
      }),
    {
      databaseName: "fukamu-cycle-bootstrap",
      storeName: "bootstrap",
      key: "pending",
      value: bootstrapID,
    },
  );
}

function captureAnonymousSession(currentPage) {
  return currentPage
    .waitForResponse(
      (candidate) => {
        const URL = new globalThis.URL(candidate.url());
        return (
          candidate.request().method() === "POST" &&
          URL.pathname === "/api/v1/session/anonymous" &&
          (candidate.status() === 200 || candidate.status() === 201)
        );
      },
      { timeout: 120_000 },
    )
    .then(
      async (response) => {
        try {
          return parseAnonymousSession(
            await response.json(),
            response.headers()[authenticatedUserIDHeader],
          );
        } catch {
          return undefined;
        }
      },
      () => undefined,
    );
}

async function discoverSession(currentContext, baseURL) {
  const response = await currentContext.request.get(
    `${baseURL}/api/v1/session`,
    {
      headers: { Accept: "application/json", Origin: baseURL },
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: actionTimeoutMilliseconds,
    },
  );
  const status = response.status();
  if (status === 401) {
    await response.dispose();
    return undefined;
  }
  if (status !== 200) {
    await response.dispose();
    throw new Error("staging session discovery failed");
  }

  const authenticatedUserID = response.headers()[authenticatedUserIDHeader];
  let payload;
  try {
    payload = await response.json();
  } catch {
    await response.dispose();
    throw new Error("staging session response is not JSON");
  }
  await response.dispose();
  return parseAnonymousSession(payload, authenticatedUserID);
}

async function saveText(currentPage, editor, content, URLPart) {
  const responsePromise = currentPage.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate.url().includes(URLPart),
  );
  await editor.fill(content);
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error("staging autosave failed");
  }
  await currentPage
    .getByText("\u4fdd\u5b58\u6e08\u307f", { exact: true })
    .first()
    .waitFor({ state: "visible" });
}

async function saveFrame(currentPage, frame, content, nextFrame) {
  const responsePromise = currentPage.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate
        .url()
        .endsWith(
          `/frames/${{ P: "plan", D: "do", C: "check", A: "action" }[frame]}`,
        ),
  );
  const editor = currentPage.getByRole("textbox", {
    name: new RegExp(`^${frame}`),
  });
  await editor.fill(content);
  if (nextFrame === frame) {
    await editor.blur();
  } else {
    await currentPage
      .getByRole("tab", { name: new RegExp(`^${nextFrame}`) })
      .click();
  }
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error("staging frame autosave failed");
  }
  await currentPage
    .getByText("\u4fdd\u5b58\u6e08\u307f", { exact: true })
    .first()
    .waitFor({ state: "visible" });
}

async function deleteAccount(currentContext, baseURL, currentSession) {
  const response = await currentContext.request.delete(
    `${baseURL}/api/v1/account`,
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Origin: baseURL,
        "X-CSRF-Token": currentSession.csrfToken,
        [expectedUserIDHeader]: currentSession.userID,
      },
      data: { confirmed: true },
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: actionTimeoutMilliseconds,
    },
  );
  const result = {
    status: response.status(),
    authenticatedUserIDVerified:
      response.headers()[authenticatedUserIDHeader] === currentSession.userID,
  };
  await response.dispose();
  return result;
}

async function verifySessionDeleted(currentContext, baseURL) {
  const response = await currentContext.request.get(
    `${baseURL}/api/v1/session`,
    {
      headers: { Accept: "application/json", Origin: baseURL },
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: actionTimeoutMilliseconds,
    },
  );
  const status = response.status();
  await response.dispose();
  if (status !== 401) {
    throw new Error("staging account deletion did not converge");
  }
}
