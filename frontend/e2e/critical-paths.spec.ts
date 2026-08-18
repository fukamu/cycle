import { expect, test, type Locator, type Page } from "@playwright/test";

test("goal creation, cycle completion, review, next cycle, timeline, and delete", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  const goal = page.getByRole("textbox", { name: "あなたの目標" });
  await saveText(
    page,
    goal,
    "平日は主要業務を18時までに終えたい",
    "/api/v1/goal-drafts/",
  );
  await page.getByRole("button", { name: "この目標で始める" }).click();
  await expect(page.getByText("Goal v1 · Cycle 1")).toBeVisible();

  await saveFrame(
    page,
    "P — Plan",
    "朝に最重要タスクを決めて30分取り組む",
    "D",
  );
  await saveFrame(page, "D — Do", "5日中4日、朝に取り組んだ", "C");
  await saveFrame(page, "C — Check", "3日は午前中に完了できた", "A");
  await page.getByRole("button", { name: "アクションを生成" }).click();
  await expect(
    page.getByRole("textbox", { name: "A — Action" }),
  ).not.toHaveValue("");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "サイクルを完了" }).click();
  await expect(
    page.getByRole("heading", { name: "平日は主要業務を18時までに終えたい" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "この目標で次のサイクルへ" }),
  ).toBeVisible();
  await expect(
    page.getByText("Goal v1 · Cycle 1 を完了しました"),
  ).toBeVisible();

  await page.getByRole("button", { name: "この目標で次のサイクルへ" }).click();
  await expect(page.getByText("Goal v1 · Cycle 2")).toBeVisible();
  await page.goto("/history");
  await page
    .getByRole("link", { name: /平日は主要業務を18時までに終えたい/ })
    .click();
  await expect(page.getByText("GOAL V1")).toBeVisible();
  await expect(page.getByRole("link", { name: /Cycle 1/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Cycle 2/ })).toBeVisible();

  await page.getByRole("link", { name: /Cycle 2/ }).click();
  await page.getByText("目標の操作").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "目標を削除" }).click();
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();
});

test("a failed autosave keeps the browser draft and retry persists it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  let fail = true;
  await page.route("**/api/v1/goal-drafts/*", async (route) => {
    if (route.request().method() === "PATCH" && fail) {
      fail = false;
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  const editor = page.getByRole("textbox", { name: "あなたの目標" });
  await editor.fill("失敗しても保持する目標");
  await expect(page.getByRole("alert")).toContainText("保存失敗");
  await page.getByRole("button", { name: "再試行" }).click();
  await expect(page.getByText("保存済み")).toBeVisible();
  await page.reload();
  await expect(editor).toHaveValue("失敗しても保持する目標");
});

test("goal review termination discards an unversioned change explicitly", async ({
  page,
}) => {
  await createAndCompleteGoal(page);
  const review = page.getByRole("textbox", {
    name: "次のサイクルで目指す目標",
  });
  await review.fill("次のCycleだけで試したかった変更案");
  const dialogText = new Promise<string>((resolve) =>
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.accept();
    }),
  );
  await page.getByRole("button", { name: "目標を達成として終了" }).click();
  await expect(dialogText).resolves.toContain(
    "この変更案は、次のサイクルを開始しないため保存されません",
  );
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();
});

async function createAndCompleteGoal(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  await saveText(
    page,
    page.getByRole("textbox", { name: "あなたの目標" }),
    "確認用の目標",
    "/api/v1/goal-drafts/",
  );
  await page.getByRole("button", { name: "この目標で始める" }).click();
  await saveFrame(page, "P — Plan", "計画", "D");
  await saveFrame(page, "D — Do", "実行", "C");
  await saveFrame(page, "C — Check", "確認", "A");
  await saveFrame(page, "A — Action", "改善", "A");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "サイクルを完了" }).click();
}

async function saveFrame(
  page: Page,
  label: string,
  content: string,
  next: "P" | "D" | "C" | "A",
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
  await page.getByRole("textbox", { name: label }).fill(content);
  if (next !== label[0])
    await page.getByRole("tab", { name: new RegExp(`^${next}`) }).click();
  else await page.getByRole("textbox", { name: label }).blur();
  await response;
  await expect(page.getByText("保存済み")).toBeVisible();
}

async function saveText(
  page: Page,
  editor: Locator,
  content: string,
  urlPart: string,
) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate.url().includes(urlPart) &&
      candidate.ok(),
  );
  await editor.fill(content);
  await response;
  await expect(page.getByText("保存済み")).toBeVisible();
}
