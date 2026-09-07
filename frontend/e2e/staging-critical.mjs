import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  deriveBootstrapUUIDv7,
  formatStagingCriticalDiagnostic,
  parseAnonymousSession,
  parseStagingAdmissionMode,
  parseStagingBaseURL,
  parseStagingCriticalMode,
  runStagingCritical,
  StagingCriticalFailure,
  validateStagingInviteToken,
} from "../../scripts/lib/staging-critical.mjs";
import { enterStagingCritical } from "./staging-critical-entry.mjs";

const actionTimeoutMilliseconds = 45_000;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const authenticatedUserIDHeader = "x-fukamu-authenticated-user-id";
const expectedUserIDHeader = "X-Fukamu-Expected-User-ID";

let inviteToken = "";
let browser;
let context;
let page;
let interrupted = false;

const interrupt = () => {
  interrupted = true;
  if (page !== undefined && !page.isClosed()) {
    void page.close({ runBeforeUnload: false }).catch(() => undefined);
  }
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

let failures;
let runMetadata = { runID: "local", runAttempt: "local", commitSHA: "local" };
try {
  const mode = parseStagingCriticalMode(process.env.STAGING_CRITICAL_MODE);
  const admissionMode = parseStagingAdmissionMode(
    process.env.STAGING_ADMISSION_MODE,
  );
  const baseURL = parseStagingBaseURL(process.env.STAGING_BASE_URL);
  if (admissionMode !== "off") {
    inviteToken = validateStagingInviteToken(
      process.env.STAGING_E2E_INVITE_TOKEN,
    );
  }
  delete process.env.STAGING_E2E_INVITE_TOKEN;
  delete process.env.DEBUG;
  delete process.env.NODE_DEBUG;
  delete process.env.NODE_OPTIONS;
  delete process.env.PWDEBUG;

  const run = stagingRunIdentity();
  runMetadata = run.metadata;
  const bootstrapID = deriveBootstrapUUIDv7(
    `${run.key}:${mode}`,
    run.timestampMilliseconds,
  );
  const marker = randomBytes(6).toString("hex");
  const goalText = `Staging critical ${marker}`;
  failures = await runStagingCritical({
    mode,
    admissionMode,
    adapter: {
      async launch() {
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
      },
      async checkHealth() {
        return responseStatus(page, `${baseURL}/healthz`);
      },
      async checkReadiness() {
        return responseStatus(page, `${baseURL}/readyz`);
      },
      async seedBootstrap() {
        throwIfInterrupted();
        await seedBootstrapID(page, bootstrapID);
      },
      async enter(currentAdmissionMode) {
        const currentInviteToken = inviteToken;
        inviteToken = "";
        return enterStagingCritical({
          context,
          page,
          baseURL,
          admissionMode: currentAdmissionMode,
          inviteToken: currentInviteToken,
          captureAnonymousSession,
        });
      },
      async discoverSession() {
        return discoverSession(context, baseURL);
      },
      async runFullJourney(setPhase) {
        await runFullJourney(page, baseURL, goalText, marker, setPhase);
      },
      async beforeCleanup() {
        if (page !== undefined && !page.isClosed()) {
          await page.close({ runBeforeUnload: false });
        }
      },
      async deleteAccount(currentSession) {
        return deleteAccount(context, baseURL, currentSession);
      },
      async verifyDeleted() {
        return sessionStatus(context, baseURL);
      },
      async close() {
        if (context !== undefined) await context.close();
        if (browser !== undefined) await browser.close();
      },
    },
  });
} catch {
  failures = [new StagingCriticalFailure("configuration", "unexpected_status")];
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

if (interrupted && failures.length === 0) {
  failures.push(
    new StagingCriticalFailure("browser_launch", "unexpected_status"),
  );
}

for (const failure of failures) {
  process.stderr.write(
    `${formatStagingCriticalDiagnostic(failure, runMetadata)}\n`,
  );
}
if (failures.length > 0 || interrupted) {
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Staging critical journey and public account cleanup succeeded.\n",
  );
}

async function responseStatus(currentPage, URL) {
  throwIfInterrupted();
  const response = await currentPage.goto(URL, {
    waitUntil: "domcontentloaded",
  });
  return response?.status();
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
      metadata: {
        runID: "local",
        runAttempt: "local",
        commitSHA: "local",
      },
    };
  }

  const repository = process.env.GITHUB_REPOSITORY;
  const runID = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const commitSHA = process.env.COMMIT_SHA;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    typeof runID !== "string" ||
    !/^[1-9][0-9]*$/.test(runID) ||
    typeof runAttempt !== "string" ||
    !/^[1-9][0-9]*$/.test(runAttempt) ||
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
    metadata: { runID, runAttempt, commitSHA },
  };
}

async function runFullJourney(
  currentPage,
  baseURL,
  goalText,
  marker,
  setPhase,
) {
  setPhase("goal_creation");
  throwIfInterrupted();
  await currentPage
    .getByRole("button", {
      name: "\u65b0\u3057\u3044\u76ee\u6a19\u3092\u8a2d\u5b9a",
    })
    .click();
  const goalEditor = currentPage.getByRole("textbox", {
    name: "\u3042\u306a\u305f\u306e\u76ee\u6a19",
  });
  await goalEditor.waitFor({ state: "visible" });
  await saveText(currentPage, goalEditor, goalText, "/api/v1/goal-drafts/");
  await currentPage
    .getByRole("button", {
      name: "\u3053\u306e\u76ee\u6a19\u3067\u59cb\u3081\u308b",
    })
    .click();
  await currentPage
    .getByText(/Goal v1 .* Cycle 1/)
    .first()
    .waitFor({
      state: "visible",
    });

  setPhase("cycle_editing");
  throwIfInterrupted();
  await saveFrame(currentPage, "P", `Plan ${marker}`, "D");
  await saveFrame(currentPage, "D", `Do ${marker}`, "C");
  await saveFrame(currentPage, "C", `Check ${marker}`, "A");
  await saveFrame(currentPage, "A", `Action ${marker}`, "A");

  setPhase("cycle_completion");
  throwIfInterrupted();
  const completeCycleName = "\u30b5\u30a4\u30af\u30eb\u3092\u5b8c\u4e86";
  await currentPage.getByRole("button", { name: completeCycleName }).click();
  await currentPage
    .getByRole("dialog")
    .getByRole("button", { name: completeCycleName })
    .click();

  setPhase("review_transition");
  throwIfInterrupted();
  await currentPage.getByRole("heading", { name: goalText }).waitFor({
    state: "visible",
  });
  await currentPage
    .getByRole("button", {
      name: "\u3053\u306e\u76ee\u6a19\u3067\u6b21\u306e\u30b5\u30a4\u30af\u30eb\u3078",
    })
    .click();
  await currentPage
    .getByText(/Goal v1 .* Cycle 2/)
    .first()
    .waitFor({
      state: "visible",
    });

  setPhase("history_verification");
  throwIfInterrupted();
  await currentPage.goto(`${baseURL}/history`, {
    waitUntil: "domcontentloaded",
  });
  await currentPage
    .getByRole("heading", { name: "\u76ee\u6a19\u306e\u5c65\u6b74" })
    .waitFor({ state: "visible" });
  const historyGoal = currentPage
    .locator('a[href^="/history/goals/"]')
    .filter({ hasText: goalText });
  if ((await historyGoal.count()) !== 1) {
    throw new Error("staging history goal cardinality is invalid");
  }
  await historyGoal.click();
  const firstVersion = currentPage.locator('[data-version-number="1"]');
  await firstVersion.getByText("GOAL V1", { exact: true }).waitFor({
    state: "visible",
  });
  await currentPage.getByRole("link", { name: /Cycle 1/ }).waitFor({
    state: "visible",
  });
  await currentPage.getByRole("link", { name: /Cycle 2/ }).waitFor({
    state: "visible",
  });
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

async function sessionStatus(currentContext, baseURL) {
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
  return status;
}
