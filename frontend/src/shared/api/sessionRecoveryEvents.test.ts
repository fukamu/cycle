import { z } from "zod";

import {
  APIError,
  requestAuthenticatedJSON,
  requestCurrentSessionJSON,
  type AuthenticatedRequestLease,
} from "./client";
import {
  createSessionRecoveryEventBus,
  sessionRecoveryEvents,
  type SessionRecoveryReason,
  type SessionRecoverySubscription,
} from "./sessionRecoveryEvents";

const requestId = "00000000-0000-7000-8000-000000000001";
const expectedUserId = "00000000-0000-7000-8000-000000000002";
const otherUserId = "00000000-0000-7000-8000-000000000003";
const singletonSubscriptions: SessionRecoverySubscription[] = [];

const createLease = (
  isCurrent: () => boolean = () => true,
  signal: AbortSignal = new AbortController().signal,
): AuthenticatedRequestLease => ({ expectedUserId, isCurrent, signal });

const identityHeaders = (userId = expectedUserId) => ({
  "X-Fukamu-Authenticated-User-ID": userId,
});

afterEach(() => {
  for (const subscription of singletonSubscriptions.splice(0).reverse()) {
    subscription.unsubscribe();
  }
  vi.unstubAllGlobals();
});

const subscribeToSingleton = (
  listener: Parameters<typeof sessionRecoveryEvents.subscribe>[0],
) => singletonSubscriptions.push(sessionRecoveryEvents.subscribe(listener));

describe("session recovery event bus", () => {
  it("notifies only active subscribers and does not replay past events", () => {
    const bus = createSessionRecoveryEventBus();
    const first = vi.fn();
    const second = vi.fn();
    const firstSubscription = bus.subscribe(first);
    const firstPublisher = bus.capturePublisher();

    firstPublisher("SESSION_EXPIRED");
    firstSubscription.advanceGeneration();
    firstPublisher("CSRF_INVALID");
    firstSubscription.unsubscribe();
    const beforeSecondSubscription = bus.capturePublisher();
    const secondSubscription = bus.subscribe(second);
    beforeSecondSubscription("SESSION_EXPIRED");
    bus.capturePublisher()("CSRF_INVALID");

    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "SESSION_EXPIRED" }),
    );
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "CSRF_INVALID" }),
    );
    secondSubscription.unsubscribe();
  });

  it("removes listeners through the subscription cleanup", () => {
    const bus = createSessionRecoveryEventBus();
    const listener = vi.fn();
    const subscription = bus.subscribe(listener);
    const publisher = bus.capturePublisher();

    subscription.unsubscribe();
    publisher("SESSION_EXPIRED");

    expect(listener).not.toHaveBeenCalled();
  });

  it("reports subscriber failures asynchronously without skipping remaining subscribers", () => {
    const bus = createSessionRecoveryEventBus();
    const listener = vi.fn();
    const queuedReports: Array<() => void> = [];
    vi.stubGlobal(
      "queueMicrotask",
      vi.fn((report: () => void) => queuedReports.push(report)),
    );
    bus.subscribe(() => {
      throw new Error("observer failed");
    });
    bus.subscribe(listener);

    expect(() => bus.capturePublisher()("CSRF_INVALID")).not.toThrow();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "CSRF_INVALID" }),
    );
    expect(queuedReports).toHaveLength(1);
    expect(() => queuedReports[0]?.()).toThrow(
      "session recovery observer failed",
    );
  });
});

describe("authenticated request session recovery notifications", () => {
  it.each([
    [401, "SESSION_MISSING"],
    [401, "SESSION_EXPIRED"],
    [403, "CSRF_INVALID"],
  ] as const)(
    "publishes %s %s before rejecting the original request",
    async (status, code) => {
      const reasons: SessionRecoveryReason[] = [];
      subscribeToSingleton((event) => reasons.push(event.reason));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { error: { code, message: "technical message", requestId } },
            {
              status,
              headers: code === "CSRF_INVALID" ? identityHeaders() : {},
            },
          ),
        ),
      );

      await expect(
        requestAuthenticatedJSON(
          createLease(),
          "/api/v1/imperative-command",
          z.undefined(),
          {
            method: "POST",
            csrfToken: "stale-token",
          },
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<APIError>>({ status, code }),
      );
      expect(reasons).toEqual([code]);
    },
  );

  it("suppresses notifications for session requests managed by the boundary", async () => {
    const listener = vi.fn();
    subscribeToSingleton(listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "SESSION_EXPIRED",
              message: "technical message",
              requestId,
            },
          },
          { status: 401 },
        ),
      ),
    );

    await expect(requestCurrentSessionJSON(z.undefined())).rejects.toEqual(
      expect.objectContaining<Partial<APIError>>({
        status: 401,
        code: "SESSION_EXPIRED",
      }),
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not publish unrelated API errors", async () => {
    const listener = vi.fn();
    subscribeToSingleton(listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "validation failed",
              requestId,
            },
          },
          { status: 400, headers: identityHeaders() },
        ),
      ),
    );

    await expect(
      requestAuthenticatedJSON(
        createLease(),
        "/api/v1/imperative-command",
        z.undefined(),
      ),
    ).rejects.toBeInstanceOf(APIError);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    [403, "SESSION_MISSING"],
    [403, "SESSION_EXPIRED"],
    [500, "SESSION_MISSING"],
    [401, "CSRF_INVALID"],
  ] as const)(
    "does not publish when status %s and code %s do not match",
    async (status, code) => {
      const listener = vi.fn();
      subscribeToSingleton(listener);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { error: { code, message: "technical message", requestId } },
            { status, headers: identityHeaders() },
          ),
        ),
      );

      await expect(
        requestAuthenticatedJSON(
          createLease(),
          "/api/v1/imperative-command",
          z.undefined(),
        ),
      ).rejects.toBeInstanceOf(APIError);
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it.each([
    [200, otherUserId, "SESSION_IDENTITY_DRIFT"],
    [404, otherUserId, "SESSION_IDENTITY_DRIFT"],
    [401, otherUserId, "SESSION_IDENTITY_DRIFT"],
    [200, null, "SESSION_IDENTITY_UNVERIFIED"],
    [204, null, "SESSION_IDENTITY_UNVERIFIED"],
    [200, "malformed-user-id", "SESSION_IDENTITY_UNVERIFIED"],
    [204, "malformed-user-id", "SESSION_IDENTITY_UNVERIFIED"],
  ] as const)(
    "publishes %s binding failure for status %s",
    async (status, headerUserId, reason) => {
      const reasons: SessionRecoveryReason[] = [];
      subscribeToSingleton((event) => reasons.push(event.reason));
      const headers =
        headerUserId === null ? {} : identityHeaders(headerUserId);
      const payload =
        status >= 400
          ? {
              error: {
                code: status === 401 ? "SESSION_MISSING" : "NOT_FOUND",
                message: "technical message",
                requestId,
              },
            }
          : { ok: true };
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(status === 204 ? null : JSON.stringify(payload), {
            status,
            headers: {
              "Content-Type": "application/json",
              ...headers,
            },
          }),
        ),
      );

      await expect(
        requestAuthenticatedJSON(
          createLease(),
          "/api/v1/imperative-command",
          status === 204 ? z.undefined() : z.object({ ok: z.boolean() }),
        ),
      ).rejects.toMatchObject({ reason });
      expect(reasons).toEqual([reason]);
    },
  );

  it("publishes current-lease drift after the subscriber generation advances", async () => {
    const reasons: SessionRecoveryReason[] = [];
    const subscription = sessionRecoveryEvents.subscribe((event) => {
      reasons.push(event.reason);
    });
    singletonSubscriptions.push(subscription);
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
      createLease(),
      "/api/v1/imperative-command",
      z.undefined(),
    );
    subscription.advanceGeneration();
    resolveFetch?.(
      new Response(null, {
        status: 204,
        headers: identityHeaders(otherUserId),
      }),
    );

    await expect(pending).rejects.toMatchObject({
      reason: "SESSION_IDENTITY_DRIFT",
    });
    expect(reasons).toEqual(["SESSION_IDENTITY_DRIFT"]);
  });

  it("does not dispatch or publish for a lease stale before dispatch", async () => {
    const listener = vi.fn();
    subscribeToSingleton(listener);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestAuthenticatedJSON(
        createLease(() => false),
        "/api/v1/imperative-command",
        z.undefined(),
      ),
    ).rejects.toMatchObject({ reason: "SESSION_IDENTITY_STALE" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not publish an identity event when the lease expires in flight", async () => {
    const listener = vi.fn();
    subscribeToSingleton(listener);
    let current = true;
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
      createLease(() => current),
      "/api/v1/imperative-command",
      z.undefined(),
    );
    current = false;
    resolveFetch?.(new Response(null, { status: 204 }));

    await expect(pending).rejects.toMatchObject({
      reason: "SESSION_IDENTITY_STALE",
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes drift before reading a slow mismatched response body", async () => {
    const reasons: SessionRecoveryReason[] = [];
    subscribeToSingleton((event) => reasons.push(event.reason));
    const response = Response.json(
      { error: { code: "NOT_FOUND", message: "technical", requestId } },
      { status: 404, headers: identityHeaders(otherUserId) },
    );
    const parseBody = vi
      .spyOn(response, "json")
      .mockImplementation(() => new Promise<never>(() => undefined));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      requestAuthenticatedJSON(
        createLease(),
        "/api/v1/imperative-command",
        z.undefined(),
      ),
    ).rejects.toMatchObject({ reason: "SESSION_IDENTITY_DRIFT" });

    expect(parseBody).not.toHaveBeenCalled();
    expect(reasons).toEqual(["SESSION_IDENTITY_DRIFT"]);
  });

  it("does not publish an identity event when the lease expires during parsing", async () => {
    const listener = vi.fn();
    subscribeToSingleton(listener);
    let current = true;
    const response = Response.json(
      { error: { code: "NOT_FOUND", message: "technical", requestId } },
      { status: 404, headers: identityHeaders() },
    );
    vi.spyOn(response, "json").mockImplementation(async () => {
      current = false;
      return {
        error: { code: "NOT_FOUND", message: "technical", requestId },
      };
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      requestAuthenticatedJSON(
        createLease(() => current),
        "/api/v1/imperative-command",
        z.undefined(),
      ),
    ).rejects.toMatchObject({ reason: "SESSION_IDENTITY_STALE" });
    expect(listener).not.toHaveBeenCalled();
  });
});
