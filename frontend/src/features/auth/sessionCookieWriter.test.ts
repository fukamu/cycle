import {
  runSessionCookieWriter,
  SessionCookieCoordinationError,
} from "./sessionCookieWriter";

describe("session cookie writer coordination", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for one exclusive origin lock and rechecks ownership after acquisition", async () => {
    let grantLock!: () => void;
    let current = true;
    const operation = vi.fn(async () => "completed");
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

    const result = runSessionCookieWriter(
      { isCurrent: () => current },
      operation,
    );

    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());
    expect(operation).not.toHaveBeenCalled();
    current = false;
    grantLock();

    await expect(result).resolves.toBeNull();
    expect(operation).not.toHaveBeenCalled();
    const [name, options] = lockRequest.mock.calls[0]!;
    expect(name).toBe("fukamu-session-cookie-writer-v1");
    expect(options).toEqual({ mode: "exclusive" });
  });

  it("forwards an owner abort while waiting without dispatching the operation", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => "not-dispatched");
    const lockRequest = vi.fn(
      (_name: string, options: LockOptions) =>
        new Promise<unknown>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () =>
              reject(
                options.signal?.reason ??
                  new DOMException("request aborted", "AbortError"),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    const result = runSessionCookieWriter(
      { isCurrent: () => true, signal: controller.signal },
      operation,
    );
    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", {}],
    [
      "broken",
      {
        locks: {
          request: vi.fn(async () => {
            throw new TypeError("internal lock failure");
          }),
        },
      },
    ],
    [
      "silently skipped",
      {
        locks: {
          request: vi.fn(async () => undefined),
        },
      },
    ],
  ])("fails closed when Web Locks are %s", async (_case, navigatorValue) => {
    vi.stubGlobal("navigator", navigatorValue);
    const operation = vi.fn(async () => "must-not-run");

    await expect(
      runSessionCookieWriter({ isCurrent: () => true }, operation),
    ).rejects.toBeInstanceOf(SessionCookieCoordinationError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves an operation failure after the exclusive lock is acquired", async () => {
    const failure = new TypeError("network unavailable");
    const lockRequest = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => callback({ name: "test-session-cookie-writer", mode: "exclusive" }),
    );
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });

    await expect(
      runSessionCookieWriter({ isCurrent: () => true }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
