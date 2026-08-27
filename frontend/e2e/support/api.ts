import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

export type SessionView = {
  readonly user: {
    readonly id: string;
    readonly googleConnected: boolean;
    readonly googleEmail: string | null;
  };
  readonly csrfToken: string;
};

type BrowserAPIRequest = {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly csrfToken?: string;
  readonly idempotencyKey?: string;
};

export type APIResult = {
  readonly status: number;
  readonly payload: unknown;
};

export async function requestFromPage(
  page: Page,
  request: BrowserAPIRequest,
): Promise<APIResult> {
  return page.evaluate(async (input) => {
    const headers = new Headers({ Accept: "application/json" });
    if (input.body !== undefined) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    if (input.csrfToken !== undefined) {
      headers.set("X-CSRF-Token", input.csrfToken);
    }
    if (input.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", input.idempotencyKey);
    }
    const response = await fetch(input.path, {
      method: input.method ?? "GET",
      credentials: "same-origin",
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    const text = await response.text();
    return {
      status: response.status,
      payload: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
  }, request);
}

export async function getSession(page: Page): Promise<SessionView> {
  const result = await requestFromPage(page, { path: "/api/v1/session" });
  expect(result.status).toBe(200);
  return result.payload as SessionView;
}

export async function expectAPIError(
  page: Page,
  request: BrowserAPIRequest,
  status: number,
  code: string,
): Promise<void> {
  const result = await requestFromPage(page, request);
  expect(result).toMatchObject({
    status,
    payload: { error: { code } },
  });
}

export async function postGoogle(
  page: Page,
  operation: "upgrade" | "login",
  subject: string,
): Promise<APIResult> {
  const session = await getSession(page);
  return requestFromPage(page, {
    path: `/api/v1/auth/google/${operation}`,
    method: "POST",
    csrfToken: session.csrfToken,
    body: { idToken: `test-google:${subject}` },
  });
}

export async function createAnonymousSession(
  request: APIRequestContext,
  origin: string,
  bootstrapId: string,
): Promise<{ readonly status: number; readonly session: SessionView }> {
  const response = await request.post("/api/v1/session/anonymous", {
    headers: { Origin: origin },
    data: { bootstrapId, turnstileToken: "" },
  });
  return {
    status: response.status(),
    session: (await response.json()) as SessionView,
  };
}

export async function expectAPIResponseError(
  response: APIResponse,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status()).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}
