import { StagingCriticalFailure } from "../../scripts/lib/staging-critical.mjs";

const admissionButtonName = "\u5229\u7528\u3092\u958b\u59cb\u3059\u308b";
const newGoalButtonName = "\u65b0\u3057\u3044\u76ee\u6a19\u3092\u8a2d\u5b9a";

export async function enterStagingCritical({
  context,
  page,
  baseURL,
  admissionMode,
  inviteToken,
  captureAnonymousSession,
}) {
  if (admissionMode !== "off") {
    await context.addInitScript(installInviteFragment, inviteToken);
  }

  const sessionCapturePromise = Promise.resolve(
    captureAnonymousSession(page),
  ).then(
    (session) => session,
    () => undefined,
  );
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  const admissionButton = page.getByRole("button", {
    name: admissionButtonName,
  });
  const newGoalButton = page.getByRole("button", {
    name: newGoalButtonName,
  });
  try {
    await admissionButton.or(newGoalButton).first().waitFor({
      state: "visible",
    });
  } catch {
    throw new StagingCriticalFailure("entry", "entry_cta_timeout");
  }

  if (admissionMode !== "off") {
    await page.waitForFunction(
      () => !globalThis.location.hash.includes("beta-invite"),
    );
  }
  if (await admissionButton.isVisible()) {
    await admissionButton.click();
  }
  await newGoalButton.waitFor({ state: "visible" });
  return sessionCapturePromise;
}

function installInviteFragment(currentToken) {
  if (globalThis.location.pathname !== "/" || globalThis.location.hash !== "") {
    return;
  }
  const fragment = new globalThis.URLSearchParams();
  fragment.set("beta-invite", currentToken);
  globalThis.history.replaceState(
    globalThis.history.state,
    "",
    `${globalThis.location.pathname}${globalThis.location.search}#${fragment.toString()}`,
  );
}
