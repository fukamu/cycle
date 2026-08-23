import { expect, test, type Page, type Request } from "@playwright/test";

import { newUUIDv7 } from "../src/shared/id/uuid";
import {
  createAnonymousSession,
  expectAPIError,
  expectAPIResponseError,
  getSession,
  postGoogle,
  requestFromPage,
  type SessionView,
} from "./support/api";
import {
  googleIdentityFakeButtonName,
  installGoogleIdentityFake,
} from "./support/googleIdentity";
import {
  createProgressingGoal,
  saveFrame,
  saveText,
} from "./support/workspace";

test("same bootstrap ID and session refresh converge on one anonymous identity", async ({
  page,
}) => {
  const origin = "http://127.0.0.1:8080";
  const bootstrapId = newUUIDv7();
  const api = page.context().request;
  const [first, second] = await Promise.all([
    createAnonymousSession(api, origin, bootstrapId),
    createAnonymousSession(api, origin, bootstrapId),
  ]);
  expect([200, 201]).toContain(first.status);
  expect([200, 201]).toContain(second.status);
  expect(second.session.user.id).toBe(first.session.user.id);

  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "新しい目標を設定" }),
  ).toBeVisible();
  const initial = await getSession(page);
  expect(initial.user.id).toBe(first.session.user.id);
  const home = await requestFromPage(page, { path: "/api/v1/home" });
  expect(home).toMatchObject({
    status: 200,
    payload: { progressingGoals: [], creationDraft: null },
  });

  await page.reload();
  await expect(
    page.getByRole("button", { name: "新しい目標を設定" }),
  ).toBeVisible();
  const refreshed = await getSession(page);
  expect(refreshed.user.id).toBe(initial.user.id);
});

test("Google collision login selects the linked account without merging after reload", async ({
  browser,
}) => {
  const targetContext = await browser.newContext();
  const sourceContext = await browser.newContext();
  try {
    const subject = newUUIDv7();
    const targetGoal = "Google接続先に残る目標";
    const sourceGoal = "統合されない匿名側の目標";
    const target = await targetContext.newPage();
    await createProgressingGoal(target, targetGoal);
    const targetUpgrade = await postGoogle(target, "upgrade", subject);
    expect(targetUpgrade.status).toBe(200);
    const targetSession = targetUpgrade.payload as SessionView;
    expect(targetSession.user.googleConnected).toBe(true);

    const source = await sourceContext.newPage();
    await createProgressingGoal(source, sourceGoal);
    await source.goto("/settings");
    await expect(source.getByRole("heading", { name: "設定" })).toBeVisible();
    const collision = await postGoogle(source, "upgrade", subject);
    expect(collision).toMatchObject({
      status: 409,
      payload: { error: { code: "GOOGLE_IDENTITY_ALREADY_LINKED" } },
    });

    const login = await postGoogle(source, "login", subject);
    expect(login).toMatchObject({
      status: 200,
      payload: { user: { id: targetSession.user.id } },
    });
    await source.reload();
    await expect(source.locator("code")).toHaveText(targetSession.user.id);
    await source.goto("/");
    await expect(
      source.getByRole("link", { name: new RegExp(targetGoal) }),
    ).toBeVisible();
    await expect(source.getByText(sourceGoal)).toHaveCount(0);
  } finally {
    await targetContext.close();
    await sourceContext.close();
  }
});

test("same-tab Google collision login isolates a fresh Home cache without reloading", async ({
  browser,
}) => {
  const targetContext = await browser.newContext();
  const sourceContext = await browser.newContext();
  try {
    const subject = newUUIDv7();
    const targetGoal = "切替先だけにある目標";
    const sourceGoal = "切替元に残して表示してはいけない目標";

    const target = await targetContext.newPage();
    await createProgressingGoal(target, targetGoal);
    const targetUpgrade = await postGoogle(target, "upgrade", subject);
    expect(targetUpgrade.status).toBe(200);
    const targetSession = targetUpgrade.payload as SessionView;

    const source = await sourceContext.newPage();
    await installGoogleIdentityFake(source, "test-google:" + subject);
    await createProgressingGoal(source, sourceGoal);
    await source.getByRole("link", { name: "FUKAMU Cycle ホーム" }).click();
    await expect(
      source.getByRole("link", { name: new RegExp(sourceGoal) }),
    ).toBeVisible();
    await source.getByRole("button", { name: "メニューを開く" }).click();
    await source.getByRole("link", { name: "設定" }).click();
    await expect(source.getByRole("heading", { name: "設定" })).toBeVisible();

    const documentMarker = newUUIDv7();
    await source.evaluate((marker) => {
      (
        window as Window & {
          __fukamuDocumentMarker?: string;
        }
      ).__fukamuDocumentMarker = marker;
    }, documentMarker);

    await source
      .getByRole("button", { name: googleIdentityFakeButtonName })
      .click();
    const collision = source.getByRole("dialog");
    await expect(collision).toContainText("現在の匿名データは統合されません");
    await collision
      .getByRole("button", { name: "既存アカウントでログイン" })
      .click();

    await expect(source.locator("code")).toHaveText(targetSession.user.id);
    expect(
      await source.evaluate(
        () =>
          (
            window as Window & {
              __fukamuDocumentMarker?: string;
            }
          ).__fukamuDocumentMarker,
      ),
    ).toBe(documentMarker);

    await source.getByRole("link", { name: "FUKAMU Cycle ホーム" }).click();
    await expect(source.getByText(sourceGoal)).toHaveCount(0);
    await expect(
      source.getByRole("link", { name: new RegExp(targetGoal) }),
    ).toBeVisible();
  } finally {
    await targetContext.close();
    await sourceContext.close();
  }
});

test("cross-tab request and response identity binding recovers without exposing the switched user's payload", async ({
  browser,
}) => {
  const targetContext = await browser.newContext();
  const sourceContext = await browser.newContext();
  let releaseVerifiedGoalList = () => undefined;
  try {
    const subject = newUUIDv7();
    const targetGoal = "response-bound target " + newUUIDv7();
    const sourceGoal = "stale source " + newUUIDv7();

    const target = await targetContext.newPage();
    await createProgressingGoal(target, targetGoal);
    const targetUpgrade = await postGoogle(target, "upgrade", subject);
    expect(targetUpgrade.status).toBe(200);
    const targetSession = targetUpgrade.payload as SessionView;

    const staleTab = await sourceContext.newPage();
    await disableSessionIdentityAdvisory(staleTab);
    await createProgressingGoal(staleTab, sourceGoal);
    await staleTab.getByRole("link", { name: "FUKAMU Cycle ホーム" }).click();
    await expect(
      staleTab.getByRole("link", { name: new RegExp(sourceGoal) }),
    ).toBeVisible();
    const sourceSession = await getSession(staleTab);
    expect(await staleTab.evaluate(() => typeof window.BroadcastChannel)).toBe(
      "undefined",
    );

    const documentMarker = newUUIDv7();
    await staleTab.evaluate((marker) => {
      (
        window as Window & {
          __fukamuCrossTabDocumentMarker?: string;
        }
      ).__fukamuCrossTabDocumentMarker = marker;
    }, documentMarker);

    const loginTab = await sourceContext.newPage();
    await installGoogleIdentityFake(loginTab, "test-google:" + subject);
    await loginTab.goto("/settings");
    await expect(loginTab.locator("code")).toHaveText(sourceSession.user.id);
    await loginExistingGoogleAccount(loginTab);
    await expect(loginTab.locator("code")).toHaveText(targetSession.user.id);

    let goalListRequestCount = 0;
    let mismatchedGoalListPayload: unknown;
    let markVerifiedGoalListStarted = () => undefined;
    const verifiedGoalListStarted = new Promise<void>((resolve) => {
      markVerifiedGoalListStarted = resolve;
    });
    const verifiedGoalListMayContinue = new Promise<void>((resolve) => {
      releaseVerifiedGoalList = resolve;
    });
    await staleTab.route("**/api/v1/goals*", async (route) => {
      const request = route.request();
      if (
        request.method() !== "GET" ||
        new URL(request.url()).pathname !== "/api/v1/goals"
      ) {
        await route.continue();
        return;
      }
      goalListRequestCount += 1;
      if (goalListRequestCount === 1) {
        const response = await route.fetch();
        mismatchedGoalListPayload = await response.json();
        await route.fulfill({ response });
        return;
      }
      if (goalListRequestCount === 2) {
        markVerifiedGoalListStarted();
        await verifiedGoalListMayContinue;
      }
      await route.continue();
    });

    const mismatchedGoalList = staleTab.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/v1/goals",
    );
    await staleTab
      .getByRole("link", { name: /すべての目標と履歴を見る/ })
      .click();
    const mismatchedResponse = await mismatchedGoalList;
    expect(mismatchedResponse.request().headers()[expectedUserHeader]).toBe(
      sourceSession.user.id,
    );
    expect(mismatchedResponse.status()).toBe(409);
    expect(mismatchedResponse.headers()[authenticatedUserHeader]).toBe(
      targetSession.user.id,
    );
    expect(mismatchedGoalListPayload).toMatchObject({
      error: { code: "SESSION_IDENTITY_CHANGED" },
    });

    await verifiedGoalListStarted;
    expect(goalListRequestCount).toBe(2);
    await expect(staleTab.getByText(targetGoal)).toHaveCount(0);

    releaseVerifiedGoalList();
    await expect(
      staleTab.getByRole("link", { name: new RegExp(targetGoal) }),
    ).toBeVisible();
    await expect(staleTab.getByText(sourceGoal)).toHaveCount(0);

    await staleTab.getByRole("button", { name: "メニューを開く" }).click();
    await staleTab.getByRole("link", { name: "設定" }).click();
    await expect(staleTab.locator("code")).toHaveText(targetSession.user.id);
    expect(
      await staleTab.evaluate(
        () =>
          (
            window as Window & {
              __fukamuCrossTabDocumentMarker?: string;
            }
          ).__fukamuCrossTabDocumentMarker,
      ),
    ).toBe(documentMarker);
  } finally {
    releaseVerifiedGoalList();
    await targetContext.close();
    await sourceContext.close();
  }
});

test("cross-tab Google login fences a dirty NewGoal draft and preserves it for the source user", async ({
  browser,
}) => {
  const targetContext = await browser.newContext();
  const sourceContext = await browser.newContext();
  try {
    const subject = newUUIDv7();
    const targetBody = "target draft " + newUUIDv7();
    const sourceBody = "source dirty draft " + newUUIDv7();

    const target = await targetContext.newPage();
    await target.goto("/");
    await target.getByRole("button", { name: "新しい目標を設定" }).click();
    await saveText(
      target,
      target.getByRole("textbox", { name: "あなたの目標" }),
      targetBody,
      "/api/v1/goal-drafts/",
    );
    const targetHome = expectCreationDraft(
      await requestFromPage(target, { path: "/api/v1/home" }),
    );
    const targetUpgrade = await postGoogle(target, "upgrade", subject);
    expect(targetUpgrade.status).toBe(200);
    const targetSession = targetUpgrade.payload as SessionView;

    const draftTab = await sourceContext.newPage();
    await draftTab.goto("/");
    await expect(
      draftTab.getByRole("button", { name: "新しい目標を設定" }),
    ).toBeVisible();
    await draftTab.getByRole("button", { name: "新しい目標を設定" }).click();
    const sourceEditor = draftTab.getByRole("textbox", {
      name: "あなたの目標",
    });
    await expect(sourceEditor).toBeVisible();
    await expect(draftTab.getByText("保存済み")).toBeVisible();
    const sourceSession = await getSession(draftTab);
    const sourceHome = expectCreationDraft(
      await requestFromPage(draftTab, { path: "/api/v1/home" }),
    );

    const loginTab = await sourceContext.newPage();
    await installGoogleIdentityFake(loginTab, "test-google:" + subject);
    await loginTab.goto("/settings");
    await expect(loginTab.locator("code")).toHaveText(sourceSession.user.id);
    await loginTab
      .getByRole("button", { name: googleIdentityFakeButtonName })
      .click();
    const collision = loginTab.getByRole("dialog");
    await expect(collision).toContainText("現在の匿名データは統合されません");

    let cookieSwitched = false;
    loginTab.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/auth/google/login" &&
        response.status() === 200
      ) {
        cookieSwitched = true;
      }
    });
    const observedPatches: ObservedGoalDraftPatch[] = [];
    draftTab.on("request", (request) => {
      const patch = observeGoalDraftPatch(request, cookieSwitched);
      if (patch) observedPatches.push(patch);
    });

    await sourceEditor.fill(sourceBody);
    await expect(draftTab.getByText("未保存")).toBeVisible();
    await collision
      .getByRole("button", { name: "既存アカウントでログイン" })
      .click();

    await expect(loginTab.locator("code")).toHaveText(targetSession.user.id);
    await expect(draftTab).toHaveURL(/\/goals\/new$/);
    const targetEditor = draftTab.getByRole("textbox", {
      name: "あなたの目標",
    });
    await expect(targetEditor).toHaveValue(targetBody);
    const sourceBodyPatchCountAtConvergence = observedPatches.filter(
      (patch) => patch.body === sourceBody,
    ).length;

    // Cross the documented 800 ms autosave debounce. A stale generation must
    // not dispatch after the B editor has mounted.
    await draftTab.waitForTimeout(1_000);
    expect(
      observedPatches.filter((patch) => patch.body === sourceBody),
    ).toHaveLength(sourceBodyPatchCountAtConvergence);
    expect(
      observedPatches.filter(
        (patch) => patch.body === sourceBody && patch.afterCookieSwitch,
      ),
    ).toEqual([]);
    expect(
      observedPatches.some(
        (patch) => patch.draftId === targetHome.id && patch.body === sourceBody,
      ),
    ).toBe(false);

    const finalTargetHome = expectCreationDraft(
      await requestFromPage(draftTab, { path: "/api/v1/home" }),
    );
    expect(finalTargetHome).toMatchObject({
      id: targetHome.id,
      body: targetBody,
    });
    expect((await getSession(draftTab)).user.id).toBe(targetSession.user.id);

    const retained = await readStoredBrowserDraft(
      draftTab,
      sourceSession.user.id,
      "goal-draft:" + sourceHome.id,
    );
    expect(retained).toMatchObject({
      userId: sourceSession.user.id,
      goalId: null,
      subjectKey: "goal-draft:" + sourceHome.id,
      body: sourceBody,
      baseRevision: sourceHome.revision,
    });
  } finally {
    await targetContext.close();
    await sourceContext.close();
  }
});

test("cross-tab account deletion fences the old editor and leaves only digest privacy guards", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const sender = await context.newPage();
  const receiver = await context.newPage();
  const deletedDraftBody = "deleted account browser draft " + newUUIDv7();
  const fenceMarkerKey = "e2e-account-deletion-editor-fenced";

  try {
    await receiver.addInitScript(
      ({ markerKey, oldBody }) => {
        const markIfOldEditorIsFenced = () => {
          const editor =
            document.querySelector<HTMLTextAreaElement>("#goal-body");
          if (
            editor?.value === oldBody &&
            editor.closest("[hidden][inert]") !== null
          ) {
            sessionStorage.setItem(markerKey, "true");
          }
        };
        const observer = new MutationObserver(markIfOldEditorIsFenced);
        const startObserving = () => {
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["hidden", "inert"],
            subtree: true,
          });
          markIfOldEditorIsFenced();
        };
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", startObserving, {
            once: true,
          });
        } else {
          startObserving();
        }
        window.addEventListener("beforeunload", markIfOldEditorIsFenced);
      },
      { markerKey: fenceMarkerKey, oldBody: deletedDraftBody },
    );

    await sender.goto("/");
    await expect(
      sender.getByRole("button", { name: "新しい目標を設定" }),
    ).toBeVisible();
    const deletedSession = await getSession(sender);

    await receiver.goto("/");
    await expect(
      receiver.getByRole("button", { name: "新しい目標を設定" }),
    ).toBeVisible();

    await receiver.getByRole("button", { name: "新しい目標を設定" }).click();
    const oldEditor = receiver.getByRole("textbox", {
      name: "あなたの目標",
    });
    await expect(oldEditor).toBeVisible();
    await expect(receiver.getByText("保存済み")).toBeVisible();
    const oldHome = expectCreationDraft(
      await requestFromPage(receiver, { path: "/api/v1/home" }),
    );

    await receiver.route("**/api/v1/goal-drafts/*", async (route) => {
      const request = route.request();
      if (
        request.method() === "PATCH" &&
        /^\/api\/v1\/goal-drafts\/[^/]+$/.test(new URL(request.url()).pathname)
      ) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await oldEditor.fill(deletedDraftBody);
    await expect(oldEditor).toHaveValue(deletedDraftBody);
    await expect(receiver.getByText("未保存")).toBeVisible();
    await expect
      .poll(() =>
        readStoredBrowserDraft(
          receiver,
          deletedSession.user.id,
          "goal-draft:" + oldHome.id,
        ),
      )
      .toMatchObject({
        userId: deletedSession.user.id,
        goalId: null,
        subjectKey: "goal-draft:" + oldHome.id,
        body: deletedDraftBody,
        baseRevision: oldHome.revision,
      });

    await sender.goto("/settings");
    await expect(sender.getByRole("heading", { name: "設定" })).toBeVisible();
    await expect(sender.locator("code")).toHaveText(deletedSession.user.id);

    const receiverReloaded = receiver.waitForEvent("framenavigated", {
      predicate: (frame) => frame === receiver.mainFrame(),
    });
    const deletionResponse = sender.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === "/api/v1/account",
    );
    await sender.getByRole("button", { name: "アカウントを削除" }).click();
    await sender
      .getByRole("dialog")
      .getByRole("button", { name: "アカウントを削除" })
      .click();
    expect((await deletionResponse).status()).toBe(204);
    await receiverReloaded;

    expect(
      await receiver.evaluate(
        (markerKey) => sessionStorage.getItem(markerKey),
        fenceMarkerKey,
      ),
    ).toBe("true");
    await expect(receiver).toHaveURL(/\/goals\/new$/);
    await expect(
      receiver.getByRole("button", { name: "下書きを作成" }),
    ).toBeVisible();
    await expect(receiver.locator("textarea")).toHaveCount(0);
    await expect(receiver.locator("body")).not.toContainText(deletedDraftBody);

    await expect(sender).toHaveURL("/");
    await expect(
      sender.getByRole("button", { name: "新しい目標を設定" }),
    ).toBeVisible();
    const senderReplacementSession = await getSession(sender);
    const receiverReplacementSession = await getSession(receiver);
    expect(senderReplacementSession.user.id).toBe(
      receiverReplacementSession.user.id,
    );
    expect(receiverReplacementSession.user.id).not.toBe(deletedSession.user.id);

    const privacySnapshot = await readBrowserDraftPrivacySnapshot(receiver);
    expect(privacySnapshot.drafts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: deletedSession.user.id }),
      ]),
    );
    expect(JSON.stringify(privacySnapshot)).not.toContain(
      deletedSession.user.id,
    );
    expect(JSON.stringify(privacySnapshot)).not.toContain(deletedDraftBody);

    expect(privacySnapshot.metadata).toHaveLength(1);
    expect(privacySnapshot.metadata[0]).toEqual({
      key: "account-deletion-salt-v1",
      value: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    for (const record of privacySnapshot.metadata) {
      expect(Object.keys(record).sort()).toEqual(["key", "value"]);
    }
    const salt = privacySnapshot.metadata[0]?.value;
    expect(typeof salt).toBe("string");
    if (typeof salt !== "string") throw new Error("missing deletion salt");

    const expectedDigest = await sha256Hex(
      receiver,
      salt + ":" + deletedSession.user.id,
    );
    expect(privacySnapshot.tombstones).toEqual([{ digest: expectedDigest }]);
    for (const record of privacySnapshot.tombstones) {
      expect(Object.keys(record)).toEqual(["digest"]);
    }
  } finally {
    await context.close();
  }
});

test("account delete revisits as a different empty anonymous user", async ({
  page,
}) => {
  const goalText = "アカウント削除で消える目標";
  await createProgressingGoal(page, goalText);
  await page.goto("/settings");
  const oldUserId = (await page.locator("code").textContent())?.trim();
  expect(oldUserId).toBeTruthy();
  await page.getByRole("button", { name: "アカウントを削除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "アカウントを削除" })
    .click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();

  await page.goto("/history");
  await expect(page.getByText("まだ目標はありません。")).toBeVisible();
  await expect(page.getByText(goalText)).toHaveCount(0);
  const newSession = await getSession(page);
  expect(newSession.user.id).not.toBe(oldUserId);
});

test("active termination leaves a canceled read-only cycle and a new Goal starts at Cycle 1", async ({
  page,
}) => {
  const endedGoal = "途中終了する目標";
  const partialPlan = "途中まで記録した計画";
  await createProgressingGoal(page, endedGoal);
  await saveFrame(page, "P — Plan", partialPlan, "P");
  await page.getByText("目標の操作").click();
  await page.getByRole("button", { name: "目標を終了" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "目標を終了" })
    .click();
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();

  await page.goto("/history");
  await page.getByRole("link", { name: new RegExp(endedGoal) }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: endedGoal }),
  ).toBeVisible();
  const canceledCycle = page.getByRole("link", { name: /Cycle 1/ });
  await expect(canceledCycle).toContainText("Canceled");
  await canceledCycle.click();
  const plan = page.getByRole("textbox", { name: "P — Plan" });
  await expect(plan).toHaveValue(partialPlan);
  await expect(plan).not.toBeEditable();
  await expect(page.getByText("読み取り専用")).toBeVisible();
  await expect(page.getByText("目標の操作")).toHaveCount(0);

  await createProgressingGoal(page, "終了後に始める新しい目標");
  await expect(page.getByText("Goal v1 · Cycle 1")).toBeVisible();
});

test("public API rejects missing session, invalid CSRF, and unknown JSON", async ({
  page,
  request,
}) => {
  const missingSession = await request.get("/api/v1/home");
  await expectAPIResponseError(missingSession, 401, "SESSION_MISSING");

  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "新しい目標を設定" }),
  ).toBeVisible();
  await getSession(page);
  await expectAPIError(
    page,
    {
      path: "/api/v1/goal-drafts",
      method: "POST",
      csrfToken: "invalid-csrf-token",
      body: { initialBody: "" },
    },
    403,
    "CSRF_INVALID",
  );

  const refreshed = await getSession(page);
  await expectAPIError(
    page,
    {
      path: "/api/v1/goal-drafts",
      method: "POST",
      csrfToken: refreshed.csrfToken,
      body: { initialBody: "", unknown: true },
    },
    400,
    "VALIDATION_ERROR",
  );
});

const authenticatedUserHeader = "x-fukamu-authenticated-user-id";
const expectedUserHeader = "x-fukamu-expected-user-id";

type CreationDraftView = {
  readonly id: string;
  readonly body: string;
  readonly revision: number;
};

type ObservedGoalDraftPatch = {
  readonly draftId: string;
  readonly body: string | undefined;
  readonly afterCookieSwitch: boolean;
};

async function disableSessionIdentityAdvisory(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
  });
}

async function loginExistingGoogleAccount(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: googleIdentityFakeButtonName })
    .click();
  const collision = page.getByRole("dialog");
  await expect(collision).toContainText("現在の匿名データは統合されません");
  await collision
    .getByRole("button", { name: "既存アカウントでログイン" })
    .click();
}

function expectCreationDraft(result: {
  readonly status: number;
  readonly payload: unknown;
}): CreationDraftView {
  expect(result.status).toBe(200);
  expect(result.payload).toMatchObject({
    creationDraft: {
      id: expect.any(String),
      body: expect.any(String),
      revision: expect.any(Number),
    },
  });
  return (result.payload as { readonly creationDraft: CreationDraftView })
    .creationDraft;
}

function observeGoalDraftPatch(
  request: Request,
  afterCookieSwitch: boolean,
): ObservedGoalDraftPatch | null {
  if (request.method() !== "PATCH") return null;
  const url = new URL(request.url());
  const match = /^\/api\/v1\/goal-drafts\/([^/]+)$/.exec(url.pathname);
  if (!match?.[1]) return null;
  let body: string | undefined;
  try {
    const payload = request.postDataJSON() as { readonly body?: unknown };
    if (typeof payload.body === "string") body = payload.body;
  } catch {
    // A malformed request remains observable without retaining raw content.
  }
  return { draftId: match[1], body, afterCookieSwitch };
}

async function readStoredBrowserDraft(
  page: Page,
  userId: string,
  subjectKey: string,
): Promise<unknown> {
  return page.evaluate(
    ({ lookupUserId, lookupSubjectKey }) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open("fukamu-cycle-browser-drafts-v2");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("drafts")) {
            database.close();
            resolve(null);
            return;
          }
          const transaction = database.transaction("drafts", "readonly");
          const request = transaction
            .objectStore("drafts")
            .get(lookupUserId + ":" + lookupSubjectKey);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result ?? null);
          transaction.oncomplete = () => database.close();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        };
      }),
    { lookupUserId: userId, lookupSubjectKey: subjectKey },
  );
}

type BrowserDraftPrivacySnapshot = {
  readonly drafts: readonly Record<string, unknown>[];
  readonly tombstones: readonly Record<string, unknown>[];
  readonly metadata: readonly Record<string, unknown>[];
};

async function readBrowserDraftPrivacySnapshot(
  page: Page,
): Promise<BrowserDraftPrivacySnapshot> {
  return page.evaluate(
    () =>
      new Promise<BrowserDraftPrivacySnapshot>((resolve, reject) => {
        const open = indexedDB.open("fukamu-cycle-browser-drafts-v2");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const requiredStores = [
            "drafts",
            "account-deletion-tombstones",
            "metadata",
          ] as const;
          if (
            requiredStores.some(
              (storeName) => !database.objectStoreNames.contains(storeName),
            )
          ) {
            database.close();
            reject(new Error("browser draft privacy stores are unavailable"));
            return;
          }
          const transaction = database.transaction(requiredStores, "readonly");
          const drafts = transaction.objectStore("drafts").getAll();
          const tombstones = transaction
            .objectStore("account-deletion-tombstones")
            .getAll();
          const metadata = transaction.objectStore("metadata").getAll();
          const closeAndReject = () => {
            database.close();
            reject(transaction.error);
          };
          transaction.oncomplete = () => {
            database.close();
            resolve({
              drafts: drafts.result as readonly Record<string, unknown>[],
              tombstones: tombstones.result as readonly Record<
                string,
                unknown
              >[],
              metadata: metadata.result as readonly Record<string, unknown>[],
            });
          };
          transaction.onerror = closeAndReject;
          transaction.onabort = closeAndReject;
        };
      }),
  );
}

async function sha256Hex(page: Page, value: string): Promise<string> {
  return page.evaluate(async (input) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }, value);
}
