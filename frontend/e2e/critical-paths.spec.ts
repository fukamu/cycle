import { expect, test, type Locator, type Page } from "@playwright/test";

test("goal creation, cycle completion, review, next cycle, timeline, and delete", async ({
  page,
}) => {
  const goalText = "平日は主要業務を18時までに終えたい";
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  const goal = page.getByRole("textbox", { name: "あなたの目標" });
  await saveText(page, goal, goalText, "/api/v1/goal-drafts/");
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
  await page.getByRole("button", { name: "サイクルを完了" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "サイクルを完了" })
    .click();
  await expect(page.getByRole("heading", { name: goalText })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "この目標で次のサイクルへ" }),
  ).toBeVisible();
  await expect(
    page.getByText("Goal v1 · Cycle 1 を完了しました"),
  ).toBeVisible();

  await page.getByRole("button", { name: "AIで目標を整える" }).click();
  await expect(
    page.getByRole("heading", { name: "AIからの提案" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "提案後に下書きが変更されたため、この提案は採用できません。",
    ),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "提案を採用" })).toBeEnabled();
  const reviewGoal = page.getByRole("textbox", {
    name: "次のサイクルで目指す目標",
  });
  await saveText(page, reviewGoal, "一時的に変更した目標", "/review");
  await expect(
    page.getByText(
      "提案後に下書きが変更されたため、この提案は採用できません。",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "提案を採用" })).toBeDisabled();
  await saveText(page, reviewGoal, goalText, "/review");
  await expect(
    page.getByText(
      "提案後に下書きが変更されたため、この提案は採用できません。",
    ),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "提案を採用" })).toBeEnabled();
  await page.route(
    "**/api/v1/goals/*/review/refinements",
    (route) => route.abort("connectionfailed"),
    { times: 1 },
  );
  await page.getByRole("button", { name: "AIで目標を整える" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "前の提案を表示しています",
  );
  await expect(
    page.getByRole("heading", { name: "AIからの提案" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "元の目標を維持" }).click();

  await page.getByRole("button", { name: "この目標で次のサイクルへ" }).click();
  await expect(page.getByText("Goal v1 · Cycle 2")).toBeVisible();
  await page.goto("/history");
  await page.getByRole("link", { name: new RegExp(goalText) }).click();
  await expect(page.getByText("GOAL V1")).toBeVisible();
  await expect(page.getByRole("link", { name: /Cycle 1/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Cycle 2/ })).toBeVisible();

  await page.getByRole("link", { name: /Cycle 2/ }).click();
  await page.getByText("目標の操作").click();
  await page.getByRole("button", { name: "目標を削除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "目標を削除" })
    .click();
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

test("free users can progress two goals while a third start is rejected without losing its draft", async ({
  page,
}) => {
  const firstGoal = "並行して進める最初の目標";
  const secondGoal = "並行して進める二つ目の目標";
  const thirdGoal = "上限到達後も保持する三つ目の目標";

  await createProgressingGoal(page, firstGoal);
  await createProgressingGoal(page, secondGoal);
  await page.goto("/");
  await expect(page.getByText("2 / 2")).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(firstGoal) }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(secondGoal) }),
  ).toBeVisible();

  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  const editor = page.getByRole("textbox", { name: "あなたの目標" });
  await saveText(page, editor, thirdGoal, "/api/v1/goal-drafts/");
  await expect(
    page.getByRole("button", { name: "この目標で始める" }),
  ).toBeDisabled();
  await expect(
    page.getByText("取り組んでいる目標が上限の2件に達しています。", {
      exact: false,
    }),
  ).toBeVisible();

  const limitAttempt = await page.evaluate(async () => {
    const sessionResponse = await fetch("/api/v1/session");
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const homeResponse = await fetch("/api/v1/home");
    const home = (await homeResponse.json()) as {
      creationDraft: { id: string; revision: number };
    };
    const response = await fetch(
      `/api/v1/goal-drafts/${home.creationDraft.id}/start`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-CSRF-Token": session.csrfToken,
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedDraftRevision: home.creationDraft.revision,
        }),
      },
    );
    const payload = (await response.json()) as { error: { code: string } };
    return { status: response.status, code: payload.error.code };
  });
  expect(limitAttempt).toEqual({
    status: 409,
    code: "GOAL_ACTIVE_LIMIT_EXCEEDED",
  });

  await page.reload();
  await expect(editor).toHaveValue(thirdGoal);
  await expect(
    page.getByRole("button", { name: "この目標で始める" }),
  ).toBeDisabled();
});

test("cycle autosave serializes an edit made during a slow save", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  await saveText(
    page,
    page.getByRole("textbox", { name: "あなたの目標" }),
    "直列保存を確認する目標",
    "/api/v1/goal-drafts/",
  );
  await page.getByRole("button", { name: "この目標で始める" }).click();

  let releaseFirst!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let first = true;
  await page.route("**/api/v1/goals/*/cycles/*/frames/plan", async (route) => {
    if (route.request().method() === "PATCH" && first) {
      first = false;
      markFirstStarted();
      await release;
    }
    await route.continue();
  });

  const plan = page.getByRole("textbox", { name: "P — Plan" });
  await plan.fill("先に送る内容");
  await firstStarted;
  await plan.fill("保存中に更新した最終内容");
  releaseFirst();

  await expect(page.getByText("保存済み")).toBeVisible();
  await page.reload();
  await expect(plan).toHaveValue("保存中に更新した最終内容");
});

test("goal review termination discards an unversioned change explicitly", async ({
  page,
}) => {
  await createAndCompleteGoal(page);
  const review = page.getByRole("textbox", {
    name: "次のサイクルで目指す目標",
  });
  await review.fill("次のCycleだけで試したかった変更案");
  await page.getByRole("button", { name: "目標を達成として終了" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "この変更案は、次のサイクルを開始しないため保存されません",
  );
  await dialog.getByRole("button", { name: "目標を達成" }).click();
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();
});

test("cross-user draft, goal, cycle, and delete access is rejected", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await owner.goto("/");
    const draftResponse = owner.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/goal-drafts") &&
        response.status() === 201,
    );
    await owner.getByRole("button", { name: "新しい目標を設定" }).click();
    const draftPayload = (await (await draftResponse).json()) as {
      draft: { id: string };
    };

    const outsider = await outsiderContext.newPage();
    await outsider.goto("/");
    await expect(
      outsider.getByRole("button", { name: "新しい目標を設定" }),
    ).toBeVisible();
    await expectAPIError(
      outsider,
      `/api/v1/goal-drafts/${draftPayload.draft.id}`,
      404,
      "GOAL_DRAFT_NOT_FOUND",
    );

    await saveText(
      owner,
      owner.getByRole("textbox", { name: "あなたの目標" }),
      "所有者だけが操作できる目標",
      "/api/v1/goal-drafts/",
    );
    await owner.getByRole("button", { name: "この目標で始める" }).click();
    await expect(owner.getByText("Goal v1 · Cycle 1")).toBeVisible();
    const route = new URL(owner.url()).pathname.match(
      /^\/goals\/([^/]+)\/cycles\/([^/]+)$/,
    );
    expect(route).not.toBeNull();
    const [, goalId, cycleId] = route!;

    await expectAPIError(
      outsider,
      `/api/v1/goals/${goalId}`,
      404,
      "GOAL_NOT_FOUND",
    );
    await expectAPIError(
      outsider,
      `/api/v1/goals/${goalId}/cycles/${cycleId}`,
      404,
      "CYCLE_NOT_FOUND",
    );

    const deleteAttempt = await outsider.evaluate(async (targetGoalId) => {
      const sessionResponse = await fetch("/api/v1/session");
      const session = (await sessionResponse.json()) as { csrfToken: string };
      const response = await fetch(`/api/v1/goals/${targetGoalId}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-CSRF-Token": session.csrfToken,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ confirmed: true, expectedGoalRevision: 0 }),
      });
      const payload = (await response.json()) as { error: { code: string } };
      return { status: response.status, code: payload.error.code };
    }, goalId);
    expect(deleteAttempt).toEqual({ status: 404, code: "GOAL_NOT_FOUND" });

    const ownerReadStatus = await owner.evaluate(async (targetGoalId) => {
      const response = await fetch(`/api/v1/goals/${targetGoalId}`);
      return response.status;
    }, goalId);
    expect(ownerReadStatus).toBe(200);
  } finally {
    await ownerContext.close();
    await outsiderContext.close();
  }
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
  await page.getByRole("button", { name: "サイクルを完了" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "サイクルを完了" })
    .click();
}

async function createProgressingGoal(page: Page, goalText: string) {
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

async function expectAPIError(
  page: Page,
  path: string,
  status: number,
  code: string,
) {
  const result = await page.evaluate(async (targetPath) => {
    const response = await fetch(targetPath);
    const payload = (await response.json()) as { error: { code: string } };
    return { status: response.status, code: payload.error.code };
  }, path);
  expect(result).toEqual({ status, code });
}
