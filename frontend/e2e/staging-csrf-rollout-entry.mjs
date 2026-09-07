import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";

import { chromium, request } from "@playwright/test";

import { parseAnonymousSession } from "../../scripts/lib/staging-critical.mjs";
import { enterStagingCritical } from "./staging-critical-entry.mjs";

const authenticatedUserIDHeader = "x-fukamu-authenticated-user-id";
const expectedUserIDHeader = "X-Fukamu-Expected-User-ID";
const sessionCookieName = "__Host-fukamu_cycle_session";
const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createStagingCSRFRolloutBrowserAdapter({
  baseURL,
  admissionMode,
  inviteToken,
  bootstrapID,
  marker,
  repositoryRoot,
  actionTimeoutMilliseconds = 45_000,
}) {
  let currentInviteToken = inviteToken;
  let browser;
  let context;
  let pageA;
  let pageB;
  let revokedSessionProbe;
  let deploymentChild;
  let deploymentChildCompletion;
  let deploymentChildTermination;
  let firstDraft;
  let secondDraft;
  let closed = false;
  let interrupted = false;

  const stopDeploymentChild = async () => {
    if (
      deploymentChild === undefined ||
      deploymentChildCompletion === undefined
    ) {
      return;
    }
    deploymentChildTermination ??= terminateDeploymentChild(
      deploymentChild,
      deploymentChildCompletion,
    );
    try {
      await deploymentChildTermination;
    } catch (error) {
      deploymentChildTermination = undefined;
      throw error;
    }
  };

  return {
    interrupt() {
      interrupted = true;
      void stopDeploymentChild().catch(() => undefined);
      if (pageA !== undefined && !pageA.isClosed()) {
        void pageA.close({ runBeforeUnload: false }).catch(() => undefined);
      }
      if (pageB !== undefined && !pageB.isClosed()) {
        void pageB.close({ runBeforeUnload: false }).catch(() => undefined);
      }
    },

    async launch() {
      browser = await chromium.launch({
        headless: true,
        env: { LANG: "C.UTF-8", TZ: "UTC" },
      });
      context = await browser.newContext({
        baseURL,
        locale: "ja-JP",
        serviceWorkers: "block",
      });
      pageA = await context.newPage();
      configurePage(pageA, actionTimeoutMilliseconds);
    },

    async prepareLegacySession() {
      await seedBootstrapID(pageA, bootstrapID);
      let session;
      try {
        session = await enterStagingCritical({
          context: {
            addInitScript: (...values) => pageA.addInitScript(...values),
          },
          page: pageA,
          baseURL,
          admissionMode,
          inviteToken: currentInviteToken,
          captureAnonymousSession: (currentPage) =>
            captureSessionResponse(
              currentPage,
              "POST",
              "/api/v1/session/anonymous",
            ),
        });
      } finally {
        currentInviteToken = "";
      }
      if (session === undefined) {
        throw new Error("legacy session preparation failed");
      }
      await pageA.evaluate(() => {
        globalThis.history.replaceState(
          globalThis.history.state,
          "",
          "/goals/new",
        );
      });
      return session;
    },

    async confirmLegacySession() {
      const response = await context.request.get(`${baseURL}/api/v1/session`, {
        headers: { Accept: "application/json", Origin: baseURL },
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: actionTimeoutMilliseconds,
      });
      try {
        if (response.status() !== 200) {
          throw new Error("legacy session confirmation failed");
        }
        return parseAnonymousSession(
          await response.json(),
          response.headers()[authenticatedUserIDHeader],
        );
      } finally {
        await response.dispose();
      }
    },

    async captureRevokedSessionProbe() {
      const cookies = await context.cookies(baseURL);
      const matches = cookies.filter(
        (cookie) =>
          cookie.name === sessionCookieName &&
          cookie.domain === new URL(baseURL).hostname &&
          cookie.path === "/" &&
          cookie.secure === true &&
          cookie.httpOnly === true,
      );
      if (
        matches.length !== 1 ||
        typeof matches[0].value !== "string" ||
        matches[0].value.length === 0 ||
        matches[0].value.length > 4096 ||
        hasUnsafeCookieCharacter(matches[0].value)
      ) {
        throw new Error("session cookie capture failed");
      }
      revokedSessionProbe = await request.newContext({
        baseURL,
        extraHTTPHeaders: {
          Accept: "application/json",
          Cookie: `${sessionCookieName}=${matches[0].value}`,
          Origin: baseURL,
        },
      });
    },

    async prepareSecondTab() {
      pageB = await context.newPage();
      configurePage(pageB, actionTimeoutMilliseconds);
      await pageB.addInitScript(() => {
        Object.defineProperty(globalThis, "BroadcastChannel", {
          configurable: true,
          value: undefined,
        });
      });
    },

    async runLegacyUnsafeRequest(session) {
      const response = await context.request.post(
        `${baseURL}/api/v1/goal-drafts`,
        requestOptions(baseURL, session, { initialBody: "" }),
      );
      try {
        firstDraft = await parseDraftSuccess(response, session.userID, 201, 0);
        return true;
      } finally {
        await response.dispose();
      }
    },

    async runDeployAndDrain() {
      if (interrupted) throw new Error("deploy adapter interrupted");
      const deployment = startFixedDeployAndDrain(repositoryRoot);
      deploymentChild = deployment.child;
      deploymentChildCompletion = deployment.completion;
      if (interrupted) {
        await stopDeploymentChild();
      }
      try {
        await deploymentChildCompletion;
      } finally {
        await stopDeploymentChild();
        deploymentChild = undefined;
        deploymentChildCompletion = undefined;
        deploymentChildTermination = undefined;
      }
    },

    async discoverTwoTabsConcurrently() {
      const captureA = captureSessionResponse(pageA, "GET", "/api/v1/session");
      const captureB = captureSessionResponse(pageB, "GET", "/api/v1/session");
      const [sessionA, sessionB] = await Promise.all([
        captureA,
        captureB,
        pageA.reload({ waitUntil: "domcontentloaded" }),
        pageB.goto(baseURL, { waitUntil: "domcontentloaded" }),
      ]);
      return [sessionA, sessionB];
    },

    async reloadTabAAndDiscover() {
      const capture = captureSessionResponse(pageA, "GET", "/api/v1/session");
      const [session] = await Promise.all([
        capture,
        pageA.reload({ waitUntil: "domcontentloaded" }),
      ]);
      return session;
    },

    async runTabAAutosave(session) {
      const editor = pageA.getByRole("textbox", {
        name: "\u3042\u306a\u305f\u306e\u76ee\u6a19",
      });
      await editor.waitFor({ state: "visible" });
      const result = await captureAuthenticatedMutation(pageA, {
        method: "PATCH",
        pathname: `/api/v1/goal-drafts/${firstDraft.id}`,
        session,
        action: () => editor.fill(`Stable rollout A ${marker}`),
      });
      firstDraft = parsePageDraftSuccess(result, session.userID, 200, 1);
      await waitForSaved(pageA);
      return true;
    },

    async runTabACommand(session) {
      const result = await captureAuthenticatedMutation(pageA, {
        method: "POST",
        pathname: `/api/v1/goal-drafts/${firstDraft.id}/start`,
        session,
        action: () =>
          pageA
            .getByRole("button", {
              name: "\u3053\u306e\u76ee\u6a19\u3067\u59cb\u3081\u308b",
            })
            .click(),
      });
      if (
        result.status !== 201 ||
        result.authenticatedUserID !== session.userID ||
        result.requestCSRFTokenVerified !== true ||
        result.requestExpectedUserIDVerified !== true ||
        !uuidV7Pattern.test(result.goalID) ||
        !uuidV7Pattern.test(result.cycleID)
      ) {
        throw new Error("tab A command failed");
      }
      return true;
    },

    async runTabBCommand(session) {
      await pageB.goto(`${baseURL}/goals/new`, {
        waitUntil: "domcontentloaded",
      });
      const createButton = pageB.getByRole("button", {
        name: "\u4e0b\u66f8\u304d\u3092\u4f5c\u6210",
      });
      await createButton.waitFor({ state: "visible" });
      const result = await captureAuthenticatedMutation(pageB, {
        method: "POST",
        pathname: "/api/v1/goal-drafts",
        session,
        action: () => createButton.click(),
      });
      secondDraft = parsePageDraftSuccess(result, session.userID, 201, 0);
      return true;
    },

    async runTabBAutosave(session) {
      const editor = pageB.getByRole("textbox", {
        name: "\u3042\u306a\u305f\u306e\u76ee\u6a19",
      });
      await editor.waitFor({ state: "visible" });
      const result = await captureAuthenticatedMutation(pageB, {
        method: "PATCH",
        pathname: `/api/v1/goal-drafts/${secondDraft.id}`,
        session,
        action: () => editor.fill(`Stable rollout B autosave ${marker}`),
      });
      secondDraft = parsePageDraftSuccess(result, session.userID, 200, 1);
      await waitForSaved(pageB);
      return true;
    },

    async verifyCSRFRejection(kind, { originalSession, stableSession }) {
      const invalidToken = createInvalidToken(
        originalSession.csrfToken,
        stableSession.csrfToken,
      );
      const csrfToken =
        kind === "legacy_token"
          ? originalSession.csrfToken
          : kind === "invalid_token"
            ? invalidToken
            : stableSession.csrfToken;
      const origin =
        kind === "invalid_origin" ? "https://invalid.example" : baseURL;
      const response = await revokedSessionProbe.patch(
        `/api/v1/goal-drafts/${secondDraft.id}`,
        {
          ...requestOptions(
            origin,
            { userID: stableSession.userID, csrfToken },
            {
              body: `Rejected rollout write ${marker}`,
              expectedRevision: secondDraft.revision,
            },
          ),
          timeout: actionTimeoutMilliseconds,
        },
      );
      try {
        return {
          status: response.status(),
          code: await safeErrorCode(response),
          authenticatedUserIDVerified:
            response.headers()[authenticatedUserIDHeader] ===
            stableSession.userID,
        };
      } finally {
        await response.dispose();
      }
    },

    async closePages() {
      if (pageA !== undefined && !pageA.isClosed()) {
        await pageA.close({ runBeforeUnload: false });
      }
      if (pageB !== undefined && !pageB.isClosed()) {
        await pageB.close({ runBeforeUnload: false });
      }
    },

    async discoverForCleanup() {
      const response = await context.request.get(`${baseURL}/api/v1/session`, {
        headers: { Accept: "application/json", Origin: baseURL },
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: actionTimeoutMilliseconds,
      });
      try {
        if (response.status() !== 200) {
          throw new Error("cleanup session discovery failed");
        }
        return parseAnonymousSession(
          await response.json(),
          response.headers()[authenticatedUserIDHeader],
        );
      } finally {
        await response.dispose();
      }
    },

    async deleteOriginalAccount(session) {
      const response = await context.request.delete(
        `${baseURL}/api/v1/account`,
        requestOptions(baseURL, session, { confirmed: true }),
      );
      try {
        return {
          status: response.status(),
          authenticatedUserIDVerified:
            response.headers()[authenticatedUserIDHeader] === session.userID,
        };
      } finally {
        await response.dispose();
      }
    },

    async verifyRevokedSession() {
      const response = await revokedSessionProbe.get("/api/v1/session", {
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: actionTimeoutMilliseconds,
      });
      try {
        return {
          status: response.status(),
          code: await safeErrorCode(response),
          authenticatedUserIDAbsent:
            response.headers()[authenticatedUserIDHeader] === undefined,
        };
      } finally {
        await response.dispose();
      }
    },

    async close() {
      if (closed) return;
      currentInviteToken = "";
      const failures = [];
      try {
        await stopDeploymentChild();
      } catch (error) {
        failures.push(error);
      } finally {
        deploymentChild = undefined;
        deploymentChildCompletion = undefined;
        deploymentChildTermination = undefined;
      }
      if (revokedSessionProbe !== undefined) {
        try {
          await revokedSessionProbe.dispose();
        } catch (error) {
          failures.push(error);
        } finally {
          revokedSessionProbe = undefined;
        }
      }
      if (context !== undefined) {
        try {
          await context.close();
        } catch (error) {
          failures.push(error);
        } finally {
          context = undefined;
        }
      }
      if (browser !== undefined) {
        try {
          await browser.close();
        } catch (error) {
          failures.push(error);
        } finally {
          browser = undefined;
        }
      }
      closed = true;
      if (failures.length > 0) {
        throw new Error("staging CSRF rollout cleanup failed");
      }
    },
  };
}

function configurePage(page, timeout) {
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
}

function startFixedDeployAndDrain(repositoryRoot) {
  const child = spawn(
    "bash",
    ["./scripts/run-staging-candidate-deploy-and-drain.sh"],
    {
      cwd: repositoryRoot,
      detached: true,
      shell: false,
      stdio: "ignore",
    },
  );
  const completion = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once("error", () =>
      settle(() => reject(new Error("deploy adapter failed"))),
    );
    child.once("exit", (code, signal) => {
      settle(() =>
        code === 0 && signal === null
          ? resolve()
          : reject(new Error("deploy adapter failed")),
      );
    });
  });
  return { child, completion };
}

async function terminateDeploymentChild(child, completion) {
  signalProcessGroup(child, "SIGTERM");
  let stopped = await waitForProcessGroupExit(child, 5_000);
  if (!stopped) {
    signalProcessGroup(child, "SIGKILL");
    stopped = await waitForProcessGroupExit(child, 5_000);
  }
  await completion.catch(() => undefined);
  if (!stopped) {
    throw new Error("deploy adapter process group cleanup failed");
  }
}

function signalProcessGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(child, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processGroupExists(child)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

function processGroupExists(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function captureSessionResponse(page, method, pathname) {
  const response = await page.waitForResponse(
    (candidate) => {
      const candidateURL = new URL(candidate.url());
      return (
        candidate.request().method() === method &&
        candidateURL.pathname === pathname &&
        candidate.status() >= 200 &&
        candidate.status() < 300
      );
    },
    { timeout: 120_000 },
  );
  try {
    return parseAnonymousSession(
      await response.json(),
      response.headers()[authenticatedUserIDHeader],
    );
  } catch {
    return undefined;
  }
}

function requestOptions(origin, session, data) {
  return {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      Origin: origin,
      "X-CSRF-Token": session.csrfToken,
      [expectedUserIDHeader]: session.userID,
    },
    data,
    failOnStatusCode: false,
    maxRedirects: 0,
  };
}

async function parseDraftSuccess(response, userID, status, revision) {
  const authenticatedUserID = response.headers()[authenticatedUserIDHeader];
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("draft response is invalid");
  }
  if (
    response.status() !== status ||
    authenticatedUserID !== userID ||
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.draft !== "object" ||
    payload.draft === null ||
    !uuidV7Pattern.test(payload.draft.id) ||
    payload.draft.draftType !== "creation" ||
    payload.draft.revision !== revision
  ) {
    throw new Error("draft response is invalid");
  }
  return { id: payload.draft.id, revision: payload.draft.revision };
}

function parsePageDraftSuccess(result, userID, status, revision) {
  if (
    typeof result !== "object" ||
    result === null ||
    result.status !== status ||
    result.authenticatedUserID !== userID ||
    result.requestCSRFTokenVerified !== true ||
    result.requestExpectedUserIDVerified !== true ||
    !uuidV7Pattern.test(result.draftID) ||
    result.draftType !== "creation" ||
    result.draftRevision !== revision
  ) {
    throw new Error("tab draft request failed");
  }
  return { id: result.draftID, revision: result.draftRevision };
}

async function captureAuthenticatedMutation(
  page,
  { method, pathname, session, action },
) {
  const responsePromise = page.waitForResponse((candidate) => {
    const candidateURL = new URL(candidate.url());
    return (
      candidate.request().method() === method &&
      candidateURL.pathname === pathname
    );
  });
  const [response] = await Promise.all([responsePromise, action()]);
  const requestHeaders = response.request().headers();
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return {
    status: response.status(),
    authenticatedUserID: response.headers()[authenticatedUserIDHeader],
    requestCSRFTokenVerified:
      requestHeaders["x-csrf-token"] === session.csrfToken,
    requestExpectedUserIDVerified:
      requestHeaders[expectedUserIDHeader.toLowerCase()] === session.userID,
    draftID: payload?.draft?.id,
    draftType: payload?.draft?.draftType,
    draftRevision: payload?.draft?.revision,
    goalID: payload?.goal?.id,
    cycleID: payload?.cycle?.id,
  };
}

async function waitForSaved(page) {
  await page
    .getByText("\u4fdd\u5b58\u6e08\u307f", { exact: true })
    .first()
    .waitFor({ state: "visible" });
}

async function safeErrorCode(response) {
  try {
    const payload = await response.json();
    return payload?.error?.code;
  } catch {
    return undefined;
  }
}

function createInvalidToken(first, second) {
  for (const candidate of ["A".repeat(43), "B".repeat(43), "_".repeat(43)]) {
    if (candidate !== first && candidate !== second) return candidate;
  }
  throw new Error("invalid token fixture could not be created");
}

function hasUnsafeCookieCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

async function seedBootstrapID(page, bootstrapID) {
  await page.evaluate(
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
