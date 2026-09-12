import {
  expect,
  test,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";

import { firstUseGuideCopy } from "../src/shared/copy/ja";
import { saveText } from "./support/workspace";

type GuideStage = keyof typeof firstUseGuideCopy.stages;

type ObservedRequest = {
  readonly method: string;
  readonly pathname: string;
};

type GuideNetworkProbe = {
  readonly checkpoint: () => number;
  readonly requestsSince: (checkpoint: number) => readonly ObservedRequest[];
  readonly sessionGetCount: () => number;
  readonly beaconCount: () => number;
};

type SessionGetCheckpoint = {
  readonly requestCheckpoint: number;
  readonly sessionGetCount: number;
  readonly beaconCount: number;
  readonly response: Promise<Response>;
};

const frameDetails = {
  plan: {
    editor: "P — Plan",
    body: "朝の作業前に、その日に終える一つを決める",
    nextAction: "D — Doへ進む",
    nextStage: "do",
  },
  do: {
    editor: "D — Do",
    body: "作業前に一つを決め、午前中に取りかかった",
    nextAction: "C — Checkへ進む",
    nextStage: "check",
  },
  check: {
    editor: "C — Check",
    body: "最初の一つを決めると、迷わず始められた",
    nextAction: "A — Actionへ進む",
    nextStage: "action",
  },
  action: {
    editor: "A — Action",
    body: "明日も最初の一つを決め、開始時刻も記録する",
  },
} as const;

function guide(page: Page): Locator {
  return page.getByRole("complementary", {
    name: firstUseGuideCopy.heading,
  });
}

async function installGuideNetworkProbe(
  page: Page,
): Promise<GuideNetworkProbe> {
  const requests: ObservedRequest[] = [];
  let beaconCount = 0;

  await page.exposeFunction("__recordFirstUseGuideBeacon", () => {
    beaconCount += 1;
  });
  await page.addInitScript(() => {
    const original = navigator.sendBeacon?.bind(navigator);
    if (!original) return;
    navigator.sendBeacon = (
      ...args: Parameters<typeof navigator.sendBeacon>
    ) => {
      const record = (
        window as typeof window & {
          __recordFirstUseGuideBeacon?: () => Promise<void>;
        }
      ).__recordFirstUseGuideBeacon;
      void record?.();
      return original(...args);
    };
  });
  page.on("request", (request) => {
    requests.push({
      method: request.method(),
      pathname: new URL(request.url()).pathname,
    });
  });

  return {
    checkpoint: () => requests.length,
    requestsSince: (checkpoint) => requests.slice(checkpoint),
    sessionGetCount: () =>
      requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === "/api/v1/session",
      ).length,
    beaconCount: () => beaconCount,
  };
}

function startSessionGetCheckpoint(
  page: Page,
  network: GuideNetworkProbe,
): SessionGetCheckpoint {
  return {
    requestCheckpoint: network.checkpoint(),
    sessionGetCount: network.sessionGetCount(),
    beaconCount: network.beaconCount(),
    response: page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/v1/session",
    ),
  };
}

async function settleGuideEffects(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function finishGuideSessionGet(
  page: Page,
  network: GuideNetworkProbe,
  checkpoint: SessionGetCheckpoint,
): Promise<void> {
  const response = await checkpoint.response;
  expect(response.ok()).toBe(true);
  await settleGuideEffects(page);
  expect(network.sessionGetCount()).toBe(checkpoint.sessionGetCount + 1);
  expect(network.beaconCount()).toBe(checkpoint.beaconCount);
}

async function expectNoGuideNetwork(
  page: Page,
  network: GuideNetworkProbe,
  action: () => Promise<void>,
): Promise<void> {
  const checkpoint = network.checkpoint();
  const beaconCount = network.beaconCount();
  await action();
  await settleGuideEffects(page);
  expect(network.requestsSince(checkpoint)).toEqual([]);
  expect(network.beaconCount()).toBe(beaconCount);
}

async function expectOnlyGuideSessionGet(
  page: Page,
  network: GuideNetworkProbe,
  action: () => Promise<void>,
): Promise<void> {
  const checkpoint = startSessionGetCheckpoint(page, network);
  await action();
  await finishGuideSessionGet(page, network, checkpoint);
  expect(network.requestsSince(checkpoint.requestCheckpoint)).toEqual([
    { method: "GET", pathname: "/api/v1/session" },
  ]);
}

async function reloadWithNormalSessionCheckpoint(
  page: Page,
  network: GuideNetworkProbe,
  ready: () => Promise<void>,
): Promise<void> {
  const checkpoint = startSessionGetCheckpoint(page, network);
  await page.reload();
  await ready();
  await finishGuideSessionGet(page, network, checkpoint);
}

async function readScrollPosition(page: Page) {
  return page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
}

async function moveToNonZeroScrollPosition(page: Page, height = 480) {
  await page.setViewportSize({ width: 1280, height });
  const position = await page.evaluate(() => {
    window.scrollTo(0, 80);
    return { x: window.scrollX, y: window.scrollY };
  });
  expect(position).toEqual({ x: 0, y: 80 });
}

async function expectGuideStage(page: Page, stage: GuideStage) {
  const currentGuide = guide(page);
  const copy = firstUseGuideCopy.stages[stage];

  await expect(currentGuide).toBeVisible();
  await expect(
    currentGuide.getByRole("heading", {
      level: 2,
      name: firstUseGuideCopy.heading,
    }),
  ).toBeVisible();
  await expect(
    currentGuide.getByText(copy.location, { exact: true }),
  ).toBeVisible();
  await expect(
    currentGuide.getByText(copy.guide, { exact: true }),
  ).toBeVisible();
  await expect(
    currentGuide.getByRole("button", { name: firstUseGuideCopy.close }),
  ).toBeEnabled();
  await expect(
    currentGuide.getByRole("button", { name: firstUseGuideCopy.skip }),
  ).toBeEnabled();
  await expect(currentGuide.getByRole("dialog")).toHaveCount(0);
}

async function closeGuideWithKeyboard(page: Page, scrollY?: number) {
  const close = guide(page).getByRole("button", {
    name: firstUseGuideCopy.close,
  });
  await close.focus();
  await expect(close).toBeFocused();
  if (scrollY !== undefined) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    expect(await readScrollPosition(page)).toEqual({ x: 0, y: scrollY });
  }
  const scrollPosition = await readScrollPosition(page);
  await page.keyboard.press("Enter");
  await expect(guide(page)).toHaveCount(0);
  expect(await readScrollPosition(page)).toEqual(scrollPosition);
}

async function replayGuideFromMenuWithKeyboard(
  page: Page,
  expectNonZeroScroll = false,
) {
  const menuButton = page.getByRole("button", { name: "メニューを開く" });
  await menuButton.click();

  await expect(page.getByRole("link", { name: "目標の履歴" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "設定" })).toBeFocused();
  await page.keyboard.press("Tab");

  const replay = page.getByRole("button", {
    name: firstUseGuideCopy.menuLabel,
  });
  await expect(replay).toBeFocused();
  if (expectNonZeroScroll) {
    await page.evaluate(() => window.scrollTo(0, 80));
    expect(await readScrollPosition(page)).toEqual({ x: 0, y: 80 });
  }
  const scrollPosition = await readScrollPosition(page);
  await page.keyboard.press("Enter");
  await expect(menuButton).toBeFocused();
  expect(await readScrollPosition(page)).toEqual(scrollPosition);
}

async function expectGuideAtNarrowWidths(page: Page) {
  const assertLayout = async () => {
    const metrics = await guide(page).evaluate((element) => {
      const style = window.getComputedStyle(element);
      const descendants = Array.from(
        element.querySelectorAll<HTMLElement>("*"),
      );
      const hasNestedScroll = [element, ...descendants].some((candidate) => {
        const candidateStyle = window.getComputedStyle(candidate);
        const canScroll = [
          candidateStyle.overflowX,
          candidateStyle.overflowY,
        ].some((overflow) => ["auto", "scroll"].includes(overflow));
        return (
          canScroll &&
          (candidate.scrollWidth > candidate.clientWidth ||
            candidate.scrollHeight > candidate.clientHeight)
        );
      });
      return {
        documentOverflows:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        guideOverflows: element.scrollWidth > element.clientWidth,
        hasNestedScroll,
        position: style.position,
        buttonHeights: descendants
          .filter((candidate) => candidate instanceof HTMLButtonElement)
          .map((button) => button.getBoundingClientRect().height),
      };
    });

    expect(metrics).toMatchObject({
      documentOverflows: false,
      guideOverflows: false,
      hasNestedScroll: false,
      position: "static",
    });
    expect(metrics.buttonHeights).toHaveLength(2);
    for (const height of metrics.buttonHeights)
      expect(height).toBeGreaterThanOrEqual(44);
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
  await page.setViewportSize({ width: 1280, height: 844 });
}

async function saveFrameAndAdvance(page: Page, stage: "plan" | "do" | "check") {
  const details = frameDetails[stage];
  const save = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/frames/${stage}`) &&
      response.ok(),
  );
  await page.getByRole("textbox", { name: details.editor }).fill(details.body);

  const next = page.getByRole("button", { name: details.nextAction });
  await next.focus();
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await save;

  const nextTab = page.getByRole("tab", {
    name: new RegExp(`^${details.nextStage[0]?.toUpperCase()}`),
  });
  await expect(nextTab).toBeFocused();
  await expect(nextTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("保存済み")).toBeVisible();
}

async function saveAction(page: Page) {
  const save = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith("/frames/action") &&
      response.ok(),
  );
  const editor = page.getByRole("textbox", {
    name: frameDetails.action.editor,
  });
  await editor.fill(frameDetails.action.body);
  await editor.blur();
  await save;
  await expect(page.getByText("保存済み")).toBeVisible();
}

function isAIRequest(url: string): boolean {
  const pathname = new URL(url).pathname;
  return /\/(?:refinements|actions\/(?:generate|refine))(?:\/|$)/.test(
    pathname,
  );
}

test("fresh anonymous user completes the first guided cycle without AI", async ({
  page,
}) => {
  const network = await installGuideNetworkProbe(page);
  const aiRequests: string[] = [];
  page.on("request", (request) => {
    if (isAIRequest(request.url())) aiRequests.push(request.url());
  });

  await page.goto("/");
  const newGoal = page.getByRole("button", { name: "新しい目標を設定" });
  await expect(newGoal).toBeVisible();
  const goalGuideSessionGet = startSessionGetCheckpoint(page, network);
  await newGoal.click();

  const goalText = "毎朝、迷わず大切な作業を始める";
  const goalEditor = page.getByRole("textbox", { name: "あなたの目標" });
  await expect(goalEditor).toHaveValue("");
  await expectGuideStage(page, "goal");
  await finishGuideSessionGet(page, network, goalGuideSessionGet);
  await expectGuideAtNarrowWidths(page);
  await expectNoGuideNetwork(page, network, () => closeGuideWithKeyboard(page));

  await saveText(page, goalEditor, goalText, "/api/v1/goal-drafts/");
  const planGuideSessionGet = startSessionGetCheckpoint(page, network);
  await page.getByRole("button", { name: "この目標で始める" }).click();

  const workspaceHeading = page.getByRole("heading", {
    level: 1,
    name: goalText,
  });
  await expect(workspaceHeading).toBeFocused();
  await expect(page.getByText("Goal v1 · Cycle 1")).toBeVisible();
  await expectGuideStage(page, "plan");
  await finishGuideSessionGet(page, network, planGuideSessionGet);
  await expectNoGuideNetwork(page, network, () => closeGuideWithKeyboard(page));

  await expectNoGuideNetwork(page, network, async () => {
    await replayGuideFromMenuWithKeyboard(page);
    await expectGuideStage(page, "plan");
  });
  await expectNoGuideNetwork(page, network, () => closeGuideWithKeyboard(page));
  await expectNoGuideNetwork(page, network, async () => {
    await replayGuideFromMenuWithKeyboard(page);
    await expectGuideStage(page, "plan");
  });
  await expectNoGuideNetwork(page, network, () => closeGuideWithKeyboard(page));
  await reloadWithNormalSessionCheckpoint(page, network, async () => {
    await expect(
      page.getByRole("textbox", { name: frameDetails.plan.editor }),
    ).toBeVisible();
  });
  await expect(guide(page)).toHaveCount(0);

  for (const stage of ["plan", "do", "check"] as const) {
    const nextGuideSessionGet = startSessionGetCheckpoint(page, network);
    await saveFrameAndAdvance(page, stage);
    await expectGuideStage(page, frameDetails[stage].nextStage);
    await finishGuideSessionGet(page, network, nextGuideSessionGet);
    await expectNoGuideNetwork(page, network, () =>
      closeGuideWithKeyboard(page),
    );
  }

  await saveAction(page);
  await page.getByRole("button", { name: "サイクルを完了" }).click();
  const reviewGuideSessionGet = startSessionGetCheckpoint(page, network);
  await page
    .getByRole("dialog", { name: "サイクルを完了する前に確認" })
    .getByRole("button", { name: "サイクルを完了" })
    .click();

  await expect(
    page.getByRole("heading", { level: 1, name: goalText }),
  ).toBeFocused();
  await expectGuideStage(page, "review");
  await finishGuideSessionGet(page, network, reviewGuideSessionGet);
  await expectNoGuideNetwork(page, network, () => closeGuideWithKeyboard(page));

  const continueReview = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/review/continue") &&
      response.ok(),
  );
  await page.getByRole("button", { name: "この目標で次のサイクルへ" }).click();
  await continueReview;

  await expect(
    page.getByRole("heading", { level: 1, name: goalText }),
  ).toBeFocused();
  await expect(page.getByText("Goal v1 · Cycle 2")).toBeVisible();
  await expect(page.getByRole("tab", { name: "P Plan" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(guide(page)).toHaveCount(0);

  await moveToNonZeroScrollPosition(page);
  await expectNoGuideNetwork(page, network, async () => {
    await replayGuideFromMenuWithKeyboard(page, true);
    await expectGuideStage(page, "plan");
  });
  await expectNoGuideNetwork(page, network, () =>
    closeGuideWithKeyboard(page, 80),
  );
  await reloadWithNormalSessionCheckpoint(page, network, async () => {
    await expect(page.getByText("Goal v1 · Cycle 2")).toBeVisible();
  });
  await expect(guide(page)).toHaveCount(0);
  expect(aiRequests).toEqual([]);
  expect(network.beaconCount()).toBe(0);
});

test("skip persists across reload while Help replay remains temporary", async ({
  page,
}) => {
  const network = await installGuideNetworkProbe(page);
  await page.goto("/");
  const newGoal = page.getByRole("button", { name: "新しい目標を設定" });
  await expect(newGoal).toBeVisible();
  const goalGuideSessionGet = startSessionGetCheckpoint(page, network);
  await newGoal.click();

  const editor = page.getByRole("textbox", { name: "あなたの目標" });
  await expectGuideStage(page, "goal");
  await finishGuideSessionGet(page, network, goalGuideSessionGet);

  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    )
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  const skip = guide(page).getByRole("button", {
    name: firstUseGuideCopy.skip,
  });
  await page.setViewportSize({ width: 1280, height: 240 });
  await skip.focus();
  await expect(skip).toBeFocused();
  await moveToNonZeroScrollPosition(page, 240);
  const scrollPosition = await readScrollPosition(page);
  await expectOnlyGuideSessionGet(page, network, async () => {
    await page.keyboard.press("Enter");
    await expect(guide(page)).toHaveCount(0);
  });
  expect(await readScrollPosition(page)).toEqual(scrollPosition);
  await expect(editor).toBeEditable();
  await expect(editor).toHaveValue("");

  await expectNoGuideNetwork(page, network, async () => {
    await replayGuideFromMenuWithKeyboard(page);
    await expectGuideStage(page, "goal");
  });
  await expectNoGuideNetwork(page, network, async () => {
    await guide(page)
      .getByRole("button", { name: firstUseGuideCopy.skip })
      .click();
    await expect(guide(page)).toHaveCount(0);
  });

  await expectNoGuideNetwork(page, network, async () => {
    await replayGuideFromMenuWithKeyboard(page);
    await expectGuideStage(page, "goal");
  });
  await expect(editor).toHaveValue("");
  await expectNoGuideNetwork(page, network, () =>
    closeGuideWithKeyboard(page, 0),
  );

  await reloadWithNormalSessionCheckpoint(page, network, async () => {
    await expect(editor).toBeEditable();
  });
  await expect(guide(page)).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(network.beaconCount()).toBe(0);
});
