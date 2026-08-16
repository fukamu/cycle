import { expect, test, type Page } from "@playwright/test";

test("anonymous autosave, AI generation, completion, history, and deletion", async ({
  page,
}) => {
  const initialBootstrap = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/session/anonymous"),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cycle 1" })).toBeVisible();
  const initial = (await (await initialBootstrap).json()) as SessionView;

  await saveFrame(page, "P — Plan", "朝の集中時間を改善する", "D");
  await saveFrame(page, "D — Do", "三日間、朝一番に試した", "C");
  await saveFrame(page, "C — Check", "二日成功し、一日はメールを先に見た", "A");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Cycle 1" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "A — Action" })).toBeVisible();
  await page.getByRole("tab", { name: /P Plan/ }).click();
  await expect(page.getByRole("textbox", { name: "P — Plan" })).toHaveValue(
    "朝の集中時間を改善する",
  );
  await page.getByRole("tab", { name: /D Do/ }).click();
  await expect(page.getByRole("textbox", { name: "D — Do" })).toHaveValue(
    "三日間、朝一番に試した",
  );
  await page.getByRole("tab", { name: /C Check/ }).click();
  await expect(page.getByRole("textbox", { name: "C — Check" })).toHaveValue(
    "二日成功し、一日はメールを先に見た",
  );
  await page.getByRole("tab", { name: /A Action/ }).click();
  await page.getByRole("button", { name: "アクションを生成" }).click();
  await expect(
    page.getByRole("textbox", { name: "A — Action" }),
  ).not.toHaveValue("");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "次サイクルへ" }).click();
  await expect(page.getByRole("heading", { name: "Cycle 2" })).toBeVisible();

  await page.getByRole("tab", { name: /P Plan/ }).click();
  await saveFrame(page, "P — Plan", "次は朝の開始時刻を一定にする", "D");
  await saveFrame(page, "D — Do", "開始時刻を記録した", "C");
  await saveFrame(page, "C — Check", "通知がある日は開始できた", "A");
  const manualAction = page.getByRole("textbox", { name: "A — Action" });
  const actionSave = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate.url().endsWith("/frames/action") &&
      candidate.ok(),
  );
  await manualAction.fill("毎朝通知を設定する");
  await manualAction.blur();
  await actionSave;
  await page.getByRole("button", { name: "AIで推敲" }).click();
  await expect(manualAction).not.toHaveValue("毎朝通知を設定する");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "次サイクルへ" }).click();
  await expect(page.getByRole("heading", { name: "Cycle 3" })).toBeVisible();

  await page.goto("/cycles");
  await page.getByRole("link", { name: /Cycle 1/ }).click();
  await expect(page.getByText("朝の集中時間を改善する")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);

  await page.goto("/settings");
  page.once("dialog", (dialog) => void dialog.accept());
  const recreatedBootstrap = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/session/anonymous"),
  );
  await page.getByRole("button", { name: "アカウントを削除" }).click();
  await expect(page.getByRole("heading", { name: "Cycle 1" })).toBeVisible();
  const recreated = (await (await recreatedBootstrap).json()) as SessionView;
  expect(recreated.user.id).not.toBe(initial.user.id);
});

test("save failure keeps input and a retry persists it", async ({ page }) => {
  await page.goto("/");
  let fail = true;
  await page.route("**/frames/plan", async (route) => {
    if (fail) {
      fail = false;
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  const plan = page.getByRole("textbox", { name: "P — Plan" });
  await plan.fill("失敗しても保持する入力");
  await plan.blur();
  await expect(page.getByRole("alert")).toContainText(
    "入力は端末に保持されています",
  );
  await page.getByRole("button", { name: "再試行" }).click();
  await expect(page.getByText("● 保存済み")).toBeVisible();
  await page.reload();
  await expect(plan).toHaveValue("失敗しても保持する入力");
});

test("the PDCAI wordmark opens the current cycle's plan from any screen", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /C Check/ }).click();
  await page.getByRole("link", { name: "PDCAI 現在のサイクルのPへ" }).click();
  await expect(page.getByRole("tab", { name: /P Plan/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.goto("/settings");
  await page.getByRole("link", { name: "PDCAI 現在のサイクルのPへ" }).click();
  await expect(page.getByRole("heading", { name: "Cycle 1" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /P Plan/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("AI failure leaves A unchanged and a retry can succeed", async ({
  page,
}) => {
  await page.goto("/");
  await saveFrame(page, "P — Plan", "AI失敗時の計画", "D");
  await saveFrame(page, "D — Do", "実行内容", "C");
  await saveFrame(page, "C — Check", "確認内容", "A");
  let fail = true;
  await page.route("**/actions/generate", async (route) => {
    if (!fail) {
      await route.continue();
      return;
    }
    fail = false;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "AI_PROVIDER_UNAVAILABLE",
          message: "provider unavailable",
          requestId: "00000000-0000-4000-8000-000000000099",
        },
      }),
    });
  });
  const action = page.getByRole("textbox", { name: "A — Action" });
  await page.getByRole("button", { name: "アクションを生成" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Aの内容は変更されていません",
  );
  await expect(action).toHaveValue("");
  await page.getByRole("button", { name: "アクションを生成" }).click();
  await expect(action).not.toHaveValue("");
});

test("Google collision explicitly switches accounts without merging data", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  await firstPage.goto("/");
  await firstPage
    .getByRole("textbox", { name: "P — Plan" })
    .fill("既存ユーザーの計画");
  await firstPage.getByRole("textbox", { name: "P — Plan" }).blur();
  await expect(firstPage.getByText("● 保存済み")).toBeVisible();
  const firstBefore = await session(firstPage);
  const firstUpgraded = await postGoogle(
    firstPage,
    "upgrade",
    "shared-subject",
  );
  expect(firstUpgraded.status).toBe(200);
  expect(firstUpgraded.body.user.id).toBe(firstBefore.user.id);

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await secondPage.goto("/");
  await secondPage
    .getByRole("textbox", { name: "P — Plan" })
    .fill("匿名側の別計画");
  await secondPage.getByRole("textbox", { name: "P — Plan" }).blur();
  await expect(secondPage.getByText("● 保存済み")).toBeVisible();
  const secondBefore = await session(secondPage);
  expect(secondBefore.user.id).not.toBe(firstBefore.user.id);
  expect(
    (await postGoogle(secondPage, "upgrade", "shared-subject")).status,
  ).toBe(409);
  const login = await postGoogle(secondPage, "login", "shared-subject");
  expect(login.status).toBe(200);
  expect(login.body.user.id).toBe(firstBefore.user.id);
  await secondPage.reload();
  await expect(
    secondPage.getByRole("textbox", { name: "P — Plan" }),
  ).toHaveValue("既存ユーザーの計画");

  await firstContext.close();
  await secondContext.close();
});

async function saveFrame(
  page: Page,
  label: string,
  content: string,
  nextTab: string,
) {
  const frame = ({ P: "plan", D: "do", C: "check", A: "action" } as const)[
    label[0] as "P" | "D" | "C" | "A"
  ];
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate.url().endsWith(`/frames/${frame}`) &&
      candidate.ok(),
  );
  const editor = page.getByRole("textbox", { name: label });
  await editor.fill(content);
  await page.getByRole("tab", { name: new RegExp(`^${nextTab}`) }).click();
  await response;
  await expect(page.getByText("● 保存済み")).toBeVisible();
}

async function session(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/session");
    return response.json() as Promise<{
      user: { id: string; googleConnected: boolean };
      csrfToken: string;
      activeCycleId: string;
    }>;
  });
}

type SessionView = {
  user: { id: string; googleConnected: boolean };
  csrfToken: string;
  activeCycleId: string;
};

async function postGoogle(
  page: Page,
  operation: "upgrade" | "login",
  subject: string,
) {
  return page.evaluate(
    async ({ operation, subject }) => {
      const current = (await (await fetch("/api/v1/session")).json()) as {
        csrfToken: string;
      };
      const response = await fetch(`/api/v1/auth/google/${operation}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": current.csrfToken,
        },
        body: JSON.stringify({ idToken: `test-google:${subject}` }),
      });
      return { status: response.status, body: await response.json() };
    },
    { operation, subject },
  );
}
