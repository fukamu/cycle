import { expect, test, type Page, type Route } from "@playwright/test";

import {
  cycleFrameCopy,
  cycleFrameTemplateCopy,
  frameCopy,
  homeCopy,
  textCounterCopy,
} from "../src/shared/copy/ja";
import { newUUIDv7 } from "../src/shared/id/uuid";
import { expectAPIError, getSession, requestFromPage } from "./support/api";
import {
  completeCurrentCycle,
  createAndCompleteGoal,
  createProgressingGoal,
  saveFrame,
  saveText,
} from "./support/workspace";

type StoredBrowserDraft = {
  readonly key: string;
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly body: string;
  readonly baseRevision: number;
  readonly updatedAt: string;
};

function readBrowserDrafts(page: Page): Promise<StoredBrowserDraft[]> {
  return page.evaluate(
    () =>
      new Promise<StoredBrowserDraft[]>((resolve, reject) => {
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
            const drafts = read.result as StoredBrowserDraft[];
            database.close();
            resolve(drafts);
          };
        };
      }),
  );
}

async function readBrowserDraftBodies(page: Page): Promise<string[]> {
  return (await readBrowserDrafts(page)).map((draft) => draft.body);
}

async function readBrowserDraft(
  page: Page,
  key: string,
): Promise<StoredBrowserDraft | null> {
  return (
    (await readBrowserDrafts(page)).find((draft) => draft.key === key) ?? null
  );
}

function writeBrowserDraft(
  page: Page,
  draft: StoredBrowserDraft,
): Promise<void> {
  return page.evaluate(
    (record) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("fukamu-cycle-browser-drafts-v2");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction("drafts", "readwrite");
          transaction.objectStore("drafts").put(record);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
    draft,
  );
}

async function expectActionGuidanceAtNarrowWidths(
  page: Page,
  guidanceText: string,
  actionNames: readonly string[],
) {
  const assertLayout = async () => {
    const guidance = page.getByText(guidanceText, { exact: true });
    await expect(guidance).toBeVisible();
    const guidanceId = await guidance.getAttribute("id");
    expect(guidanceId).toBeTruthy();
    for (const name of actionNames) {
      const action = page.getByRole("button", { name });
      await expect(action).toBeVisible();
      await expect(action).toHaveAttribute("aria-describedby", /\S+/);
      expect(
        (await action.getAttribute("aria-describedby"))?.split(/\s+/),
      ).toContain(guidanceId);
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  };

  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await assertLayout();

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await assertLayout();
}

async function expectHomeGoalCountAtNarrowWidths(
  page: Page,
  count: number,
  limit: number,
) {
  const assertLayout = async () => {
    const indicator = page.getByRole("status", {
      name: homeCopy.progressingGoalCountAccessible(count, limit),
    });
    await expect(indicator).toHaveText(
      homeCopy.progressingGoalCount(count, limit),
    );
    expect(
      await page.evaluate(() => {
        const heading = document.querySelector("#progressing-heading");
        const goalCount = document.querySelector(".progressing-goal-count");
        if (!(heading instanceof HTMLElement))
          throw new Error("progressing Goal heading is missing");
        if (!(goalCount instanceof HTMLElement))
          throw new Error("progressing Goal count is missing");
        const headingRect = heading.getBoundingClientRect();
        const countRect = goalCount.getBoundingClientRect();
        const overlaps = !(
          headingRect.right <= countRect.left ||
          countRect.right <= headingRect.left ||
          headingRect.bottom <= countRect.top ||
          countRect.bottom <= headingRect.top
        );
        return {
          overlaps,
          horizontalOverflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      }),
    ).toEqual({ overlaps: false, horizontalOverflow: false });
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await assertLayout();

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await assertLayout();

  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function expectTextCounterAtNarrowWidths(
  page: Page,
  subject: string,
  count: number,
  limit: number,
) {
  const assertLayout = async () => {
    const counter = page.getByRole("status", {
      name: textCounterCopy.accessible(subject, count, limit),
    });
    await expect(counter).toHaveText(textCounterCopy.visible(count, limit));
    await expect(counter).toHaveAttribute("aria-live", "off");
    expect(
      await counter.evaluate((element) => {
        const meta = element.closest(".editor-meta");
        if (!(meta instanceof HTMLElement))
          throw new Error("editor metadata is missing");
        const counterRect = element.getBoundingClientRect();
        const siblingRects = Array.from(meta.children)
          .filter((candidate) => candidate !== element)
          .map((candidate) => candidate.getBoundingClientRect());
        return {
          overlapsSibling: siblingRects.some(
            (rect) =>
              counterRect.left < rect.right &&
              counterRect.right > rect.left &&
              counterRect.top < rect.bottom &&
              counterRect.bottom > rect.top,
          ),
          horizontalOverflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      }),
    ).toEqual({ overlapsSibling: false, horizontalOverflow: false });
  };

  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await assertLayout();

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await assertLayout();

  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function expectReviewSuggestionAtNarrowWidths(
  page: Page,
  content: {
    readonly currentGoal: string;
    readonly plan: string;
    readonly do: string;
    readonly check: string;
    readonly action: string;
  },
) {
  const assertLayout = async () => {
    const decisionContext = page.getByRole("region", { name: "判断の材料" });
    const currentGoal = page.locator(".goal-context h1");
    const checkHeading = decisionContext.getByRole("heading", {
      name: "直前のC — 分かったこと",
    });
    const actionHeading = decisionContext.getByRole("heading", {
      name: "直前のA — 次に続ける・変えること",
    });
    const learningCards = decisionContext.locator(
      ".review-decision-context__learning article",
    );
    const checkBody = learningCards.nth(0).locator("p");
    const actionBody = learningCards.nth(1).locator("p");
    const planAndDo = decisionContext.locator("details.cycle-summary");
    const planAndDoSummary = planAndDo.locator("summary");
    const planBody = planAndDo.locator(":scope > div").nth(0).locator("p");
    const doBody = planAndDo.locator(":scope > div").nth(1).locator("p");
    const refine = page.getByRole("button", { name: "AIで目標を整える" });
    const comparison = page.getByRole("region", { name: "AIからの提案" });
    const adopt = comparison.getByRole("button", { name: "提案を採用" });
    const nextCycleSection = page.getByRole("region", {
      name: "次のサイクルへ進む",
    });
    const nextCycleHeading = nextCycleSection.getByRole("heading", {
      level: 2,
      name: "次のサイクルへ進む",
    });
    const note = nextCycleSection.getByText(
      /現在のGoal v\d+を維持し、新しいGoal Versionは作成せず、Cycle \d+を開始します/,
    );
    const continueAction = nextCycleSection.getByRole("button", {
      name: "この目標で次のサイクルへ",
    });
    const terminalSection = page.getByRole("region", {
      name: "この目標を終える",
    });
    const terminalHeading = terminalSection.getByRole("heading", {
      level: 2,
      name: "この目標を終える",
    });
    const achieve = terminalSection.getByRole("button", {
      name: "目標を達成として終了",
    });
    const end = terminalSection.getByRole("button", { name: "目標を終了" });

    for (const element of [
      currentGoal,
      checkHeading,
      actionHeading,
      refine,
      comparison,
      adopt,
      nextCycleHeading,
      note,
      continueAction,
      terminalHeading,
      achieve,
      end,
    ])
      await expect(element).toBeVisible();
    for (const [element, expectedText] of [
      [currentGoal, content.currentGoal],
      [checkBody, content.check],
      [actionBody, content.action],
    ] as const) {
      await expect(element).toHaveText(expectedText);
      expect(
        await element.evaluate((node) => ({
          text: node.textContent,
          whiteSpace: window.getComputedStyle(node).whiteSpace,
        })),
      ).toEqual({ text: expectedText, whiteSpace: "pre-wrap" });
    }
    if ((await planAndDo.getAttribute("open")) === null)
      await planAndDoSummary.press("Enter");
    await expect(planBody).toHaveText(content.plan);
    await expect(doBody).toHaveText(content.do);
    for (const [element, expectedText] of [
      [planBody, content.plan],
      [doBody, content.do],
    ] as const) {
      expect(
        await element.evaluate((node) => ({
          text: node.textContent,
          whiteSpace: window.getComputedStyle(node).whiteSpace,
        })),
      ).toEqual({ text: expectedText, whiteSpace: "pre-wrap" });
    }
    await planAndDoSummary.press("Enter");
    await expect(planBody).toBeHidden();
    await expect(doBody).toBeHidden();
    await planAndDoSummary.press("Enter");
    await expect(planBody).toBeVisible();
    await expect(doBody).toBeVisible();
    await expect(continueAction).toHaveAccessibleDescription(
      /新しいGoal Versionは作成せず、Cycle \d+を開始します/,
    );
    await expect(achieve).toHaveAccessibleDescription(
      /目標を達成した状態として記録して、ここで取り組みを終えます/,
    );
    await expect(end).toHaveAccessibleDescription(
      /目標を達成したとはせず、ここで取り組みを終えます/,
    );

    const layout = await page.locator("main.review-page").evaluate((main) => {
      const buttons = Array.from(main.querySelectorAll("button"));
      const button = (label: string) =>
        buttons.find((candidate) => candidate.textContent?.trim() === label) ??
        null;
      const elements = [
        button("AIで目標を整える"),
        main.querySelector(".suggestion-panel"),
        button("提案を採用"),
        main.querySelector(".next-cycle-actions h2"),
        main.querySelector(".next-cycle-note"),
        button("この目標で次のサイクルへ"),
        main.querySelector(".terminal-actions"),
        button("目標を達成として終了"),
        button("目標を終了"),
      ];
      const missing = elements
        .map((element, index) => (element ? null : index))
        .filter((index): index is number => index !== null);
      return {
        missing,
        ordered:
          missing.length === 0 &&
          elements.slice(0, -1).every((element, index) => {
            const following = elements[index + 1];
            return Boolean(
              element &&
              following &&
              element.compareDocumentPosition(following) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }),
        documentOverflows:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      };
    });
    expect(layout).toEqual({
      missing: [],
      ordered: true,
      documentOverflows: false,
    });
  };

  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await assertLayout();

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await assertLayout();

  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await page.setViewportSize({ width: 320, height: 844 });

  const editor = page.getByRole("textbox", {
    name: "次のサイクルで目指す目標",
  });
  await editor.focus();
  for (const action of [
    "AIで目標を整える",
    "元の目標を維持",
    "提案を採用",
    "この目標で次のサイクルへ",
    "目標を達成として終了",
    "目標を終了",
    "目標を削除",
  ]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: action })).toBeFocused();
  }

  await page.setViewportSize({ width: 1280, height: 720 });
}

test("header drawer contains focus and deactivates the background", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto("/");

  const menuButton = page.locator(".menu-button");
  const skipLink = page.locator(".skip-link");
  const wordmark = page.locator(".wordmark");
  const mainContent = page.locator("#main-content");
  const backgroundAction = page.getByRole("button", {
    name: "新しい目標を設定",
  });
  await expect(backgroundAction).toBeVisible();
  expect((await menuButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  await menuButton.click();
  const drawer = page.getByRole("navigation", { name: "メインメニュー" });
  const desktopLayout = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      documentOverflows:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      insideViewport: rect.left >= 0 && rect.right <= window.innerWidth,
    };
  });
  expect(desktopLayout).toEqual({
    documentOverflows: false,
    insideViewport: true,
  });
  await page.keyboard.press("Escape");
  await expect(menuButton).toBeFocused();

  await page.setViewportSize({ width: 320, height: 844 });
  expect((await menuButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  await menuButton.click();
  await expect(menuButton).toHaveAccessibleName("メニューを閉じる");
  const history = page.getByRole("link", { name: "目標の履歴" });
  const settings = page.getByRole("link", { name: "設定" });
  const firstUseHelp = page.getByRole("button", {
    name: "はじめてガイドを表示",
  });
  await expect(history).toBeFocused();
  await expect(history).not.toHaveAttribute("aria-current");
  await expect(settings).not.toHaveAttribute("aria-current");
  expect(
    await page.evaluate(() => ({
      main: document.querySelector<HTMLElement>("#main-content")?.inert,
      skipLink: document.querySelector<HTMLElement>(".skip-link")?.inert,
      wordmark: document.querySelector<HTMLElement>(".wordmark")?.inert,
    })),
  ).toEqual({ main: true, skipLink: true, wordmark: true });
  const backdrop = page.locator(".drawer-backdrop");
  await expect(backdrop).toHaveAttribute("aria-hidden", "true");
  await expect(backdrop).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("Shift+Tab");
  await expect(menuButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(history).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(settings).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstUseHelp).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menuButton).toBeFocused();
  await backgroundAction.evaluate((element) => element.focus());
  await expect(menuButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menuButton).toHaveAccessibleName("メニューを開く");
  await expect(menuButton).toBeFocused();
  await expect(skipLink).not.toHaveAttribute("inert", "");
  await expect(wordmark).not.toHaveAttribute("inert", "");
  await expect(mainContent).not.toHaveAttribute("inert", "");

  await menuButton.click();
  await backdrop.click({ position: { x: 8, y: 8 } });
  await expect(menuButton).toHaveAccessibleName("メニューを開く");
  await expect(menuButton).toBeFocused();

  await menuButton.click();
  await history.click();
  const destination = page.getByRole("heading", {
    level: 1,
    name: "目標の履歴",
  });
  await expect(destination).toBeFocused();
  await expect(mainContent).not.toHaveAttribute("inert", "");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await menuButton.click();
  await expect(history).toHaveAttribute("aria-current", "page");
  await expect(settings).not.toHaveAttribute("aria-current");
  await expect(history.getByText("現在地", { exact: true })).toBeVisible();
  const currentItemLayout = await history.evaluate((element) => {
    const label = element.querySelector<HTMLElement>(".drawer__link-label");
    const marker = element.querySelector<HTMLElement>(".drawer__current");
    const labelRect = label?.getBoundingClientRect();
    const markerRect = marker?.getBoundingClientRect();
    return {
      documentOverflows:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      partsOverlap:
        labelRect && markerRect
          ? labelRect.right > markerRect.left &&
            labelRect.left < markerRect.right &&
            labelRect.bottom > markerRect.top &&
            labelRect.top < markerRect.bottom
          : true,
    };
  });
  expect(currentItemLayout).toEqual({
    documentOverflows: false,
    partsOverlap: false,
  });

  await history.click();
  await expect(menuButton).toBeFocused();

  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await menuButton.click();
  await settings.click();
  const settingsDestination = page.getByRole("heading", {
    level: 1,
    name: "設定",
  });
  await expect(settingsDestination).toBeFocused();

  await menuButton.click();
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(history).not.toHaveAttribute("aria-current");
  await expect(settings.getByText("現在地", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);
});

test("Home preserves Creation Draft preview meaning at narrow widths", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  await page.getByRole("link", { name: "FUKAMU Cycle ホーム" }).click();

  let draftCard = page.locator(".draft-card");
  await expect(
    draftCard.getByText("まだ本文はありません。", { exact: true }),
  ).toBeVisible();

  await draftCard.getByRole("link", { name: "下書きを開く" }).click();
  const editor = page.getByRole("textbox", { name: "あなたの目標" });
  await saveText(page, editor, " \n\u3000", "/api/v1/goal-drafts/");
  await page.getByRole("link", { name: "FUKAMU Cycle ホーム" }).click();
  draftCard = page.locator(".draft-card");
  await expect(
    draftCard.getByText("まだ本文はありません。", { exact: true }),
  ).toBeVisible();

  await draftCard.getByRole("link", { name: "下書きを開く" }).click();
  const multilineBody = `一行目の目標\n${"長い日本語".repeat(12)}`;
  await saveText(page, editor, multilineBody, "/api/v1/goal-drafts/");

  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole("link", { name: "FUKAMU Cycle ホーム" }).click();
  const preview = page.locator(".draft-card__preview");
  await expect(preview).toHaveText(multilineBody);
  expect(
    await preview.evaluate((element) => getComputedStyle(element).whiteSpace),
  ).toBe("pre-wrap");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await page.getByRole("link", { name: "下書きを開く" }).click();
  await expect(page).toHaveURL(/\/goals\/new$/);
  await expect(editor).toHaveValue(multilineBody);
});

test("History loads another page explicitly from the keyboard at narrow widths", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "新しい目標を設定" }),
  ).toBeVisible();
  const session = await getSession(page);
  await page.addInitScript(() => {
    class IdleIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];

      disconnect() {}
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: IdleIntersectionObserver,
      writable: true,
    });
  });

  const firstGoal = "最初の長い目標".repeat(8);
  const nextGoal = "明示操作で読み込んだ次の目標";
  const makeGoal = (body: string, suffix: string) => ({
    id: `10000000-0000-7000-8000-${suffix}`,
    status: "ended",
    revision: 1,
    currentVersion: {
      id: `20000000-0000-7000-8000-${suffix}`,
      versionNumber: 1,
      body,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    currentWork: null,
    nextCycleSequenceNumber: 2,
    cycleCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    terminalAt: "2026-08-02T00:00:00.000Z",
  });
  let goalPageRequests = 0;
  let releaseNextPage = () => undefined;
  const nextPageMayResolve = new Promise<void>((resolve) => {
    releaseNextPage = resolve;
  });
  await page.route("**/api/v1/goals?*", async (route) => {
    const requestURL = new URL(route.request().url());
    const cursor = requestURL.searchParams.get("cursor");
    goalPageRequests += 1;
    if (cursor === "next-page") await nextPageMayResolve;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "X-Fukamu-Authenticated-User-ID": session.user.id,
      },
      body: JSON.stringify(
        cursor === "next-page"
          ? {
              items: [makeGoal(nextGoal, "000000000102")],
              nextCursor: null,
            }
          : {
              items: [makeGoal(firstGoal, "000000000101")],
              nextCursor: "next-page",
            },
      ),
    });
  });

  await page.goto("/history");
  const firstGoalLink = page.getByRole("link", {
    name: new RegExp(firstGoal),
  });
  const loadMore = page.getByRole("button", { name: "続きを読み込む" });
  await expect(firstGoalLink).toBeVisible();
  await expect(loadMore).toBeVisible();

  const expectReachableWithoutOverflow = async () => {
    await loadMore.scrollIntoViewIfNeeded();
    await expect(loadMore).toBeVisible();
    expect((await loadMore.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  };
  await page.setViewportSize({ width: 320, height: 844 });
  await expectReachableWithoutOverflow();
  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await expectReachableWithoutOverflow();

  await firstGoalLink.focus();
  await page.keyboard.press("Tab");
  await expect(loadMore).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => goalPageRequests).toBe(2);
  const loadingStatus = page.getByText("続きを読み込んでいます…");
  await expect(loadingStatus).toBeVisible();
  await expect(loadMore).toBeDisabled();
  await expect(loadMore).toHaveAttribute(
    "aria-describedby",
    (await loadingStatus.getAttribute("id")) ?? "",
  );
  await expect(firstGoalLink).toBeVisible();

  releaseNextPage();
  await expect(page.getByText(nextGoal)).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  await expect(page.getByText("すべての目標を読み込みました。")).toBeVisible();
  expect(await page.locator(".history-row h2").allTextContents()).toEqual([
    firstGoal,
    nextGoal,
  ]);
  expect(goalPageRequests).toBe(2);
});

test("goal creation, cycle completion, review, next cycle, timeline, and delete", async ({
  page,
}) => {
  const reviewNarrowContent = {
    currentGoal: `現在目標-${"UNBROKEN".repeat(7)}\n改行後の目標`,
    plan: `計画-${"PLANWITHOUTBREAK".repeat(10)}\n改行後の計画`,
    do: `実行-${"DOWITHOUTBREAK".repeat(11)}\n改行後の実行`,
    check: `確認-${"CHECKWITHOUTBREAK".repeat(10)}\n改行後の学び`,
    action: `改善-${"ACTIONWITHOUTBREAK".repeat(9)}\n改行後の次の一歩`,
  } as const;
  const goalText = reviewNarrowContent.currentGoal;
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();
  const goal = page.getByRole("textbox", { name: "あなたの目標" });
  await expect(goal).not.toHaveAttribute("maxlength");
  await expectTextCounterAtNarrowWidths(page, "あなたの目標", 0, 80);
  const maximumGoal = "😀".repeat(80);
  await saveText(page, goal, maximumGoal, "/api/v1/goal-drafts/");
  await expect(goal).toHaveValue(maximumGoal);
  await expect(
    page.getByRole("status", {
      name: "あなたの目標は上限80文字中80文字です",
    }),
  ).toHaveText("80 / 80文字");
  await goal.fill(`${maximumGoal}😀`);
  await expect(goal).toHaveValue(maximumGoal);
  await expect(
    page.getByText(
      "入力後は81文字になるため反映できませんでした。上限80文字まで、入力内容をあと1文字減らしてください。",
    ),
  ).toBeVisible();
  await saveText(page, goal, goalText, "/api/v1/goal-drafts/");
  await expect(page.getByText(/反映できませんでした/)).toHaveCount(0);
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
  await expect(
    page.getByRole("heading", { level: 1, name: goalText }),
  ).toBeFocused();
  await expect(page.getByText("Goal v1 · Cycle 1")).toBeVisible();
  const planEditor = page.getByRole("textbox", { name: "P — Plan" });
  await expect(planEditor).not.toHaveAttribute("maxlength");
  await expectTextCounterAtNarrowWidths(page, "P — Plan", 0, 200);
  const maximumFrame = "😀".repeat(200);
  await saveFrame(page, "P — Plan", maximumFrame, "P");
  await expect(planEditor).toHaveValue(maximumFrame);
  await expect(
    page.getByRole("status", {
      name: "P — Planは上限200文字中200文字です",
    }),
  ).toHaveText("200 / 200文字");
  await planEditor.fill(`${maximumFrame}😀`);
  await expect(planEditor).toHaveValue(maximumFrame);
  await expect(
    page.getByText(
      "入力後は201文字になるため反映できませんでした。上限200文字まで、入力内容をあと1文字減らしてください。",
    ),
  ).toBeVisible();

  await saveFrame(page, "P — Plan", reviewNarrowContent.plan, "D");
  await expect(page.getByText(/反映できませんでした/)).toHaveCount(0);
  await saveFrame(page, "D — Do", reviewNarrowContent.do, "C");
  const checkComparison = page.getByRole("region", {
    name: "今回のPとDを比べる",
  });
  await expect(checkComparison).toBeVisible();
  await expect(
    checkComparison.getByText(reviewNarrowContent.plan),
  ).toBeVisible();
  await expect(checkComparison.getByText(reviewNarrowContent.do)).toBeVisible();
  expect(
    await checkComparison
      .locator(".cycle-check-comparison__grid")
      .evaluate((element) =>
        window.getComputedStyle(element).gridTemplateColumns.split(" "),
      ),
  ).toHaveLength(2);
  await saveFrame(page, "C — Check", reviewNarrowContent.check, "A");
  await page.getByRole("button", { name: "アクションを生成" }).click();
  const actionEditor = page.getByRole("textbox", { name: "A — Action" });
  await expect(actionEditor).not.toHaveValue("");
  const generatedAction = await actionEditor.inputValue();
  expect(generatedAction).not.toBe("");
  await saveFrame(page, "A — Action", reviewNarrowContent.action, "A");
  await page.getByRole("button", { name: "サイクルを完了" }).click();
  const completionDialog = page.getByRole("dialog", {
    name: "サイクルを完了する前に確認",
  });
  await expect(completionDialog).not.toHaveAttribute("aria-describedby");
  await expect(completionDialog.getByText("Goal v1 · Cycle 1")).toBeVisible();
  for (const content of [
    goalText,
    reviewNarrowContent.plan,
    reviewNarrowContent.do,
    reviewNarrowContent.check,
    reviewNarrowContent.action,
  ])
    await expect(
      completionDialog.getByText(content, { exact: true }),
    ).toBeVisible();
  await expect(
    completionDialog.getByText(
      "完了後はP/D/C/Aを編集できません。目標の見直しへ進みます。",
    ),
  ).toBeVisible();
  await expect(
    completionDialog.getByRole("button", { name: /を編集$/ }),
  ).toHaveCount(4);
  expect(
    await completionDialog.evaluate(
      (element) => window.getComputedStyle(element).overflowY,
    ),
  ).toBe("auto");
  expect(
    await completionDialog
      .locator(".cycle-completion-summary")
      .evaluate((element) => window.getComputedStyle(element).overflowY),
  ).toBe("visible");

  await completionDialog.getByRole("button", { name: "Dを編集" }).click();
  const doEditor = page.getByRole("textbox", { name: "D — Do" });
  await expect(doEditor).toBeFocused();
  await expect(doEditor).toHaveValue(reviewNarrowContent.do);
  await page.getByRole("tab", { name: /A\s*Action/ }).click();
  await page.getByRole("button", { name: "サイクルを完了" }).click();
  await page
    .getByRole("dialog", { name: "サイクルを完了する前に確認" })
    .getByRole("button", { name: "サイクルを完了" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: goalText }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "この目標で次のサイクルへ" }),
  ).toBeVisible();
  await expect(
    page.getByText("Goal v1 · Cycle 1 を完了しました"),
  ).toBeVisible();
  await expectTextCounterAtNarrowWidths(
    page,
    "次のサイクルで目指す目標",
    Array.from(goalText).length,
    80,
  );
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("fukamu-cycle-selected-frame-v1:"),
      ),
    ),
  ).toEqual([]);

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
  await expectReviewSuggestionAtNarrowWidths(page, reviewNarrowContent);
  const reviewGoal = page.getByRole("textbox", {
    name: "次のサイクルで目指す目標",
  });
  await reviewGoal.fill(`${maximumGoal}😀`);
  await expect(reviewGoal).toHaveValue(goalText);
  await expect(
    page.getByText(
      "入力後は81文字になるため反映できませんでした。上限80文字まで、入力内容をあと1文字減らしてください。",
    ),
  ).toBeVisible();
  await saveText(page, reviewGoal, "一時的に変更した目標", "/review");
  await expect(page.getByText(/反映できませんでした/)).toHaveCount(0);
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
  await expect(
    page.getByRole("heading", { level: 1, name: goalText }),
  ).toBeFocused();
  await expect(page.getByText("Goal v1 · Cycle 2")).toBeVisible();
  await expect(page.getByRole("tab", { name: "P Plan" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goto("/history");
  await page
    .getByRole("link", { name: new RegExp(goalText.replace("\n", "\\s+")) })
    .click();
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

test("same-session tabs keep one CSRF token across concurrent discovery and reload", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "新しい目標を設定" }),
  ).toBeVisible();

  const concurrentTokens: string[] = [];
  let discoveryArrivals = 0;
  let releaseDiscoveries = () => undefined;
  const discoveriesMayContinue = new Promise<void>((resolve) => {
    releaseDiscoveries = resolve;
  });
  const sessionRoute = async (route: Route) => {
    const request = route.request();
    if (
      request.method() !== "GET" ||
      new URL(request.url()).pathname !== "/api/v1/session" ||
      discoveryArrivals >= 2
    ) {
      await route.continue();
      return;
    }
    discoveryArrivals += 1;
    if (discoveryArrivals === 2) releaseDiscoveries();
    await discoveriesMayContinue;
    const response = await route.fetch();
    const body = await response.body();
    concurrentTokens.push(
      (
        JSON.parse(body.toString()) as {
          readonly csrfToken: string;
        }
      ).csrfToken,
    );
    await route.fulfill({ response, body });
  };
  await context.route("**/api/v1/session", sessionRoute);

  const peer = await context.newPage();
  try {
    await Promise.all([page.reload(), peer.goto("/")]);
    await Promise.all([
      expect(
        page.getByRole("button", { name: "新しい目標を設定" }),
      ).toBeVisible(),
      expect(
        peer.getByRole("button", { name: "新しい目標を設定" }),
      ).toBeVisible(),
    ]);
    expect(concurrentTokens).toHaveLength(2);
    expect(
      concurrentTokens[0] === concurrentTokens[1],
      "concurrent Session discovery must return one stable CSRF token",
    ).toBe(true);
    await context.unroute("**/api/v1/session", sessionRoute);

    await page.reload();
    await expect(
      page.getByRole("button", { name: "新しい目標を設定" }),
    ).toBeVisible();

    const createResponse = peer.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/goal-drafts",
    );
    await peer.getByRole("button", { name: "新しい目標を設定" }).click();
    expect((await createResponse).status()).toBe(201);
    await expect(peer).toHaveURL("/goals/new");

    await page.goto("/goals/new");
    await saveText(
      page,
      page.getByRole("textbox", { name: "あなたの目標" }),
      "再読込後も別タブから保存できる目標",
      "/api/v1/goal-drafts/",
    );
  } finally {
    await context.unroute("**/api/v1/session", sessionRoute);
    await peer.close();
  }
});

test("a failed Settings route chunk recovers through a full-page retry", async ({
  page,
}) => {
  const settingsChunkPath = /^\/assets\/SettingsPage-[^/]+\.js$/;
  let settingsChunkRequests = 0;
  page.on("request", (request) => {
    if (settingsChunkPath.test(new URL(request.url()).pathname)) {
      settingsChunkRequests += 1;
    }
  });

  await page.goto("/");
  await page.route(
    "**/assets/SettingsPage-*.js",
    (route) => route.abort("connectionfailed"),
    { times: 1 },
  );

  await page.goto("/settings");
  await expect(page.getByRole("alert")).toContainText(
    "予期しないエラーが発生しました",
  );
  expect(settingsChunkRequests).toBe(1);

  const reloaded = page.waitForEvent("domcontentloaded");
  await page.getByRole("button", { name: "再試行" }).click();
  await reloaded;

  await expect(page).toHaveURL("/settings");
  await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
  expect(settingsChunkRequests).toBe(2);
});

test("a failed Google Identity script recovers through an explicit in-page retry", async ({
  page,
}) => {
  const googleIdentityScriptURL = "https://accounts.google.com/gsi/client";
  const fakeGoogleButtonName = "テスト用Google Accountで続行";
  let scriptRequests = 0;
  await page.route(googleIdentityScriptURL, async (route) => {
    scriptRequests += 1;
    if (scriptRequests === 1) {
      await route.abort("connectionfailed");
      return;
    }
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        window.google = {
          accounts: {
            id: {
              initialize() {},
              renderButton(parent) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = "${fakeGoogleButtonName}";
                button.setAttribute("aria-label", "${fakeGoogleButtonName}");
                parent.replaceChildren(button);
              },
            },
          },
        };
      `,
    });
  });

  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Google認証を読み込めませんでした",
  );
  expect(scriptRequests).toBe(1);
  await expect(
    page.locator('script[data-fukamu-cycle-google-identity="true"]'),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Google認証を再読み込み" }).click();

  await expect(
    page.getByRole("button", { name: fakeGoogleButtonName }),
  ).toBeVisible();
  expect(scriptRequests).toBe(2);
  await expect(
    page.locator('script[data-fukamu-cycle-google-identity="true"]'),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Google認証を再読み込み" }),
  ).toHaveCount(0);
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
        await route.continue();
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
        await route.continue();
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

    await saveText(
      page,
      page.getByRole("textbox", { name: "あなたの目標" }),
      savedBody,
      `/api/v1/goal-drafts/${winnerDraft.draft.id}`,
    );

    let staleCreationRequests = 0;
    await stale.route("**/api/v1/goal-drafts", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      staleCreationRequests += 1;
      await route.continue();
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
  const browserDraftBodies = await readBrowserDraftBodies(page);
  expect(browserDraftBodies).toContain("失敗しても保持する目標");
  fail = false;
  await page.getByRole("button", { name: "再試行" }).click();
  await expect(page.getByText("保存済み")).toBeVisible();
  await page.reload();
  await expect(editor).toHaveValue("失敗しても保持する目標");
});

test("a hidden lifecycle checkpoint preserves an edit before either debounce", async ({
  context,
  page,
}) => {
  await page.goto("/");
  const createButton = page.getByRole("button", {
    name: "新しい目標を設定",
  });
  await expect(createButton).toBeVisible();
  const creation = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/v1/goal-drafts" &&
      candidate.status() === 201,
  );
  await createButton.click();
  const created = (await (await creation).json()) as {
    readonly draft: { readonly id: string; readonly revision: number };
  };
  const session = await getSession(page);
  await expect(page.getByText("保存済み")).toBeVisible();

  const clockStart = Date.parse("2026-09-06T00:00:00.000Z");
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 60_000);
  let patchAttempts = 0;
  await page.route("**/api/v1/goal-drafts/*", async (route) => {
    if (route.request().method() === "PATCH") {
      patchAttempts += 1;
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });

  const body = "バックグラウンド移行時に保持する目標 " + newUUIDv7();
  const subjectKey = `goal-draft:${created.draft.id}`;
  const recordKey = `${session.user.id}:${subjectKey}`;
  const editor = page.getByRole("textbox", { name: "あなたの目標" });
  await editor.fill(body);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, body);

  await expect
    .poll(() => readBrowserDraft(page, recordKey), { timeout: 5_000 })
    .toEqual({
      key: recordKey,
      userId: session.user.id,
      goalId: null,
      subjectKey,
      body,
      baseRevision: created.draft.revision,
      updatedAt: new Date(clockStart + 60_000).toISOString(),
    });
  expect(patchAttempts).toBe(0);

  await page.close({ runBeforeUnload: false });
  const restored = await context.newPage();
  let restoredPatchAttempts = 0;
  let restoredHomeRequested = false;
  restored.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/v1/home") {
      restoredHomeRequested = true;
    }
    if (
      request.method() === "PATCH" &&
      pathname === `/api/v1/goal-drafts/${created.draft.id}`
    ) {
      restoredPatchAttempts += 1;
    }
  });
  const restoredSession = restored.waitForResponse(
    (candidate) =>
      candidate.request().method() === "GET" &&
      new URL(candidate.url()).pathname === "/api/v1/session" &&
      candidate.status() === 200,
  );
  const restoredHome = restored.waitForResponse(
    (candidate) =>
      candidate.request().method() === "GET" &&
      new URL(candidate.url()).pathname === "/api/v1/home" &&
      candidate.status() === 200,
  );
  await restored.goto("/goals/new");
  await restoredSession;
  const bootstrapClockStepMs = 10;
  const maxBootstrapClockSteps = 50;
  for (
    let attempt = 0;
    attempt < maxBootstrapClockSteps && !restoredHomeRequested;
    attempt += 1
  ) {
    await context.clock.runFor(bootstrapClockStepMs);
  }
  expect(restoredHomeRequested).toBe(true);
  await restoredHome;
  const restoredEditor = restored.getByRole("textbox", {
    name: "あなたの目標",
  });
  let recovered = false;
  const maxRecoveryClockSteps = 10;
  for (
    let attempt = 0;
    attempt < maxRecoveryClockSteps && !recovered;
    attempt += 1
  ) {
    // At most 100ms passes after the editor can mount, below both debounces.
    await context.clock.runFor(bootstrapClockStepMs);
    recovered =
      (await restoredEditor.count()) === 1 &&
      (await restoredEditor.inputValue()) === body;
  }
  expect(recovered).toBe(true);
  await expect(restoredEditor).toHaveValue(body);
  await expect(restored.getByText("未保存", { exact: true })).toBeVisible();
  expect(restoredPatchAttempts).toBe(0);

  const recoveredSave = restored.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      new URL(candidate.url()).pathname ===
        `/api/v1/goal-drafts/${created.draft.id}` &&
      candidate.status() === 200,
  );
  await context.clock.runFor(800);
  const saved = await recoveredSave;
  expect(saved.request().postDataJSON()).toEqual({
    body,
    expectedRevision: created.draft.revision,
  });
  expect(saved.status()).toBe(200);
  await expect(restored.getByText("保存済み")).toBeVisible();
  await expect
    .poll(() => readBrowserDraft(restored, recordKey), { timeout: 5_000 })
    .toBeNull();
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
  await expectHomeGoalCountAtNarrowWidths(page, 2, 2);
  await expect(
    page.getByRole("article", { name: new RegExp(firstGoal) }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: new RegExp(secondGoal) }),
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

test("Home presents one clear next action for an active Cycle without horizontal overflow", async ({
  page,
}) => {
  const goalText = "長い目標".repeat(20);
  await page.setViewportSize({ width: 320, height: 844 });
  await createProgressingGoal(page, goalText);
  const cyclePath = new URL(page.url()).pathname;
  const doTab = page.getByRole("tab", { name: "D Do" });
  await doTab.click();
  await expect(doTab).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(doTab).toHaveAttribute("aria-selected", "true");

  await page.goto("/");

  const card = page.getByRole("article", { name: goalText });
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("heading", { level: 3, name: goalText }),
  ).toBeVisible();
  await expect(card.getByText("Cycle 1 実行中")).toBeVisible();
  await expect(card.getByText("P/D/C/Aの記録を続けましょう。")).toBeVisible();
  await expect(card.locator("a, button, input, select, textarea")).toHaveCount(
    1,
  );
  const nextAction = card.getByRole("link", { name: "Cycle 1を続ける" });
  await expect(nextAction).toHaveAttribute("href", cyclePath);
  expect((await nextAction.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await nextAction.click();
  await expect(page).toHaveURL(cyclePath);
  await expect(doTab).toHaveAttribute("aria-selected", "true");

  await page.goBack();
  await expect(page.getByRole("article", { name: goalText })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(cyclePath);
  await expect(doTab).toHaveAttribute("aria-selected", "true");

  await page.getByRole("link", { name: "FUKAMU Cycle ホーム" }).click();
  const resetCard = page.getByRole("article", { name: goalText });
  await resetCard.getByRole("link", { name: "Cycle 1を続ける" }).click();
  await expect(page.getByRole("tab", { name: "P Plan" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Goal disabled guidance remains readable and associated at narrow widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "新しい目標を設定" }).click();

  await expectActionGuidanceAtNarrowWidths(
    page,
    "空白以外の文字を含む80文字以内の目標を入力してください。",
    ["AIで目標を整える", "この目標で始める"],
  );

  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await page.setViewportSize({ width: 1280, height: 844 });
  await saveText(
    page,
    page.getByRole("textbox", { name: "あなたの目標" }),
    "狭い画面でも案内を読みながら改善を続ける",
    "/api/v1/goal-drafts/",
  );
  await page.getByRole("button", { name: "この目標で始める" }).click();
  await completeCurrentCycle(page, "狭幅案内");

  await saveText(
    page,
    page.getByRole("textbox", {
      name: "次のサイクルで目指す目標",
    }),
    " \n\u3000",
    "/review",
  );
  await expectActionGuidanceAtNarrowWidths(
    page,
    "空白以外の文字を含む80文字以内で、次のサイクルの目標を入力してください。",
    ["AIで目標を整える", "この目標で次のサイクルへ"],
  );
});

test("Active Cycle Goal guidance stays nearby and usable at narrow widths", async ({
  page,
}) => {
  await createProgressingGoal(page, "保存状態から次の操作を判断できる目標");

  let releaseSave!: () => void;
  const saveRelease = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  let firstSave = true;
  await page.route("**/api/v1/goals/*/cycles/*/frames/plan", async (route) => {
    if (route.request().method() === "PATCH" && firstSave) {
      firstSave = false;
      markSaveStarted();
      await saveRelease;
    }
    await route.continue();
  });

  const plan = page.getByRole("textbox", { name: "P — Plan" });
  await plan.fill("保存完了を待つ計画");
  await plan.blur();
  await saveStarted;
  await page.getByText("目標の操作").click();

  const goalActions = page.locator(".goal-actions");
  const guidance = goalActions.locator(".goal-actions__guidance");
  const achieve = goalActions.getByRole("button", {
    name: "目標を達成として終了",
  });
  const end = goalActions.getByRole("button", { name: "目標を終了" });
  const remove = goalActions.getByRole("button", { name: "目標を削除" });
  const assertLayout = async () => {
    await expect(guidance).toBeVisible();
    await expect(guidance).toHaveText(
      "目標を達成・終了するには、入力の保存完了をお待ちください。",
    );
    const guidanceId = await guidance.getAttribute("id");
    expect(guidanceId).toBeTruthy();
    await expect(achieve).toBeDisabled();
    await expect(end).toBeDisabled();
    await expect(achieve).toHaveAttribute("aria-describedby", guidanceId ?? "");
    await expect(end).toHaveAttribute("aria-describedby", guidanceId ?? "");
    await expect(remove).toBeEnabled();
    await expect(remove).not.toHaveAttribute("aria-describedby");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  };

  await page.setViewportSize({ width: 320, height: 844 });
  await assertLayout();

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await assertLayout();

  expect(
    await goalActions.evaluate((element) => {
      const nodes = [
        element.querySelector("summary"),
        element.querySelector(".goal-actions__guidance"),
        ...element.querySelectorAll("button"),
      ];
      return nodes.slice(0, -1).every((node, index) => {
        const following = nodes[index + 1];
        return Boolean(
          node &&
          following &&
          node.compareDocumentPosition(following) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
      });
    }),
  ).toBe(true);

  const summary = goalActions.locator("summary");
  await summary.focus();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();

  releaseSave();
  await expect(page.getByText("保存済み")).toBeVisible();
  await expect(guidance).toHaveText("");
  await expect(achieve).toBeEnabled();
  await expect(end).toBeEnabled();
  await expect(remove).toBeEnabled();

  await summary.focus();
  await page.keyboard.press("Tab");
  await expect(achieve).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(end).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
});

test("an empty Cycle canceled with its Goal shows every terminal frame as unentered", async ({
  page,
}) => {
  const goalText = "空のCanceled Cycleを確認する目標";
  await createProgressingGoal(page, goalText);

  const activePlan = page.getByRole("textbox", { name: "P — Plan" });
  await expect(activePlan).toHaveValue("");
  await expect(activePlan).toHaveAttribute(
    "placeholder",
    frameCopy.plan.placeholder,
  );
  await expect(
    page.getByText(cycleFrameCopy.terminalEmpty, { exact: true }),
  ).toHaveCount(0);

  await page.getByText("目標の操作").click();
  await page.getByRole("button", { name: "目標を終了" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "目標を終了" })
    .click();
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();

  await page.getByRole("button", { name: "メニューを開く" }).click();
  await page.getByRole("link", { name: "目標の履歴" }).click();
  await page.getByRole("link", { name: new RegExp(goalText) }).click();
  await page.getByRole("link", { name: /Cycle 1/ }).click();
  await expect(page.getByText("読み取り専用")).toBeVisible();

  const frames = [
    { tab: "P Plan", textbox: "P — Plan" },
    { tab: "D Do", textbox: "D — Do" },
    { tab: "C Check", textbox: "C — Check" },
    { tab: "A Action", textbox: "A — Action" },
  ] as const;
  const assertTerminalLayout = async () => {
    for (const { tab, textbox } of frames) {
      const frameTab = page.getByRole("tab", { name: tab });
      await frameTab.click();
      await expect(frameTab).toBeFocused();
      const editor = page.getByRole("textbox", { name: textbox });
      await expect(editor).toHaveValue("");
      await expect(editor).toHaveAttribute("readonly", "");
      await expect(editor).toHaveAttribute("aria-readonly", "true");
      await expect(editor).not.toHaveAttribute("placeholder");
      const empty = page.getByText(cycleFrameCopy.terminalEmpty, {
        exact: true,
      });
      await expect(empty).toBeVisible();
      const emptyId = await empty.getAttribute("id");
      expect(emptyId).toBeTruthy();
      const describedBy =
        (await editor.getAttribute("aria-describedby"))?.split(/\s+/) ?? [];
      expect(describedBy).toContain("cycle-frame-guide");
      expect(describedBy).toContain(emptyId);
      expect(
        await page.evaluate(
          ({ tabName, textboxName, emptyElementId }) => {
            const tabElement = document.querySelector<HTMLElement>(
              `[role="tab"][aria-label="${tabName}"]`,
            );
            const editorElement = document.querySelector<HTMLElement>(
              `textarea[aria-label="${textboxName}"]`,
            );
            const emptyElement = document.getElementById(emptyElementId);
            return Boolean(
              tabElement &&
              editorElement &&
              emptyElement &&
              tabElement.compareDocumentPosition(editorElement) &
                Node.DOCUMENT_POSITION_FOLLOWING &&
              editorElement.compareDocumentPosition(emptyElement) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            );
          },
          { tabName: tab, textboxName: textbox, emptyElementId: emptyId ?? "" },
        ),
      ).toBe(true);
      await page.keyboard.press("Tab");
      await expect(editor).toBeFocused();
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);
  };

  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await assertTerminalLayout();

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await assertTerminalLayout();
});

test("mobile long content stays in bounds and frame tabs support keyboard navigation", async ({
  page,
}) => {
  const goalText = "長い目標".repeat(20);
  await page.setViewportSize({ width: 320, height: 844 });
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
  const planTemplate = cycleFrameTemplateCopy.templates.plan[0];
  const templatePicker = page.getByRole("region", {
    name: cycleFrameTemplateCopy.heading,
  });
  await expect(templatePicker).toBeVisible();
  const templateToggle = templatePicker.getByRole("button", {
    name: cycleFrameTemplateCopy.toggle,
  });
  await expect(templateToggle).toHaveAttribute("aria-expanded", "false");
  expect((await templateToggle.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  );
  await expect(
    templatePicker.locator(".frame-template__preview p").nth(0),
  ).toBeHidden();

  await templateToggle.focus();
  await page.keyboard.press("Enter");
  await expect(templateToggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    templatePicker.locator(".frame-template__preview p").nth(0),
  ).toHaveText(planTemplate.content);
  const templateInsert = templatePicker.getByRole("button", {
    name: cycleFrameTemplateCopy.insert(planTemplate.name),
  });
  expect((await templateInsert.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  );
  const templateSave = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate.url().endsWith("/frames/plan") &&
      candidate.ok(),
  );
  await templateInsert.click();
  const planEditor = page.getByRole("textbox", { name: "P — Plan" });
  await expect(planEditor).toHaveValue(planTemplate.content);
  await expect(planEditor).toBeFocused();
  expect(
    await planEditor.evaluate((element) => {
      const editor = element as HTMLTextAreaElement;
      return (
        editor.selectionStart === editor.value.length &&
        editor.selectionEnd === editor.value.length
      );
    }),
  ).toBe(true);
  await templateSave;
  const undoSave = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      candidate.url().endsWith("/frames/plan") &&
      candidate.ok(),
  );
  await page.getByRole("button", { name: cycleFrameTemplateCopy.undo }).click();
  await expect(planEditor).toHaveValue("");
  await undoSave;
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );
  await expect(templatePicker).toBeVisible();
  await expect(
    templatePicker.locator(".frame-template__preview p").nth(0),
  ).toHaveCSS("white-space", "pre-wrap");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("zoom"),
  );
  await page.setViewportSize({ width: 320, height: 844 });

  const doTab = page.getByRole("tab", { name: /^D/ });
  const nextDo = page.getByRole("button", { name: "D — Doへ進む" });
  await expect(nextDo).toBeVisible();
  expect((await nextDo.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(
    await nextDo.evaluate((element) => ({
      followsEditorMeta:
        element.parentElement?.previousElementSibling?.classList.contains(
          "editor-meta",
        ),
      position: window.getComputedStyle(element).position,
    })),
  ).toEqual({ followsEditorMeta: true, position: "static" });
  await nextDo.focus();
  await page.keyboard.press("Enter");
  await expect(doTab).toBeFocused();
  await expect(doTab).toHaveAttribute("aria-selected", "true");
  await expect(templateToggle).toHaveAttribute("aria-expanded", "false");
  await expect(
    templatePicker.locator(".frame-template__preview p").nth(0),
  ).toBeHidden();
  await page.keyboard.press("ArrowRight");
  const checkTab = page.getByRole("tab", { name: /^C/ });
  await expect(checkTab).toBeFocused();
  await expect(checkTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(doTab).toBeFocused();
  await expect(doTab).toHaveAttribute("aria-selected", "true");

  const quickEntry = page.getByRole("button", { name: "今の実行を記録" });
  await expect(quickEntry).toBeVisible();
  await expect(
    page.getByText(
      "この端末の現在時刻をDに追加します。サーバーの基準時刻ではありません。",
    ),
  ).toBeVisible();
  expect((await quickEntry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await quickEntry.click();
  const quickEntryEditor = page.getByRole("textbox", { name: "D — Do" });
  await expect(quickEntryEditor).toHaveValue(
    /^【\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} UTC[+-]\d{2}:\d{2}】\n$/,
  );
  await expect(quickEntryEditor).toBeFocused();
  expect(
    await quickEntryEditor.evaluate((element) => {
      const editor = element as HTMLTextAreaElement;
      return (
        editor.selectionStart === editor.value.length &&
        editor.selectionEnd === editor.value.length
      );
    }),
  ).toBe(true);
  await page.getByRole("button", { name: "日時の追加を取り消す" }).click();
  await expect(quickEntryEditor).toHaveValue("");
  await expect(page.getByText("保存済み")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  await saveFrame(page, "D — Do", "実行".repeat(100), "P");
  await saveFrame(page, "P — Plan", "計画".repeat(100), "C");
  const comparison = page.getByRole("region", {
    name: "今回のPとDを比べる",
  });
  await expect(comparison).toBeVisible();
  await expect(page.getByRole("textbox", { name: "C — Check" })).toBeVisible();
  const comparisonLayout = await comparison.evaluate((element) => {
    const grid = element.querySelector<HTMLElement>(
      ".cycle-check-comparison__grid",
    );
    const items = Array.from(
      element.querySelectorAll<HTMLElement>(".cycle-check-comparison__item"),
    );
    const hasNestedScroll = [element, ...element.querySelectorAll("*")].some(
      (candidate) => {
        const style = window.getComputedStyle(candidate);
        const canScroll = [style.overflowX, style.overflowY].some((overflow) =>
          ["auto", "scroll"].includes(overflow),
        );
        return (
          canScroll &&
          (candidate.scrollWidth > candidate.clientWidth ||
            candidate.scrollHeight > candidate.clientHeight)
        );
      },
    );
    return {
      columns: grid
        ? window.getComputedStyle(grid).gridTemplateColumns.split(" ").length
        : 0,
      hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      hasNestedScroll,
      itemTops: items.map((item) => item.getBoundingClientRect().top),
    };
  });
  expect(comparisonLayout).toMatchObject({
    columns: 1,
    hasHorizontalOverflow: false,
    hasNestedScroll: false,
  });
  expect(comparisonLayout.itemTops[1]).toBeGreaterThan(
    comparisonLayout.itemTops[0] ?? 0,
  );
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);

  const session = await getSession(page);
  const pathParts = new URL(page.url()).pathname.split("/");
  const goalId = pathParts[2];
  const cycleId = pathParts[4];
  expect(goalId).toBeTruthy();
  expect(cycleId).toBeTruthy();
  const subjectKey = `cycle:${cycleId}:do`;
  await writeBrowserDraft(page, {
    key: `${session.user.id}:${subjectKey}`,
    userId: session.user.id,
    goalId: goalId ?? null,
    subjectKey,
    body: "この端末に残った確認待ちの長い実行内容".repeat(12),
    baseRevision: 0,
    updatedAt: new Date().toISOString(),
  });
  await page.reload();

  await page.setViewportSize({ width: 640, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("zoom", "2"),
  );

  const frameTabs = page.getByRole("tablist", { name: "PDCAフレーム" });
  const recoveryTab = page.getByRole("tab", { name: "D Do 要確認" });
  await expect(page.getByRole("heading", { name: goalText })).toBeVisible();
  await expect(frameTabs).toBeVisible();
  await expect(recoveryTab).toHaveAttribute("aria-selected", "false");
  await expect(recoveryTab.getByText("要確認", { exact: true })).toBeVisible();

  const actionTab = page.getByRole("tab", { name: "A Action" });
  const nextAction = page.getByRole("button", { name: "A — Actionへ進む" });
  await expect(nextAction).toBeVisible();
  expect((await nextAction.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await nextAction.click();
  await expect(actionTab).toBeFocused();
  await expect(actionTab).toHaveAttribute("aria-selected", "true");
  const actionEditor = page.getByRole("textbox", { name: "A — Action" });
  const completeButton = page.getByRole("button", { name: "サイクルを完了" });
  for (const control of [actionEditor, completeButton]) {
    await control.scrollIntoViewIfNeeded();
    await control.evaluate((element) => {
      const tabs = document.querySelector<HTMLElement>(".frame-tabs");
      if (!tabs) throw new Error("frame tabs are missing");
      const overlap =
        element.getBoundingClientRect().bottom -
        tabs.getBoundingClientRect().top;
      if (overlap > 0) window.scrollBy(0, overlap);
    });
    const geometry = await control.evaluate((element) => {
      const controlRect = element.getBoundingClientRect();
      const tabs = document.querySelector<HTMLElement>(".frame-tabs");
      if (!tabs) throw new Error("frame tabs are missing");
      const tabRect = tabs.getBoundingClientRect();
      return {
        top: controlRect.top,
        bottom: controlRect.bottom,
        height: controlRect.height,
        tabTop: tabRect.top,
        viewportHeight: window.innerHeight,
      };
    });
    const diagnosis = `control geometry: ${JSON.stringify(geometry)}`;
    expect(geometry.height, diagnosis).toBeGreaterThan(0);
    expect(geometry.top, diagnosis).toBeGreaterThanOrEqual(-1);
    expect(geometry.bottom, diagnosis).toBeLessThanOrEqual(
      geometry.viewportHeight + 1,
    );
    expect(geometry.bottom, diagnosis).toBeLessThanOrEqual(geometry.tabTop + 1);
  }

  const mobileGeometry = await frameTabs.evaluate((element) => {
    const tabs = element as HTMLElement;
    const rect = tabs.getBoundingClientRect();
    const style = window.getComputedStyle(tabs);
    return {
      documentOverflows:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      position: style.position,
      bottom: style.bottom,
      paddingBottom: Number.parseFloat(style.paddingBottom),
      viewportBottom: window.innerHeight - rect.bottom,
    };
  });
  expect(mobileGeometry).toMatchObject({
    documentOverflows: false,
    position: "fixed",
    bottom: "0px",
  });
  expect(mobileGeometry.paddingBottom).toBeGreaterThanOrEqual(9);
  expect(Math.abs(mobileGeometry.viewportBottom)).toBeLessThanOrEqual(1);
});

test("goal review termination discards an unversioned change explicitly", async ({
  page,
}) => {
  await createAndCompleteGoal(page);
  const review = page.getByRole("textbox", {
    name: "次のサイクルで目指す目標",
  });
  await review.fill("次のCycleだけで試したかった変更案");
  const terminalSection = page.getByRole("region", {
    name: "この目標を終える",
  });
  await expect(terminalSection).toContainText(
    "変更中の目標案は破棄し、Goal v2は作成しません。現在のGoal v1のまま終了し、Cycle 2も開始しません。",
  );
  await expect(
    terminalSection.getByRole("button", { name: "目標を達成として終了" }),
  ).toHaveAccessibleDescription(/この目標はあとから再開できません/);
  await page.getByRole("button", { name: "目標を達成として終了" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "このReview下書きは、別のタブで保存された変更も含めて破棄され、Goal v2として保存されません",
  );
  await expect(dialog).toContainText(
    "現在のGoal v1のまま終了し、Cycle 2は開始されません",
  );
  await expect(dialog).toContainText(
    "目標を達成した状態として記録して、ここで取り組みを終えます",
  );
  await expect(dialog).toContainText(
    "どちらの操作も取り消せず、この目標はあとから再開できません",
  );
  await dialog.getByRole("button", { name: "目標を達成" }).click();
  await expect(page.getByText("まだ進行中の目標はありません。")).toBeVisible();
});

test("unchanged goal review warns that remote draft changes are discarded", async ({
  page,
}) => {
  await createAndCompleteGoal(page);
  await page.getByRole("button", { name: "目標を終了" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionは作成しません",
  );
  await expect(dialog).not.toContainText("Goal v2として保存されません");
  await expect(dialog).toContainText(
    "現在のGoal v1のまま終了し、Cycle 2は開始されません",
  );
  await expect(dialog).toContainText(
    "目標を達成したとはせず、ここで取り組みを終えます",
  );
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
