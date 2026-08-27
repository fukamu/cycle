import {
  clearBootstrapID,
  getOrCreateBootstrapID,
} from "./bootstrapRepository";
import { createAnonymousSession } from "./sessionDiscovery";
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
  csrfToken: "anonymous-csrf",
};

describe("anonymous session discovery", () => {
  beforeEach(() => {
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
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    getAnonymousBootstrapTokenMock.mockResolvedValue("token");
    const fetchMock = vi.fn(async () => Response.json(anonymousSession));
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

    const discovery = createAnonymousSession();

    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());
    expect(fetchMock).not.toHaveBeenCalled();

    grantLock();

    await expect(discovery).resolves.toEqual(anonymousSession);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(clearBootstrapIDMock).toHaveBeenCalledOnce();
  });

  it("retains the bootstrap ID when ownership is lost while the bootstrap response is pending", async () => {
    getOrCreateBootstrapIDMock.mockResolvedValue(
      "00000000-0000-7000-8000-000000000001",
    );
    getAnonymousBootstrapTokenMock.mockResolvedValue("token");
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let current = true;
    const discovery = createAnonymousSession(() => current);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

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
      vi.fn(async () => Response.json(anonymousSession)),
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

    current = false;
    resolveCleanup();

    await expect(discovery).resolves.toBeNull();
  });
});
