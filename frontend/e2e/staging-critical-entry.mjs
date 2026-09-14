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
  claimInitialSessionRetry,
  hasObservedAnonymousSessionRequest,
  retainAnonymousSessionForCleanup,
}) {
  if (admissionMode !== "off") {
    await context.addInitScript(installInviteFragment, inviteToken);
  }

  let sessionCaptureFailure;
  let sessionCaptureSettled = false;
  let capturedSession;
  const sessionCapturePromise = Promise.resolve(
    captureAnonymousSession(page),
  ).then(
    (session) => {
      sessionCaptureSettled = true;
      capturedSession = session;
      return session;
    },
    (failure) => {
      sessionCaptureSettled = true;
      if (failure instanceof StagingCriticalFailure) {
        sessionCaptureFailure = failure;
      }
      return undefined;
    },
  );
  const throwEntryFailure = async (reason) => {
    let requestObserved = false;
    try {
      requestObserved = hasObservedAnonymousSessionRequest?.() === true;
    } catch {
      requestObserved = false;
    }
    if (requestObserved && !sessionCaptureSettled) {
      await sessionCapturePromise;
    }
    if (sessionCaptureFailure !== undefined) {
      throw sessionCaptureFailure;
    }
    if (capturedSession !== undefined) {
      try {
        await retainAnonymousSessionForCleanup?.(capturedSession);
      } catch {
        // Cleanup retention is best effort; the closed entry failure remains.
      }
    }
    throw new StagingCriticalFailure("entry", reason);
  };
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  const admissionButton = page.getByRole("button", {
    name: admissionButtonName,
  });
  const newGoalButton = page.getByRole("button", {
    name: newGoalButtonName,
  });
  const initialSessionRetryBoundary = page.locator(
    '[data-initial-session-state="retryable"]',
  );
  const initialSessionRateLimitBoundary = page.locator(
    '[data-initial-session-state="rate-limited"]',
  );
  const applicationErrorBoundary = page.locator(
    '[data-application-error-boundary="true"]',
  );
  const retryButton = initialSessionRetryBoundary.getByRole("button", {
    name: "\u518d\u8a66\u884c",
    exact: true,
  });
  try {
    await admissionButton
      .or(newGoalButton)
      .or(initialSessionRetryBoundary)
      .or(initialSessionRateLimitBoundary)
      .or(applicationErrorBoundary)
      .first()
      .waitFor({ state: "visible" });
  } catch {
    await throwEntryFailure("entry_cta_timeout");
  }

  if (await initialSessionRateLimitBoundary.isVisible()) {
    await throwEntryFailure("anonymous_session_rate_limited");
  }
  if (await applicationErrorBoundary.isVisible()) {
    await throwEntryFailure("unexpected_entry_boundary");
  }

  let initialSessionRetryAttempted = false;
  if (await initialSessionRetryBoundary.isVisible()) {
    if (sessionCaptureFailure !== undefined) {
      throw sessionCaptureFailure;
    }
    let retryClaimed = false;
    try {
      retryClaimed = claimInitialSessionRetry?.() === true;
    } catch {
      retryClaimed = false;
    }
    if (!retryClaimed) {
      await throwEntryFailure("anonymous_session_request_not_observed");
    }
    initialSessionRetryAttempted = true;
    try {
      await retryButton.click();
      await initialSessionRetryBoundary.waitFor({ state: "hidden" });
      await admissionButton
        .or(newGoalButton)
        .or(initialSessionRetryBoundary)
        .or(initialSessionRateLimitBoundary)
        .or(applicationErrorBoundary)
        .first()
        .waitFor({ state: "visible" });
    } catch {
      await throwEntryFailure("initial_session_retry_exhausted");
    }
    if (sessionCaptureFailure !== undefined) {
      throw sessionCaptureFailure;
    }
    if (await initialSessionRateLimitBoundary.isVisible()) {
      await throwEntryFailure("anonymous_session_rate_limited");
    }
    if (await applicationErrorBoundary.isVisible()) {
      await throwEntryFailure("unexpected_entry_boundary");
    }
    if (await initialSessionRetryBoundary.isVisible()) {
      await throwEntryFailure("initial_session_retry_exhausted");
    }
  }

  const finishEntryTransition = async () => {
    if (admissionMode !== "off") {
      await page.waitForFunction(
        () => !globalThis.location.hash.includes("beta-invite"),
      );
    }
    if (await admissionButton.isVisible()) {
      await admissionButton.click();
    }
    await newGoalButton.waitFor({ state: "visible" });
  };
  if (initialSessionRetryAttempted) {
    try {
      await finishEntryTransition();
    } catch {
      await throwEntryFailure("initial_session_retry_exhausted");
    }
  } else {
    await finishEntryTransition();
  }
  const session = await sessionCapturePromise;
  if (sessionCaptureFailure !== undefined) {
    throw sessionCaptureFailure;
  }
  return session;
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
