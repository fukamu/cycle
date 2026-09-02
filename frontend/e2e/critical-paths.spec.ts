import { expect, test } from "@playwright/test";

import { newUUIDv7 } from "../src/shared/id/uuid";
import { expectAPIError, getSession, requestFromPage } from "./support/api";
import {
  completeCurrentCycle,
  createAndCompleteGoal,
  createProgressingGoal,
  saveFrame,
  saveText,
} from "./support/workspace";

test("goal creation, cycle completion, review, next cycle, timeline, and delete", async ({
  page,
}) => {
  const goalText = "平日は主要業務を18時までに終えたい";
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  const goal = page.getByRole("textbox", { name: "あなたの目標" });
  await expect(goal).not.toHaveAttribute("maxlength");
  await expect(page.getByText("0 / 80")).toBeVisible();
  const maximumGoal = "😀".repeat(80);
  await saveText(page, goal, maximumGoal, "/api/v1/goal-drafts/");
  await expect(goal).toHaveValue(maximumGoal);
  await expect(page.getByText("80 / 80")).toBeVisible();
  await goal.fill(`${maximumGoal}😀`);
  await expect(goal).toHaveValue(maximumGoal);
  await saveText(page, goal, goalText, "/api/v1/goal-drafts/");
  await page.getByRole("button", { name: "AIで目標を整える" }).click();
  await expect(
    page.getByRole("heading", { name: "AIからの提案" }),
  ).toBeVisible();
  await expect(goal).toHaveValue(goalText);
  const adoptResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url().includes("/refinements/") &&
      candidate.url().endsWith("/adopt") &&
      candidate.ok(),
  );
  await page.getByRole("button", { name: "提案を採用" }).click();
  await adoptResponse;
  await expect(page.getByRole("heading", { name: "AIからの提案" })).toHaveCount(
    0,
  );
  await expect(goal).toHaveValue(goalText);
  await expect(page.getByText("保存済み")).toBeVisible();
  await page.getByRole("button", { name: "この目標で始める" }).click();
  await expect(page.getByText("Goal v1 · Cycle 1")).toBeVisible();
  const planEditor = page.getByRole("textbox", { name: "P — Plan" });
  await expect(planEditor).not.toHaveAttribute("maxlength");
  await expect(page.getByText("0 / 200")).toBeVisible();
  const maximumFrame = "😀".repeat(200);
  await saveFrame(page, "P — Plan", maximumFrame, "P");
  await expect(planEditor).toHaveValue(maximumFrame);
  await expect(page.getByText("200 / 200")).toBeVisible();
  await planEditor.fill(`${maximumFrame}😀`);
  await expect(planEditor).toHaveValue(maximumFrame);

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
  await expect(
    page.locator('[data-version-number="1"]').getByText("GOAL V1"),
  ).toBeVisible();
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

test("cycle completion reuses its operation after committed response loss and converges to the current workspace", async ({
  page,
}) => {
  await createProgressingGoal(page, "応答喪失後も一度だけ完了する目標");
  const workspaceRoute = new URL(page.url()).pathname.match(
    /^\/goals\/([^/]+)\/cycles\/([^/]+)$/,
  );
  expect(workspaceRoute).not.toBeNull();
  const [, goalId, cycleId] = workspaceRoute!;

  await saveFrame(page, "P — Plan", "応答喪失を再現する計画", "D");
  await saveFrame(page, "D — Do", "Backendまで完了requestを届けた", "C");
  await saveFrame(page, "C — Check", "browser responseだけ失った", "A");
  await saveFrame(page, "A — Action", "同じcommandとして再試行する", "A");

  type CompletionRequest = {
    readonly operationId: string;
    readonly expectedGoalRevision: number;
    readonly expectedContentRevision: number;
  };
  const completionRequests: CompletionRequest[] = [];
  let firstCommitStatus: number | undefined;
  let firstRequestCSRFToken: string | undefined;
  let markSecondRequestSeen!: () => void;
  const secondRequestSeen = new Promise<void>((resolve) => {
    markSecondRequestSeen = resolve;
  });
  await page.route(
    `**/api/v1/goals/${goalId}/cycles/${cycleId}/complete`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      completionRequests.push(
        route.request().postDataJSON() as CompletionRequest,
      );
      if (completionRequests.length === 1) {
        firstRequestCSRFToken = route.request().headers()["x-csrf-token"];
        const committedResponse = await route.fetch();
        firstCommitStatus = committedResponse.status();
        await committedResponse.dispose();
        await route.abort("connectionfailed");
        return;
      }
      if (completionRequests.length === 2) markSecondRequestSeen();
      await route.continue();
    },
  );

  await page.getByRole("button", { name: "サイクルを完了" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "サイクルを完了" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "サイクルを完了できませんでした",
  );
  expect(firstCommitStatus).toBe(200);
  expect(completionRequests).toHaveLength(1);
  expect(firstRequestCSRFToken).toBeTruthy();

  const reviewResult = await requestFromPage(page, {
    path: `/api/v1/goals/${goalId}/review`,
  });
  expect(reviewResult.status).toBe(200);
  const review = reviewResult.payload as {
    readonly goal: { readonly revision: number };
    readonly reviewDraft: { readonly revision: number };
  };
  const continueResult = await requestFromPage(page, {
    path: `/api/v1/goals/${goalId}/review/continue`,
    method: "POST",
    csrfToken: firstRequestCSRFToken,
    body: {
      operationId: newUUIDv7(),
      expectedGoalRevision: review.goal.revision,
      expectedDraftRevision: review.reviewDraft.revision,
    },
  });
  expect(continueResult.status).toBe(200);
  const continued = continueResult.payload as {
    readonly cycle: {
      readonly id: string;
      readonly sequenceNumber: number;
      readonly status: string;
    };
  };
  expect(continued.cycle).toMatchObject({
    sequenceNumber: 2,
    status: "active",
  });

  await page.getByRole("button", { name: "サイクルを完了" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "サイクルを完了" })
    .click();
  await secondRequestSeen;
  expect(completionRequests).toHaveLength(2);
  expect(completionRequests[1].operationId).toBe(
    completionRequests[0].operationId,
  );
  expect(completionRequests[1]).toEqual(completionRequests[0]);

  await expect(page).toHaveURL(`/goals/${goalId}/cycles/${continued.cycle.id}`);
  await expect(page.getByText("Goal v1 · Cycle 2")).toBeVisible();

  const goalResult = await requestFromPage(page, {
    path: `/api/v1/goals/${goalId}`,
  });
  expect(goalResult).toMatchObject({
    status: 200,
    payload: {
      goal: {
        id: goalId,
        status: "active_cycle",
        currentWork: {
          kind: "active_cycle",
          cycleId: continued.cycle.id,
          cycleSequenceNumber: 2,
        },
      },
    },
  });
  const cyclesResult = await requestFromPage(page, {
    path: `/api/v1/goals/${goalId}/cycles?limit=20`,
  });
  expect(cyclesResult.status).toBe(200);
  const cycles = cyclesResult.payload as {
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly sequenceNumber: number;
      readonly status: string;
    }>;
  };
  expect(cycles.items).toHaveLength(2);
  expect(cycles.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: cycleId,
        sequenceNumber: 1,
        status: "completed",
      }),
      expect.objectContaining({
        id: continued.cycle.id,
        sequenceNumber: 2,
        status: "active",
      }),
    ]),
  );
});

test("two stale tabs converge from Cycle Complete and Review Continue without repeating commands", async ({
  context,
  page,
}) => {
  const goalText = "複数タブでも現在の作業へ安全に収束する目標";
  await createProgressingGoal(page, goalText);
  await saveFrame(page, "P — Plan", "二つのタブで確認する計画", "D");
  await saveFrame(page, "D — Do", "先行タブで作業を完了した", "C");
  await saveFrame(page, "C — Check", "後続タブは古い状態になった", "A");
  await saveFrame(page, "A — Action", "現在の作業へ収束する", "A");
  const cyclePath = new URL(page.url()).pathname;
  const cycleRoute = cyclePath.match(/^\/goals\/([^/]+)\/cycles\/([^/]+)$/);
  expect(cycleRoute).not.toBeNull();
  const [, goalId, cycleId] = cycleRoute!;

  const stale = await context.newPage();
  try {
    await stale.goto(cyclePath);
    await expect(stale.getByText("Goal v1 · Cycle 1")).toBeVisible();
    await stale.getByRole("tab", { name: /^A/ }).click();
    await expect(
      stale.getByRole("button", { name: "サイクルを完了" }),
    ).toBeEnabled();

    // Opening the second tab currently refreshes the session-wide CSRF token
    // (tracked separately by #96). Authorize only the Complete/Continue
    // requests from both tabs with the current token so this test isolates
    // workspace-state convergence and still reaches the real Backend conflict
    // contract without mocking either response.
    const activeCSRFToken = (await getSession(stale)).csrfToken;
    await page.route(
      `**/api/v1/goals/${goalId}/cycles/${cycleId}/complete`,
      async (route) => {
        await route.continue({
          headers: {
            ...route.request().headers(),
            "x-csrf-token": activeCSRFToken,
          },
        });
      },
    );
    await page.route(
      `**/api/v1/goals/${goalId}/review/continue`,
      async (route) => {
        await route.continue({
          headers: {
            ...route.request().headers(),
            "x-csrf-token": activeCSRFToken,
          },
        });
      },
    );

    await page.getByRole("button", { name: "サイクルを完了" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "サイクルを完了" })
      .click();
    await expect(
      page.getByRole("button", { name: "この目標で次のサイクルへ" }),
    ).toBeVisible();

    let staleCompleteRequests = 0;
    await stale.route(
      `**/api/v1/goals/${goalId}/cycles/${cycleId}/complete`,
      async (route) => {
        if (route.request().method() === "POST") staleCompleteRequests += 1;
        await route.continue({
          headers: {
            ...route.request().headers(),
            "x-csrf-token": activeCSRFToken,
          },
        });
      },
    );
    const staleCompleteResponse = stale.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/v1/goals/${goalId}/cycles/${cycleId}/complete`),
    );
    await stale.getByRole("button", { name: "サイクルを完了" }).click();
    await stale
      .getByRole("dialog")
      .getByRole("button", { name: "サイクルを完了" })
      .click();
    const completeConflict = await staleCompleteResponse;
    expect(completeConflict.status()).toBe(409);
    expect(
      (
        (await completeConflict.json()) as {
          error: { code: string };
        }
      ).error.code,
    ).toBe("GOAL_STATE_CONFLICT");
    await expect(
      stale.getByText("現在の作業状態が更新されました"),
    ).toBeVisible();
    await expect(
      stale.getByRole("textbox", { name: "A — Action" }),
    ).toHaveAttribute("readonly", "");
    expect(staleCompleteRequests).toBe(1);

    await stale.getByRole("link", { name: "現在の作業へ移動" }).click();
    await expect(
      stale.getByRole("button", { name: "この目標で次のサイクルへ" }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "この目標で次のサイクルへ" })
      .click();
    await expect(page.getByText("Goal v1 · Cycle 2")).toBeVisible();

    let staleContinueRequests = 0;
    await stale.route(
      `**/api/v1/goals/${goalId}/review/continue`,
      async (route) => {
        if (route.request().method() === "POST") staleContinueRequests += 1;
        await route.continue({
          headers: {
            ...route.request().headers(),
            "x-csrf-token": activeCSRFToken,
          },
        });
      },
    );
    const staleContinueResponse = stale.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/v1/goals/${goalId}/review/continue`),
    );
    await stale
      .getByRole("button", { name: "この目標で次のサイクルへ" })
      .click();
    const continueConflict = await staleContinueResponse;
    expect(continueConflict.status()).toBe(409);
    expect(
      (
        (await continueConflict.json()) as {
          error: { code: string };
        }
      ).error.code,
    ).toBe("GOAL_REVIEW_NOT_ACTIVE");
    await expect(
      stale.getByText("Reviewの作業場所は変わりました。", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      stale.getByRole("textbox", {
        name: "次のサイクルで目指す目標",
      }),
    ).toHaveAttribute("readonly", "");
    expect(staleContinueRequests).toBe(1);

    await stale
      .getByRole("link", { name: "現在のGoalを開いてください" })
      .click();
    await expect(stale.getByText("Goal v1 · Cycle 2")).toBeVisible();
    expect(staleCompleteRequests).toBe(1);
    expect(staleContinueRequests).toBe(1);
  } finally {
    await stale.close();
  }
});

test("a stale Home tab converges to the existing creation draft without repeating POST", async ({
  context,
  page,
}) => {
  const savedBody = "別のタブで保存された既存の目標下書き";
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "新しい目標を設定" }),
  ).toBeVisible();

  const stale = await context.newPage();
  try {
    await stale.goto("/");
    await expect(
      stale.getByRole("button", { name: "新しい目標を設定" }),
    ).toBeVisible();

    // Opening the second tab currently refreshes the session-wide CSRF token
    // (tracked separately by #96). Authorize only the two creation POSTs with
    // the current token so this test reaches the real Backend 201/409 pair.
    const activeCSRFToken = (await getSession(stale)).csrfToken;
    await page.route("**/api/v1/goal-drafts", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-csrf-token": activeCSRFToken,
        },
      });
    });

    const winnerCreationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/goal-drafts",
    );
    await page.getByRole("button", { name: "新しい目標を設定" }).click();
    const winnerCreation = await winnerCreationResponse;
    expect(winnerCreation.status()).toBe(201);
    const winnerDraft = (await winnerCreation.json()) as {
      readonly draft: { readonly id: string; readonly revision: number };
    };

    const saved = await requestFromPage(page, {
      path: `/api/v1/goal-drafts/${winnerDraft.draft.id}`,
      method: "PATCH",
      csrfToken: activeCSRFToken,
      body: {
        body: savedBody,
        expectedRevision: winnerDraft.draft.revision,
      },
    });
    expect(saved).toMatchObject({
      status: 200,
      payload: { draft: { body: savedBody } },
    });

    let staleCreationRequests = 0;
    await stale.route("**/api/v1/goal-drafts", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      staleCreationRequests += 1;
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-csrf-token": activeCSRFToken,
        },
      });
    });
    const staleCreationResponse = stale.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/goal-drafts",
    );

    await stale.getByRole("button", { name: "新しい目標を設定" }).click();
    const conflict = await staleCreationResponse;
    expect(conflict.status()).toBe(409);
    expect(
      (
        (await conflict.json()) as {
          readonly error: { readonly code: string };
        }
      ).error.code,
    ).toBe("GOAL_CREATION_DRAFT_ALREADY_EXISTS");

    await expect(stale).toHaveURL("/goals/new");
    await expect(
      stale.getByRole("textbox", { name: "あなたの目標" }),
    ).toHaveValue(savedBody);
    expect(staleCreationRequests).toBe(1);
  } finally {
    await stale.close();
  }
});

test("a failed autosave keeps the browser draft and retry persists it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  let fail = true;
  await page.route("**/api/v1/goal-drafts/*", async (route) => {
    if (route.request().method() === "PATCH" && fail) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  const editor = page.getByRole("textbox", { name: "あなたの目標" });
  await editor.fill("失敗しても保持する目標");
  await expect(page.getByRole("alert")).toContainText("保存失敗", {
    timeout: 45_000,
  });
  const browserDraftBodies = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("fukamu-cycle-browser-drafts-v2");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const read = database
            .transaction("drafts")
            .objectStore("drafts")
            .getAll();
          read.onerror = () => {
            database.close();
            reject(read.error);
          };
          read.onsuccess = () => {
            const bodies = (read.result as { body: string }[]).map(
              (draft) => draft.body,
            );
            database.close();
            resolve(bodies);
          };
        };
      }),
  );
  expect(browserDraftBodies).toContain("失敗しても保持する目標");
  fail = false;
  await page.getByRole("button", { name: "再試行" }).click();
  await expect(page.getByText("保存済み")).toBeVisible();
  await page.reload();
  await expect(editor).toHaveValue("失敗しても保持する目標");
});

test("timeline distinguishes V1, V2, and V3 goal segments", async ({
  page,
}) => {
  const goalVersions = [
    "最初の目標",
    "二回目に見直した目標",
    "三回目に見直した目標",
  ];
  await createProgressingGoal(page, goalVersions[0]);
  await completeCurrentCycle(page, "V1");

  const review = page.getByRole("textbox", {
    name: "次のサイクルで目指す目標",
  });
  await saveText(page, review, goalVersions[1], "/review");
  await page.getByRole("button", { name: "この目標で次のサイクルへ" }).click();
  await expect(page.getByText("Goal v2 · Cycle 2")).toBeVisible();
  await completeCurrentCycle(page, "V2");

  await saveText(page, review, goalVersions[2], "/review");
  await page.getByRole("button", { name: "この目標で次のサイクルへ" }).click();
  await expect(page.getByText("Goal v3 · Cycle 3")).toBeVisible();

  const route = new URL(page.url()).pathname.match(
    /^\/goals\/([^/]+)\/cycles\//,
  );
  expect(route).not.toBeNull();
  await page.goto(`/history/goals/${route![1]}`);

  const segments = page.locator("[data-version-number]");
  await expect(segments).toHaveCount(3);
  expect(
    await segments.evaluateAll((values) =>
      values.map((value) => value.getAttribute("data-version-number")),
    ),
  ).toEqual(["3", "2", "1"]);
  await expect(page.getByText("目標を変更しました")).toHaveCount(2);
  expect(
    await page
      .locator(".timeline > li")
      .evaluateAll((entries) =>
        entries.map((entry) =>
          entry.getAttribute("data-timeline-entry") === "period"
            ? `period-${entry.getAttribute("data-version-number")}`
            : `${entry.getAttribute("data-timeline-event")}-${entry.getAttribute("data-event-version")}`,
        ),
      ),
  ).toEqual([
    "period-3",
    "change-3",
    "period-2",
    "change-2",
    "period-1",
    "created-1",
  ]);

  const v1 = page.locator('[data-version-number="1"]');
  const v2 = page.locator('[data-version-number="2"]');
  const v3 = page.locator('[data-version-number="3"]');
  await expect(v1).toHaveAttribute("data-version-kind", "baseline");
  await expect(v2).toHaveAttribute("data-version-kind", "revision");
  await expect(v3).toHaveAttribute("data-version-kind", "revision");
  for (const past of [v1, v2]) {
    await expect(past).toHaveAttribute("data-version-state", "past");
    await expect(past.locator(".timeline-period__rail")).toHaveCSS(
      "background-color",
      "rgb(204, 218, 236)",
    );
  }
  await expect(v3).toHaveAttribute("data-version-state", "current");
  await expect(v3.locator(".timeline-period__rail")).toHaveCSS(
    "background-color",
    "rgb(74, 144, 226)",
  );
  for (const versionNumber of [1, 2]) {
    const pastEvent = page.locator(`[data-event-version="${versionNumber}"]`);
    await expect(pastEvent).toHaveAttribute("data-version-state", "past");
    await expect(pastEvent.locator(".timeline-event__marker")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
  }
  const currentEvent = page.locator('[data-event-version="3"]');
  await expect(currentEvent).toHaveAttribute("data-version-state", "current");
  await expect(currentEvent.locator(".timeline-event__marker")).toHaveCSS(
    "background-color",
    "rgb(74, 144, 226)",
  );
  await expect(page.locator('[data-event-version="3"]')).toContainText(
    "Cycle 2の終了後",
  );
  await expect(page.locator('[data-event-version="2"]')).toContainText(
    "Cycle 1の終了後",
  );
  await expect(v1.getByRole("link", { name: /Cycle 1/ })).toBeVisible();
  await expect(v2.getByRole("link", { name: /Cycle 2/ })).toBeVisible();
  await expect(v3.getByRole("link", { name: /Cycle 3/ })).toBeVisible();
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

  const limitAttempt = await page.evaluate(async (operationId) => {
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
          operationId,
          expectedDraftRevision: home.creationDraft.revision,
        }),
      },
    );
    const payload = (await response.json()) as { error: { code: string } };
    return { status: response.status, code: payload.error.code };
  }, newUUIDv7());
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

test("mobile long content stays in bounds and frame tabs support keyboard navigation", async ({
  page,
}) => {
  const goalText = "長い目標".repeat(20);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  await saveText(
    page,
    page.getByRole("textbox", { name: "あなたの目標" }),
    goalText,
    "/api/v1/goal-drafts/",
  );
  await page.getByRole("button", { name: "この目標で始める" }).click();

  await expect(page.getByRole("heading", { name: goalText })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  const planTab = page.getByRole("tab", { name: /^P/ });
  const doTab = page.getByRole("tab", { name: /^D/ });
  await planTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(doTab).toBeFocused();
  await expect(doTab).toHaveAttribute("aria-selected", "true");
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
    "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionとして保存されません",
  );
  await dialog.getByRole("button", { name: "目標を達成" }).click();
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();
});

test("goal review termination explicitly covers cross-tab changes without local edits", async ({
  page,
}) => {
  await createAndCompleteGoal(page);
  await page.getByRole("button", { name: "目標を終了" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionとして保存されません",
  );
  await expect(dialog).toContainText("現在の目標のまま終了します");
  await dialog.getByRole("button", { name: "目標を終了" }).click();
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
    const outsiderSession = await getSession(outsider);
    await expectAPIError(
      outsider,
      { path: `/api/v1/goal-drafts/${draftPayload.draft.id}` },
      404,
      "GOAL_DRAFT_NOT_FOUND",
    );
    await expectAPIError(
      outsider,
      {
        path: `/api/v1/goal-drafts/${draftPayload.draft.id}`,
        method: "PATCH",
        csrfToken: outsiderSession.csrfToken,
        body: { body: "所有者外の変更", expectedRevision: 0 },
      },
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
      { path: `/api/v1/goals/${goalId}` },
      404,
      "GOAL_NOT_FOUND",
    );
    await expectAPIError(
      outsider,
      { path: `/api/v1/goals/${goalId}/cycles/${cycleId}` },
      404,
      "GOAL_NOT_FOUND",
    );

    await expectAPIError(
      outsider,
      {
        path: `/api/v1/goals/${goalId}/cycles/${cycleId}/frames/plan`,
        method: "PATCH",
        csrfToken: outsiderSession.csrfToken,
        body: {
          content: "所有者外の変更",
          expectedFrameRevision: 0,
        },
      },
      404,
      "GOAL_NOT_FOUND",
    );
    await expectAPIError(
      outsider,
      {
        path: `/api/v1/goals/${goalId}/cycles/${cycleId}/actions/generate`,
        method: "POST",
        csrfToken: outsiderSession.csrfToken,
        idempotencyKey: newUUIDv7(),
        body: {
          expectedContentRevision: 0,
          confirmReplace: false,
        },
      },
      404,
      "CYCLE_NOT_FOUND",
    );
    await expectAPIError(
      outsider,
      {
        path: `/api/v1/goals/${goalId}/termination`,
        method: "POST",
        csrfToken: outsiderSession.csrfToken,
        body: {
          operationId: newUUIDv7(),
          outcome: "ended",
          expectedGoalRevision: 0,
          expectedState: "active_cycle",
          activeCycleId: cycleId,
          expectedCycleContentRevision: 0,
        },
      },
      404,
      "GOAL_NOT_FOUND",
    );
    await expectAPIError(
      outsider,
      {
        path: `/api/v1/goals/${goalId}`,
        method: "DELETE",
        csrfToken: outsiderSession.csrfToken,
        idempotencyKey: newUUIDv7(),
        body: { confirmed: true, expectedGoalRevision: 0 },
      },
      404,
      "GOAL_NOT_FOUND",
    );

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
