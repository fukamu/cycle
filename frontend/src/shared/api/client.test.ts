import { z } from "zod";

import {
  APIError,
  requestAnonymousSessionBootstrapJSON,
  requestAuthenticatedJSON,
  requestBetaAdmissionJSON,
  requestCurrentSessionJSON,
  type AuthenticatedRequestLease,
} from "./client";
import { NetworkError } from "./networkError";

afterEach(() => vi.unstubAllGlobals());

const responseSchema = z.object({ ok: z.boolean() });
const expectedUserId = "00000000-0000-7000-8000-000000000001";
const otherUserId = "00000000-0000-7000-8000-000000000002";

function createLease() {
  const controller = new AbortController();
  let current = true;
  const lease: AuthenticatedRequestLease = {
    expectedUserId,
    signal: controller.signal,
    isCurrent: () => current,
  };
  return {
    controller,
    expire: () => {
      current = false;
    },
    lease,
  };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  authenticatedUserId: string | null = expectedUserId,
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authenticatedUserId !== null) {
    headers.set("X-Fukamu-Authenticated-User-ID", authenticatedUserId);
  }
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers,
  });
}

describe("requestJSON transport failures", () => {
  it("brands a fetch rejection without retaining its potentially sensitive message", async () => {
    const cause = new TypeError("failed to fetch https://private-endpoint");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(cause));

    let failure: unknown;
    try {
      await requestBetaAdmissionJSON(responseSchema);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NetworkError);
    expect(failure).not.toBe(cause);
    expect(String(failure)).not.toContain("private-endpoint");
  });

  it("keeps an intentional abort distinct from a network failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("request aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(abort));

    let failure: unknown;
    try {
      await requestBetaAdmissionJSON(responseSchema, {
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: "AbortError" });
    expect(failure).not.toBeInstanceOf(NetworkError);
  });
});

describe("requestJSON API failures", () => {
  it("retains only the stable wire status, code, and request ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "INTERNAL_ERROR",
              message: "provider token=server-secret-value",
              requestId: "00000000-0000-7000-8000-000000000001",
              details: {
                sql: "select * from private_table",
                providerBody: "private provider response",
              },
            },
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    let failure: unknown;
    try {
      await requestBetaAdmissionJSON(responseSchema);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(APIError);
    if (!(failure instanceof APIError)) throw new Error("expected APIError");
    expect(failure).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      requestId: "00000000-0000-7000-8000-000000000001",
      message: "API request failed",
    });
    expect(Object.hasOwn(failure, "details")).toBe(false);
    const observableFailure = [
      String(failure),
      JSON.stringify(failure),
      failure.stack ?? "",
    ].join("\n");
    expect(observableFailure).not.toContain("server-secret-value");
    expect(observableFailure).not.toContain("private_table");
    expect(observableFailure).not.toContain("private provider response");
  });

  it("maps an unknown wire code to a safe invalid-response error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "PRIVATE_PROVIDER_FAILURE",
              message: "provider token=unknown-code-secret",
              requestId: "00000000-0000-7000-8000-000000000002",
              details: { providerBody: "unknown private response" },
            },
          }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    let failure: unknown;
    try {
      await requestBetaAdmissionJSON(responseSchema);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(APIError);
    if (!(failure instanceof APIError)) throw new Error("expected APIError");
    expect(failure).toMatchObject({
      status: 502,
      code: "INVALID_ERROR_RESPONSE",
      requestId: "unknown",
      message: "API request failed",
    });
    const observableFailure = [String(failure), JSON.stringify(failure)].join(
      "\n",
    );
    expect(observableFailure).not.toContain("PRIVATE_PROVIDER_FAILURE");
    expect(observableFailure).not.toContain("unknown-code-secret");
    expect(observableFailure).not.toContain("unknown private response");
  });
});

it("exports only endpoint-specific credentialed transports", async () => {
  const clientModule = await import("./client");
  expect(clientModule).not.toHaveProperty("requestJSON");
  expect(clientModule).not.toHaveProperty("requestAnonymousBootstrapJSON");
  expect(clientModule).not.toHaveProperty("requestPublicJSON");
  expect(clientModule).not.toHaveProperty("requestSessionDiscoveryJSON");
  expect(clientModule).toHaveProperty("requestAnonymousSessionBootstrapJSON");
  expect(clientModule).toHaveProperty("requestBetaAdmissionJSON");
  expect(clientModule).toHaveProperty("requestCurrentSessionJSON");
});

describe("authenticated response identity binding", () => {
  it("returns a matching response and disables browser HTTP caching", async () => {
    const { lease } = createLease();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestAuthenticatedJSON(lease, "/api/v1/home", responseSchema),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "X-Fukamu-Expected-User-ID",
      ),
    ).toBe(expectedUserId);
  });

  it.each([200, 404])(
    "rejects a mismatched authenticated identity before exposing a %s payload",
    async (status) => {
      const { lease } = createLease();
      const payload =
        status === 200
          ? { ok: true }
          : {
              error: {
                code: "NOT_FOUND",
                message: "private body",
                requestId: expectedUserId,
              },
            };
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse(payload, status, otherUserId)),
      );

      await expect(
        requestAuthenticatedJSON(lease, "/api/v1/protected", responseSchema),
      ).rejects.toMatchObject({
        reason: "SESSION_IDENTITY_DRIFT",
        message: "Authenticated response identity verification failed",
      });
    },
  );

  it("does not retain identity values or response content in binding failures", async () => {
    const { lease } = createLease();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(
            { ok: true, privateContent: "private-response-marker" },
            200,
            otherUserId,
          ),
        ),
    );

    let failure: unknown;
    try {
      await requestAuthenticatedJSON(
        lease,
        "/api/v1/protected",
        responseSchema,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const observableFailure = [
      String(failure),
      JSON.stringify(failure),
      failure instanceof Error ? (failure.stack ?? "") : "",
    ].join("\n");
    expect(observableFailure).not.toContain(expectedUserId);
    expect(observableFailure).not.toContain(otherUserId);
    expect(observableFailure).not.toContain("private-response-marker");
  });

  it.each([
    [200, null],
    [204, null],
    [200, "not-a-canonical-user-id"],
    [204, "not-a-canonical-user-id"],
  ] as const)(
    "rejects an unverifiable identity header on %s",
    async (status, authenticatedUserId) => {
      const { lease } = createLease();
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            jsonResponse(
              status === 204 ? undefined : { ok: true },
              status,
              authenticatedUserId,
            ),
          ),
      );

      const schema = status === 204 ? z.undefined() : responseSchema;
      await expect(
        requestAuthenticatedJSON(lease, "/api/v1/protected", schema),
      ).rejects.toMatchObject({
        reason: "SESSION_IDENTITY_UNVERIFIED",
        message: "Authenticated response identity verification failed",
      });
    },
  );

  it.each(["SESSION_MISSING", "SESSION_EXPIRED"] as const)(
    "preserves an exact 401 %s response when its identity header is absent",
    async (code) => {
      const { lease } = createLease();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            {
              error: {
                code,
                message: "technical message",
                requestId: expectedUserId,
              },
            },
            401,
            null,
          ),
        ),
      );

      await expect(
        requestAuthenticatedJSON(lease, "/api/v1/protected", responseSchema),
      ).rejects.toMatchObject({ status: 401, code });
    },
  );

  it("rejects a stale lease before dispatch", async () => {
    const { expire, lease } = createLease();
    expire();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestAuthenticatedJSON(lease, "/api/v1/protected", responseSchema),
    ).rejects.toMatchObject({
      reason: "SESSION_IDENTITY_STALE",
      message: "Authenticated request lease is no longer current",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a lease that becomes stale while fetch is in flight", async () => {
    const { controller, expire, lease } = createLease();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const pending = requestAuthenticatedJSON(
      lease,
      "/api/v1/protected",
      responseSchema,
    );
    expire();
    controller.abort();
    resolveFetch?.(jsonResponse({ ok: true }));

    await expect(pending).rejects.toMatchObject({
      reason: "SESSION_IDENTITY_STALE",
    });
  });

  it("checks the lease again after parsing the response body", async () => {
    const { expire, lease } = createLease();
    const response = jsonResponse({ ok: true });
    vi.spyOn(response, "json").mockImplementation(async () => {
      expire();
      return { ok: true };
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      requestAuthenticatedJSON(lease, "/api/v1/protected", responseSchema),
    ).rejects.toMatchObject({ reason: "SESSION_IDENTITY_STALE" });
  });

  it("keeps a caller abort as AbortError when signals are composed", async () => {
    const { lease } = createLease();
    const caller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((_path, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("request aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );

    const pending = requestAuthenticatedJSON(
      lease,
      "/api/v1/protected",
      responseSchema,
      { signal: caller.signal },
    );
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps a caller abort during body parsing as AbortError", async () => {
    const { lease } = createLease();
    const caller = new AbortController();
    const response = jsonResponse({ ok: true });
    vi.spyOn(response, "json").mockImplementation(async () => {
      caller.abort();
      return { ok: true };
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      requestAuthenticatedJSON(lease, "/api/v1/protected", responseSchema, {
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("session and public transports", () => {
  const discoveredSessionSchema = z.object({
    user: z.object({ id: z.string() }),
    csrfToken: z.string(),
  });

  it("binds a discovered session body to a matching canonical header", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ user: { id: expectedUserId }, csrfToken: "csrf" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestCurrentSessionJSON(discoveredSessionSchema),
    ).resolves.toMatchObject({ user: { id: expectedUserId } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/session");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has(
        "X-Fukamu-Expected-User-ID",
      ),
    ).toBe(false);
  });

  it("rejects a discovery response whose header and body identities differ", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(
            { user: { id: otherUserId }, csrfToken: "csrf" },
            200,
            expectedUserId,
          ),
        ),
    );

    await expect(
      requestCurrentSessionJSON(discoveredSessionSchema),
    ).rejects.toMatchObject({
      reason: "SESSION_IDENTITY_DRIFT",
      message: "Authenticated response identity verification failed",
    });
  });

  it.each(["public", "anonymous"] as const)(
    "uses no-store for the %s transport",
    async (kind) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      const client =
        kind === "public"
          ? requestBetaAdmissionJSON
          : requestAnonymousSessionBootstrapJSON;
      await expect(client(responseSchema)).resolves.toEqual({
        ok: true,
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        kind === "public"
          ? "/api/__beta/admission/redeem"
          : "/api/v1/session/anonymous",
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        cache: "no-store",
        credentials: "same-origin",
      });
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has(
          "X-Fukamu-Expected-User-ID",
        ),
      ).toBe(false);
    },
  );
});
