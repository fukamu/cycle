import type { AuthenticatedRequestLease } from "../../shared/api/client";
import {
  activateFirstUseGuide,
  clearFirstUseGuidePreferences,
  persistFirstUseGuideSkipped,
  persistFirstUseGuideStageShown,
  readFirstUseGuidePreferences,
} from "../../shared/preferences/firstUseGuidePreference";
import { persistFirstUseGuidePreferenceForCapturedUser } from "./firstUseGuideSessionPersistence";
import { runSessionCookieWriter } from "./sessionCookieWriter";

const oldUserId = "10000000-0000-7000-8000-000000000001";
const freshUserId = "10000000-0000-7000-8000-000000000002";
const currentRegistration = { isCurrent: () => true } as const;

describe("first-use Guide session-bound persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearFirstUseGuidePreferences();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serializes an old-user write before a fresh reset so the reset clears it", async () => {
    activateFirstUseGuide();
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    const lockRequest = installQueuedLockManager();
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    const oldWrite = persistFirstUseGuidePreferenceForCapturedUser({
      expectedUserId: oldUserId,
      lease: lease.value,
      lifecycle: lifecycle.value,
      registration: currentRegistration,
      persist: () => persistFirstUseGuideStageShown("goal"),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const resetStarted = vi.fn();
    const freshReset = runSessionCookieWriter(
      { isCurrent: () => true },
      async () => {
        resetStarted();
        activateFirstUseGuide();
      },
    );
    expect(resetStarted).not.toHaveBeenCalled();
    response.resolve(sessionResponse(oldUserId));

    await Promise.all([oldWrite, freshReset]);

    expect(lockRequest).toHaveBeenCalledTimes(2);
    expect(resetStarted).toHaveBeenCalledOnce();
    expect(lockRequest.mock.calls.map(([name]) => name)).toEqual([
      "fukamu-session-cookie-writer-v1",
      "fukamu-session-cookie-writer-v1",
    ]);
    expect(readFirstUseGuidePreferences()).toMatchObject({
      eligible: true,
      shown: { goal: false },
    });
  });

  it("serializes a fresh reset before a late old-user write and rejects the mismatched GET", async () => {
    activateFirstUseGuide();
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    installQueuedLockManager();
    const resetRelease = deferred<void>();
    const resetStarted = vi.fn();
    const freshReset = runSessionCookieWriter(
      { isCurrent: () => true },
      async () => {
        activateFirstUseGuide();
        resetStarted();
        await resetRelease.promise;
      },
    );
    await vi.waitFor(() => expect(resetStarted).toHaveBeenCalledOnce());
    const fetchMock = vi.fn(async () => sessionResponse(freshUserId));
    vi.stubGlobal("fetch", fetchMock);

    const oldWrite = persistFirstUseGuidePreferenceForCapturedUser({
      expectedUserId: oldUserId,
      lease: lease.value,
      lifecycle: lifecycle.value,
      registration: currentRegistration,
      persist: () => persistFirstUseGuideStageShown("goal"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    resetRelease.resolve();

    await Promise.all([freshReset, oldWrite]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFirstUseGuidePreferences()).toMatchObject({
      eligible: true,
      shown: { goal: false },
    });
  });

  it("persists only after the authoritative GET confirms the captured User", async () => {
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    installQueuedLockManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sessionResponse(oldUserId)),
    );
    const persist = vi.fn();

    await persistFirstUseGuidePreferenceForCapturedUser({
      expectedUserId: oldUserId,
      lease: lease.value,
      lifecycle: lifecycle.value,
      registration: currentRegistration,
      persist,
    });

    expect(persist).toHaveBeenCalledOnce();
  });

  it("drops a late write when transition or deletion invalidates its lease during GET", async () => {
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    installQueuedLockManager();
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const persist = vi.fn();
    const persistence = persistFirstUseGuidePreferenceForCapturedUser({
      expectedUserId: oldUserId,
      lease: lease.value,
      lifecycle: lifecycle.value,
      registration: currentRegistration,
      persist,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    lease.invalidate();
    clearFirstUseGuidePreferences();
    response.resolve(sessionResponse(oldUserId));
    await persistence;

    expect(persist).not.toHaveBeenCalled();
  });

  it("drops a late write after a same-user Provider remount while the session lease stays current", async () => {
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    installQueuedLockManager();
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const persist = vi.fn();
    const persistence = persistFirstUseGuidePreferenceForCapturedUser({
      expectedUserId: oldUserId,
      lease: lease.value,
      lifecycle: lifecycle.value,
      registration: currentRegistration,
      persist,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    lifecycle.invalidate();
    response.resolve(sessionResponse(oldUserId));
    await persistence;

    expect(lease.value.isCurrent()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["shown", () => persistFirstUseGuideStageShown("goal"), "shown"],
    ["skip", persistFirstUseGuideSkipped, "skipped"],
  ] as const)(
    "drops a pending %s write when its Guide registration changes during GET",
    async (_case, persist, preference) => {
      activateFirstUseGuide();
      const lease = createLease(oldUserId);
      const lifecycle = createLifecycle();
      const registration = createLifecycle();
      installQueuedLockManager();
      const response = deferred<Response>();
      const fetchMock = vi.fn(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      const persistence = persistFirstUseGuidePreferenceForCapturedUser({
        expectedUserId: oldUserId,
        lease: lease.value,
        lifecycle: lifecycle.value,
        registration: registration.value,
        persist,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      registration.invalidate();
      response.resolve(sessionResponse(oldUserId));
      await persistence;

      expect(lease.value.isCurrent()).toBe(true);
      expect(lifecycle.value.isCurrent()).toBe(true);
      const preferences = readFirstUseGuidePreferences();
      if (preference === "shown") {
        expect(preferences.shown.goal).toBe(false);
      } else {
        expect(preferences.skipped).toBe(false);
      }
    },
  );

  it("drops an old Provider write while it is still queued for the lock", async () => {
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    let grantLock!: () => void;
    const lockRequest = vi.fn(
      (
        _name: string,
        _options: LockOptions,
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
        }),
    );
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    const fetchMock = vi.fn(async () => sessionResponse(oldUserId));
    vi.stubGlobal("fetch", fetchMock);
    const persist = vi.fn();
    const persistence = persistFirstUseGuidePreferenceForCapturedUser({
      expectedUserId: oldUserId,
      lease: lease.value,
      lifecycle: lifecycle.value,
      registration: currentRegistration,
      persist,
    });
    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());

    lifecycle.invalidate();
    grantLock();
    await persistence;

    expect(lease.value.isCurrent()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps an Account Delete clear authoritative when an old write reaches the lock afterward", async () => {
    activateFirstUseGuide();
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    installQueuedLockManager();
    const deletionRelease = deferred<void>();
    const deletionStarted = vi.fn();
    const deletion = runSessionCookieWriter(
      { isCurrent: () => true },
      async () => {
        clearFirstUseGuidePreferences();
        deletionStarted();
        await deletionRelease.promise;
      },
    );
    await vi.waitFor(() => expect(deletionStarted).toHaveBeenCalledOnce());
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "SESSION_MISSING",
            message: "session unavailable",
            requestId: "10000000-0000-7000-8000-000000000003",
          },
        },
        { status: 401 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const oldWrite = persistFirstUseGuidePreferenceForCapturedUser({
      expectedUserId: oldUserId,
      lease: lease.value,
      lifecycle: lifecycle.value,
      registration: currentRegistration,
      persist: () => persistFirstUseGuideStageShown("goal"),
    });
    deletionRelease.resolve();
    await Promise.all([deletion, oldWrite]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFirstUseGuidePreferences()).toMatchObject({
      eligible: false,
      shown: { goal: false },
    });
  });

  it.each([
    ["lock", () => vi.stubGlobal("navigator", {})],
    [
      "GET",
      () => {
        installQueuedLockManager();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response(null, { status: 503 })),
        );
      },
    ],
  ])(
    "keeps %s failure best-effort and skips persistence",
    async (_case, setup) => {
      const lease = createLease(oldUserId);
      const lifecycle = createLifecycle();
      setup();
      const persist = vi.fn();

      await expect(
        persistFirstUseGuidePreferenceForCapturedUser({
          expectedUserId: oldUserId,
          lease: lease.value,
          lifecycle: lifecycle.value,
          registration: currentRegistration,
          persist,
        }),
      ).resolves.toBeUndefined();

      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("keeps storage failure best-effort", async () => {
    const lease = createLease(oldUserId);
    const lifecycle = createLifecycle();
    installQueuedLockManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sessionResponse(oldUserId)),
    );

    await expect(
      persistFirstUseGuidePreferenceForCapturedUser({
        expectedUserId: oldUserId,
        lease: lease.value,
        lifecycle: lifecycle.value,
        registration: currentRegistration,
        persist: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

function createLease(expectedUserId: string): {
  readonly value: AuthenticatedRequestLease;
  readonly invalidate: () => void;
} {
  const abortController = new AbortController();
  let current = true;
  return {
    value: {
      expectedUserId,
      signal: abortController.signal,
      isCurrent: () => current && !abortController.signal.aborted,
    },
    invalidate: () => {
      current = false;
      abortController.abort();
    },
  };
}

function createLifecycle(): {
  readonly value: {
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
  };
  readonly invalidate: () => void;
} {
  const abortController = new AbortController();
  let current = true;
  return {
    value: {
      signal: abortController.signal,
      isCurrent: () => current && !abortController.signal.aborted,
    },
    invalidate: () => {
      current = false;
      abortController.abort();
    },
  };
}

function installQueuedLockManager() {
  let queue: Promise<unknown> = Promise.resolve();
  const request = vi.fn(
    (
      _name: string,
      _options: LockOptions,
      callback: LockGrantedCallback<unknown>,
    ) => {
      const result = queue.then(() =>
        callback({ name: "test-session-cookie-writer", mode: "exclusive" }),
      );
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  );
  vi.stubGlobal("navigator", {
    locks: {
      request,
    },
  });
  return request;
}

function sessionResponse(userId: string): Response {
  return Response.json(
    {
      user: {
        id: userId,
        googleConnected: false,
        googleEmail: null,
      },
      csrfToken: "A".repeat(43),
    },
    { headers: { "X-Fukamu-Authenticated-User-ID": userId } },
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
