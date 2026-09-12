import {
  clearBootstrapID,
  getOrCreateBootstrapID,
} from "./bootstrapRepository";
import {
  activateFirstUseGuide,
  firstUseGuideStages,
  markFirstUseGuideStageShown,
  readFirstUseGuidePreferences,
  skipFirstUseGuide,
} from "../../shared/preferences/firstUseGuidePreference";
import { createAnonymousSession, loadInitialSession } from "./sessionDiscovery";
import { getAnonymousBootstrapToken } from "./turnstile";

vi.mock("./bootstrapRepository", () => ({
  clearBootstrapID: vi.fn(),
  getOrCreateBootstrapID: vi.fn(),
}));

vi.mock("./turnstile", () => ({
  getAnonymousBootstrapToken: vi.fn(),
}));

const clearBootstrapIDMock = vi.mocked(clearBootstrapID);
const getOrCreateBootstrapIDMock = vi.mocked(getOrCreateBootstrapID);
const getAnonymousBootstrapTokenMock = vi.mocked(getAnonymousBootstrapToken);
const anonymousSession = {
  user: {
    id: "00000000-0000-7000-8000-000000000002",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "A".repeat(43),
};

describe("anonymous session discovery", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearBootstrapIDMock.mockReset();
    clearBootstrapIDMock.mockResolvedValue(undefined);
    getOrCreateBootstrapIDMock.mockReset();
    getAnonymousBootstrapTokenMock.mockReset();
    vi.stubGlobal("navigator", {
      locks: {
        request: vi.fn(
          (
            _name: string,
            _options: LockOptions,
            callback: LockGrantedCallback<unknown>,
          ) =>
            callback({ name: "test-session-cookie-writer", mode: "exclusive" }),
        ),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not acquire an external token after ownership is lost while reading the bootstrap ID", async () => {
    let resolveBootstrapID!: (bootstrapId: string) => void;
    getOrCreateBootstrapIDMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveBootstrapID = resolve;
      }),
    );
    let current = true;
    const discovery = createAnonymousSession(() => current);

    current = false;
    resolveBootstrapID("00000000-0000-7000-8000-000000000001");

    await expect(discovery).resolves.toBeNull();
    expect(getAnonymousBootstrapTokenMock).not.toHaveBeenCalled();
    expect(clearBootstrapIDMock).not.toHaveBeenCalled();
  });

  it("returns an outer-GET existing Session without changing any Guide boolean", async () => {
    activateFirstUseGuide();
    for (const stage of firstUseGuideStages) {
      markFirstUseGuideStageShown(stage);
    }
    skipFirstUseGuide();
    const beforeDiscovery = readFirstUseGuidePreferences();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const fetchMock = vi.fn(async () =>
      Response.json(anonymousSession, {
        headers: {
          "X-Fukamu-Authenticated-User-ID": anonymousSession.user.id,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadInitialSession(new AbortController().signal),
    ).resolves.toEqual(anonymousSession);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getOrCreateBootstrapIDMock).not.toHaveBeenCalled();
    expect(getAnonymousBootstrapTokenMock).not.toHaveBeenCalled();
    expect(clearBootstrapIDMock).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(readFirstUseGuidePreferences()).toEqual(beforeDiscovery);
  });

  it("does not infer Guide eligibility from missing keys after an outer-GET existing Session", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const fetchMock = vi.fn(async () =>
      Response.json(anonymousSession, {
        headers: {
          "X-Fukamu-Authenticated-User-ID": anonymousSession.user.id,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadInitialSession(new AbortController().signal),
    ).resolves.toEqual(anonymousSession);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getOrCreateBootstrapIDMock).not.toHaveBeenCalled();
    expect(getAnonymousBootstrapTokenMock).not.toHaveBeenCalled();
    expect(clearBootstrapIDMock).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(readFirstUseGuidePreferences()).toEqual({
      eligible: false,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
  });

  it("forwards the owner abort signal to the anonymous bootstrap request", async () => {
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    getAnonymousBootstrapTokenMock.mockResolvedValue("token");
    let observedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal;
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason ??
                  new DOMException("request aborted", "AbortError"),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const discovery = createAnonymousSession(
      () => !controller.signal.aborted,
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(observedSignal).toBe(controller.signal);

    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
    expect(clearBootstrapIDMock).not.toHaveBeenCalled();
  });

  it("waits for the exclusive cookie-writer lock before dispatching bootstrap", async () => {
    activateFirstUseGuide();
    markFirstUseGuideStageShown("goal");
    skipFirstUseGuide();
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    getAnonymousBootstrapTokenMock.mockResolvedValue("token");
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = typeof input === "string" ? input : input.toString();
        return path === "/api/v1/session" && (init?.method ?? "GET") === "GET"
          ? errorResponse(401, "SESSION_MISSING")
          : Response.json(anonymousSession);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    let grantLock!: () => void;
    const lockRequest = vi.fn(
      (
        _name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) =>
        new Promise<unknown>((resolve, reject) => {
          grantLock = () => {
            Promise.resolve(
              callback({
                name: "test-session-cookie-writer",
                mode: "exclusive",
              }),
            ).then(resolve, reject);
          };
          expect(options.mode).toBe("exclusive");
        }),
    );
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    const guidePreferencesReconciled = vi.fn();

    const discovery = createAnonymousSession(
      () => true,
      undefined,
      guidePreferencesReconciled,
    );

    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());
    expect(fetchMock).not.toHaveBeenCalled();

    grantLock();

    await expect(discovery).resolves.toEqual(anonymousSession);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readFirstUseGuidePreferences()).toEqual({
      eligible: true,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
    expect(guidePreferencesReconciled).toHaveBeenCalledOnce();
    expect(guidePreferencesReconciled).toHaveBeenCalledWith(
      "local-shared-safe",
      anonymousSession,
    );
    expect(clearBootstrapIDMock).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-000000000001",
    );
  });

  it("retains the bootstrap ID when ownership is lost while the bootstrap response is pending", async () => {
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    getAnonymousBootstrapTokenMock.mockResolvedValue("token");
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/api/v1/session")
        return Promise.resolve(errorResponse(401, "SESSION_MISSING"));
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    let current = true;
    const discovery = createAnonymousSession(() => current);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    current = false;
    resolveResponse(Response.json(anonymousSession));

    await expect(discovery).resolves.toBeNull();
    expect(clearBootstrapIDMock).not.toHaveBeenCalled();
  });

  it("does not return a session when ownership is lost during confirmed bootstrap cleanup", async () => {
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    getAnonymousBootstrapTokenMock.mockResolvedValue("token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        return path === "/api/v1/session"
          ? errorResponse(401, "SESSION_MISSING")
          : Response.json(anonymousSession);
      }),
    );
    let resolveCleanup!: () => void;
    clearBootstrapIDMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      }),
    );
    let current = true;
    const discovery = createAnonymousSession(() => current);
    await vi.waitFor(() => expect(clearBootstrapIDMock).toHaveBeenCalledOnce());
    expect(clearBootstrapIDMock).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-000000000001",
    );

    current = false;
    resolveCleanup();

    await expect(discovery).resolves.toBeNull();
  });

  it("reuses a session found inside the writer lock without changing guide state", async () => {
    activateFirstUseGuide();
    markFirstUseGuideStageShown("plan");
    skipFirstUseGuide();
    const beforeDiscovery = readFirstUseGuidePreferences();
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    const fetchMock = vi.fn(async () =>
      Response.json(anonymousSession, {
        headers: {
          "X-Fukamu-Authenticated-User-ID": anonymousSession.user.id,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const guidePreferencesReconciled = vi.fn();

    await expect(
      createAnonymousSession(() => true, undefined, guidePreferencesReconciled),
    ).resolves.toEqual(anonymousSession);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getAnonymousBootstrapTokenMock).not.toHaveBeenCalled();
    expect(guidePreferencesReconciled).toHaveBeenCalledOnce();
    expect(guidePreferencesReconciled).toHaveBeenCalledWith(
      "deferred",
      anonymousSession,
    );
    expect(readFirstUseGuidePreferences()).toEqual(beforeDiscovery);
  });

  it("preserves the reconciled guide booleans when a waiting writer reuses the single bootstrap", async () => {
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    getAnonymousBootstrapTokenMock.mockResolvedValue("token");
    let authoritativeSessionAvailable = false;
    let anonymousRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          return authoritativeSessionAvailable
            ? Response.json(anonymousSession, {
                headers: {
                  "X-Fukamu-Authenticated-User-ID": anonymousSession.user.id,
                },
              })
            : errorResponse(401, "SESSION_MISSING");
        }
        if (
          path === "/api/v1/session/anonymous" &&
          (init?.method ?? "GET") === "POST"
        ) {
          anonymousRequests += 1;
          authoritativeSessionAvailable = true;
          return Response.json(anonymousSession);
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    let lockQueue: Promise<unknown> = Promise.resolve();
    const lockRequest = vi.fn(
      (
        _name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => {
        expect(options.mode).toBe("exclusive");
        const result = lockQueue.then(() =>
          callback({ name: "test-session-cookie-writer", mode: "exclusive" }),
        );
        lockQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    let reconciledSnapshot: ReturnType<
      typeof readFirstUseGuidePreferences
    > | null = null;
    const firstReconciliation = vi.fn(() => {
      for (const stage of firstUseGuideStages) {
        markFirstUseGuideStageShown(stage);
      }
      skipFirstUseGuide();
      reconciledSnapshot = readFirstUseGuidePreferences();
    });
    const waitingReconciliation = vi.fn();

    const [created, reused] = await Promise.all([
      createAnonymousSession(() => true, undefined, firstReconciliation),
      createAnonymousSession(() => true, undefined, waitingReconciliation),
    ]);

    expect(created).toEqual(anonymousSession);
    expect(reused).toEqual(anonymousSession);
    expect(lockRequest).toHaveBeenCalledTimes(2);
    expect(anonymousRequests).toBe(1);
    expect(getAnonymousBootstrapTokenMock).toHaveBeenCalledOnce();
    expect(firstReconciliation).toHaveBeenCalledOnce();
    expect(firstReconciliation).toHaveBeenCalledWith(
      "local-shared-safe",
      anonymousSession,
    );
    expect(waitingReconciliation).toHaveBeenCalledOnce();
    expect(waitingReconciliation).toHaveBeenCalledWith(
      "deferred",
      anonymousSession,
    );
    expect(readFirstUseGuidePreferences()).toEqual(reconciledSnapshot);
  });
});

function errorResponse(status: number, code: string): Response {
  return Response.json(
    {
      error: {
        code,
        message: "request failed",
        requestId: "00000000-0000-7000-8000-000000000001",
      },
    },
    { status },
  );
}
