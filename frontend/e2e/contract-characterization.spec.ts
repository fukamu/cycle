import { expect, test } from "@playwright/test";

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
import { createProgressingGoal, saveFrame } from "./support/workspace";

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
