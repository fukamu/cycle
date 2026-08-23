import { expect, type Locator, type Page } from "@playwright/test";

export async function createAndCompleteGoal(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  await saveText(
    page,
    page.getByRole("textbox", { name: "あなたの目標" }),
    "確認用の目標",
    "/api/v1/goal-drafts/",
  );
  await page.getByRole("button", { name: "この目標で始める" }).click();
  await completeCurrentCycle(page, "確認");
}

export async function completeCurrentCycle(page: Page, suffix: string) {
  await saveFrame(page, "P — Plan", `計画 ${suffix}`, "D");
  await saveFrame(page, "D — Do", `実行 ${suffix}`, "C");
  await saveFrame(page, "C — Check", `確認 ${suffix}`, "A");
  await saveFrame(page, "A — Action", `改善 ${suffix}`, "A");
  await page.getByRole("button", { name: "サイクルを完了" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "サイクルを完了" })
    .click();
}

export async function createProgressingGoal(page: Page, goalText: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  await saveText(
    page,
    page.getByRole("textbox", { name: "あなたの目標" }),
    goalText,
    "/api/v1/goal-drafts/",
  );
  await page.getByRole("button", { name: "この目標で始める" }).click();
  await expect(page.getByText("Goal v1 · Cycle 1")).toBeVisible();
}

export async function saveFrame(
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
  if (next !== label[0]) {
    await page.getByRole("tab", { name: new RegExp(`^${next}`) }).click();
  } else {
    await page.getByRole("textbox", { name: label }).blur();
  }
  await response;
  await expect(page.getByText("保存済み")).toBeVisible();
}

export async function saveText(
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
