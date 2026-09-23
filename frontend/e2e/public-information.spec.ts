import { expect, test, type Request } from "@playwright/test";

const sessionCookieName = "__Host-fukamu_cycle_session";

test("public information is readable at 320px without starting session or providers", async ({
  page,
}) => {
  const forbiddenRequests: string[] = [];
  const observeRequest = (request: Request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/") ||
      url.hostname === "accounts.google.com" ||
      url.hostname.endsWith(".google.com") ||
      url.hostname === "challenges.cloudflare.com" ||
      url.hostname.endsWith(".openai.com")
    ) {
      forbiddenRequests.push(
        `${request.method()} ${url.origin}${url.pathname}`,
      );
    }
  };
  page.on("request", observeRequest);
  await page.setViewportSize({ width: 320, height: 844 });

  await page.goto("/legal/privacy");
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "データの取扱いとお問い合わせ",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("FUKAMU Cycle isolated E2E fixture"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "公開問い合わせ窓口" }),
  ).toHaveAttribute("href", "https://support.example.test/cycle");
  await expect(
    page.getByRole("link", { name: "アプリを開く" }),
  ).toHaveAttribute("href", "/");
  await expect(page.getByRole("table")).toBeVisible();

  expect(forbiddenRequests).toEqual([]);
  expect(
    (await page.context().cookies()).filter(
      (cookie) => cookie.name === sessionCookieName,
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      return databases.some(
        (database) => database.name === "fukamu-cycle-bootstrap",
      );
    }),
  ).toBe(false);
  expect(
    await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    })),
  ).toEqual({ documentWidth: 320, viewportWidth: 320 });
});
