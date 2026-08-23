import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

import {
  requestAuthenticatedJSON,
  type AuthenticatedRequestLease,
} from "../../shared/api/client";
import { sessionSchema, type Session } from "../../shared/api/schemas";
import { sessionRecoveryEvents } from "../../shared/api/sessionRecoveryEvents";
import {
  type AutoSaveQuiesceCallback,
  type AutoSaveScopeLease,
  useAutoSaveScopeRegistry,
} from "../../shared/autosave/AutoSaveScopeProvider";
import {
  cleanupExpiredBrowserDrafts,
  clearUserDrafts,
} from "../../shared/drafts/browserDraftCache";
import { SessionIdentityBoundary, SessionProvider } from "./SessionProvider";
import type {
  AccountDeletionAdvisoryChannelLike,
  AccountDeletionAdvisoryFactory,
} from "./accountDeletionAdvisory";
import type {
  SessionIdentityAdvisoryChannelLike,
  SessionIdentityAdvisoryFactory,
} from "./sessionIdentityAdvisory";
import {
  useAuthenticatedRequestLease,
  useRunSessionTransition,
  useRunTerminalSessionOperation,
  useSession,
} from "./sessionContext";

vi.mock("../../shared/drafts/browserDraftCache", () => ({
  cleanupExpiredBrowserDrafts: vi.fn(),
  clearUserDrafts: vi.fn(),
}));

const cleanupExpiredBrowserDraftsMock = vi.mocked(cleanupExpiredBrowserDrafts);
const clearUserDraftsMock = vi.mocked(clearUserDrafts);

const requestID = "00000000-0000-7000-8000-000000000001";
const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000002",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};
const switchedSession: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000003",
    googleConnected: true,
    googleEmail: "existing@example.com",
  },
  csrfToken: "switched-csrf-token",
};
const latestSession: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000004",
    googleConnected: true,
    googleEmail: "latest@example.com",
  },
  csrfToken: "latest-csrf-token",
};

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", undefined);
  cleanupExpiredBrowserDraftsMock.mockReset();
  cleanupExpiredBrowserDraftsMock.mockResolvedValue(undefined);
  clearUserDraftsMock.mockReset();
  clearUserDraftsMock.mockResolvedValue(undefined);
});

describe("SessionProvider admission boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the invite gate before Turnstile and continues after redeem", async () => {
    const requests: string[] = [];
    let admitted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        requests.push(path);
        if (path === "/api/__beta/admission/redeem") {
          admitted = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/api/v1/session" && !admitted) {
          return errorResponse(403, "BETA_ADMISSION_REQUIRED");
        }
        if (path === "/api/v1/session") {
          return sessionResponse(session);
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider();

    expect(
      await screen.findByRole("heading", {
        name: "招待された方のみご利用いただけます",
      }),
    ).toBeInTheDocument();
    expect(requests).toEqual(["/api/v1/session"]);

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("招待Token"),
      `fukamu_cycle_beta_${"a".repeat(43)}`,
    );
    await user.click(screen.getByRole("button", { name: "利用を開始する" }));

    expect(await screen.findByText("application ready")).toBeInTheDocument();
    expect(requests).toEqual([
      "/api/v1/session",
      "/api/__beta/admission/redeem",
      "/api/v1/session",
    ]);
  });

  it("keeps the gate open when the invite token is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          return errorResponse(403, "BETA_ADMISSION_REQUIRED");
        }
        return errorResponse(403, "BETA_INVITE_INVALID");
      }),
    );

    renderProvider();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("招待Token"), "invalid");
    await user.click(screen.getByRole("button", { name: "利用を開始する" }));

    expect(
      await screen.findByRole("alert", {
        name: "",
      }),
    ).toHaveTextContent("招待Tokenを確認できませんでした");
    expect(screen.queryByText("application ready")).not.toBeInTheDocument();
  });

  it("keeps the normal anonymous bootstrap flow independent of admission", async () => {
    const requests: { method: string; path: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push({ method, path });
        if (path === "/api/v1/session") {
          return errorResponse(401, "SESSION_MISSING");
        }
        if (path === "/api/v1/session/anonymous" && method === "POST") {
          return sessionResponse(session);
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      }),
    );

    renderProvider();

    expect(await screen.findByText("application ready")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "招待された方のみご利用いただけます",
      }),
    ).not.toBeInTheDocument();
    expect(requests).toEqual([
      { method: "GET", path: "/api/v1/session" },
      { method: "POST", path: "/api/v1/session/anonymous" },
    ]);
  });

  it("aborts a lock-waiting anonymous bootstrap when another tab changes identity", async () => {
    const advisory = createAdvisoryChannelHarness();
    const reloadApplication = vi.fn();
    let writerSignal: AbortSignal | undefined;
    const lockRequest = vi.fn(
      (_name: string, options: LockOptions) =>
        new Promise<unknown>((_resolve, reject) => {
          writerSignal = options.signal;
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
    let anonymousRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          return errorResponse(401, "SESSION_MISSING");
        }
        if (path === "/api/v1/session/anonymous") {
          anonymousRequests += 1;
          return sessionResponse(session);
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(<p>must not publish anonymous session</p>, createClient(), {
      advisoryFactory: () => advisory.channel,
      reloadApplication,
    });
    await waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());

    act(() => {
      advisory.dispatch({
        version: 1,
        targetUserId: switchedSession.user.id,
      });
    });

    await waitFor(() => expect(writerSignal?.aborted).toBe(true));
    expect(reloadApplication).toHaveBeenCalledOnce();
    expect(anonymousRequests).toBe(0);
    expect(
      screen.queryByText("must not publish anonymous session"),
    ).not.toBeInTheDocument();
  });

  it("bootstraps exactly once when an initial-session retry finds no session", async () => {
    let sessionRequests = 0;
    let anonymousRequests = 0;
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests <= 3) {
            throw new TypeError("network unavailable");
          }
          return errorResponse(401, "SESSION_MISSING");
        }
        if (
          path === "/api/v1/session/anonymous" &&
          (init?.method ?? "GET") === "POST"
        ) {
          anonymousRequests += 1;
          return sessionResponse(session);
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });

    renderProvider(
      <>
        <p>application ready after retry</p>
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "FUKAMU Cycleを開始できませんでした。",
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "再試行" }));

    expect(
      await screen.findByText("application ready after retry"),
    ).toBeInTheDocument();
    expect(sessionRequests).toBe(4);
    expect(anonymousRequests).toBe(1);
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("starts browser draft cleanup once without blocking startup when cleanup fails", async () => {
    cleanupExpiredBrowserDraftsMock.mockRejectedValueOnce(
      new Error("IndexedDB is unavailable"),
    );
    stubSession(session);

    render(
      <StrictMode>
        <QueryClientProvider client={createClient()}>
          <SessionProvider>
            <SessionIdentityBoundary>
              <p>application ready</p>
            </SessionIdentityBoundary>
          </SessionProvider>
        </QueryClientProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("application ready")).toBeInTheDocument();
    expect(cleanupExpiredBrowserDraftsMock).toHaveBeenCalledOnce();
  });

  it("aborts initial discovery and rejects a late session after a true unmount", async () => {
    const client = createClient();
    let discoverySignal: AbortSignal | undefined;
    let resolveDiscovery!: (response: Response) => void;
    const discoveryResponse = new Promise<Response>((resolve) => {
      resolveDiscovery = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        discoverySignal = init?.signal ?? undefined;
        return discoveryResponse;
      }),
    );

    const rendered = render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <SessionIdentityBoundary>
            <p>late application</p>
          </SessionIdentityBoundary>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(discoverySignal).toBeDefined());
    act(() => {
      // Queue the successful response before cleanup schedules its deferred
      // abort; the mounted-state fence must still reject the late session.
      resolveDiscovery(sessionResponse(session));
      rendered.unmount();
    });
    await waitFor(() => expect(discoverySignal?.aborted).toBe(true));
    await Promise.resolve();
    await Promise.resolve();

    expect(client.getQueryData(["session"])).toBeUndefined();
    expect(screen.queryByText("late application")).not.toBeInTheDocument();
  });
});

describe("SessionProvider identity boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves query and mutation caches when the same user session is upgraded", async () => {
    stubSession(session);
    const client = createClient();
    const { cachedHome, cachedMutation } = seedUserCaches(client);
    const upgradedSession: Session = {
      user: {
        ...session.user,
        googleConnected: true,
        googleEmail: "upgraded@example.com",
      },
      csrfToken: "rotated-csrf-token",
    };

    renderProvider(
      <SessionTransitionProbe nextSession={upgradedSession} showEditor />,
      client,
    );

    expect(await screen.findByTestId("session-observation")).toHaveTextContent(
      `${session.user.id}|${session.csrfToken}|1|1`,
    );
    const user = userEvent.setup();
    const editor = screen.getByRole("textbox", {
      name: "identity-bound editor",
    });
    await user.clear(editor);
    await user.type(editor, "same-user local input");
    await user.click(screen.getByRole("button", { name: "セッションを置換" }));

    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        `${upgradedSession.user.id}|${upgradedSession.csrfToken}|1|1`,
      ),
    );
    expect(client.getQueryData(userHomeQueryKey(session.user.id))).toBe(
      cachedHome,
    );
    expect(client.getMutationCache().getAll()).toContain(cachedMutation);
    expect(
      screen.getByRole("textbox", { name: "identity-bound editor" }),
    ).toHaveValue("same-user local input");
  });

  it("keeps the active autosave lease for a same-user upgrade", async () => {
    stubSession(session);
    const upgradedSession: Session = {
      user: {
        ...session.user,
        googleConnected: true,
        googleEmail: "upgraded@example.com",
      },
      csrfToken: "rotated-csrf-token",
    };
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const leases: AutoSaveScopeLease[] = [];

    renderProvider(
      <>
        <SessionTransitionProbe nextSession={upgradedSession} />
        <AutoSaveScopeProbe
          onLease={(lease) => leases.push(lease)}
          onQuiesce={lifecycle}
        />
      </>,
    );

    expect(await screen.findByTestId("session-observation")).toHaveTextContent(
      session.csrfToken,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "セッションを置換" }));

    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        upgradedSession.csrfToken,
      ),
    );
    expect(lifecycle).not.toHaveBeenCalled();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.signal.aborted).toBe(false);
    expect(leases[0]?.isCurrent()).toBe(true);
  });

  it("awaits draft-preserving autosave quiescence before publishing a changed user", async () => {
    stubSession(session);
    const client = createClient();
    const releaseQuiesce = deferredVoid();
    const cancelQueries = vi.spyOn(client, "cancelQueries");
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(
      async ({ preserveDrafts }) => {
        expect(preserveDrafts).toBe(true);
        expect(
          screen
            .getByLabelText("identity-bound editor")
            .closest("div[hidden][inert]"),
        ).not.toBeNull();
        await releaseQuiesce.promise;
      },
    );
    let oldLease: AutoSaveScopeLease | undefined;

    renderProvider(
      <>
        <SessionTransitionProbe nextSession={switchedSession} showEditor />
        <AutoSaveScopeProbe
          onLease={(lease) => {
            oldLease ??= lease;
          }}
          onQuiesce={lifecycle}
        />
      </>,
      client,
    );

    expect(await screen.findByTestId("session-observation")).toHaveTextContent(
      session.user.id,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "セッションを置換" }));

    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());
    expect(oldLease?.signal.aborted).toBe(true);
    expect(oldLease?.isCurrent()).toBe(false);
    expect(cancelQueries).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-observation")).toHaveTextContent(
      session.user.id,
    );

    releaseQuiesce.resolve();

    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    expect(cancelQueries).toHaveBeenCalledWith({
      queryKey: ["user", session.user.id],
    });
  });

  it("holds the cookie-writer lock through changed-user publication", async () => {
    stubSession(session);
    const releaseQuiesce = deferredVoid();
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(async () => {
      await releaseQuiesce.promise;
    });
    let grantLock!: () => void;
    let lockReleased = false;
    const lockRequest = vi.fn(
      (
        _name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) =>
        new Promise<unknown>((resolve, reject) => {
          grantLock = () => {
            void (async () => {
              try {
                resolve(
                  await callback({
                    name: "test-session-cookie-writer",
                    mode: "exclusive",
                  }),
                );
              } catch (error) {
                reject(error);
              } finally {
                lockReleased = true;
              }
            })();
          };
          expect(options.mode).toBe("exclusive");
        }),
    );
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });

    renderProvider(
      <>
        <SessionTransitionProbe nextSession={switchedSession} />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
    );

    const observation = await screen.findByTestId("session-observation");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "セッションを置換" }));
    await vi.waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());
    expect(observation).toHaveTextContent(session.user.id);
    expect(lifecycle).not.toHaveBeenCalled();

    grantLock();

    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());
    expect(lockReleased).toBe(false);
    expect(observation).toHaveTextContent(session.user.id);

    releaseQuiesce.resolve();

    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    await waitFor(() => expect(lockReleased).toBe(true));
  });

  it("fences a paused changed-user publication when a later advisory invalidates the empty lease slot", async () => {
    const releaseQuiesce = deferredVoid();
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(async () => {
      await releaseQuiesce.promise;
    });
    const advisory = createAdvisoryChannelHarness();
    const client = createClient();
    const publishedUserIds: string[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== "session") return;
      const publishedSession = event.query.state.data as Session | undefined;
      if (publishedSession !== undefined) {
        publishedUserIds.push(publishedSession.user.id);
      }
    });
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(
            sessionRequests === 1 ? session : latestSession,
          );
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <SessionTransitionProbe nextSession={switchedSession} />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
      { advisoryFactory: () => advisory.channel },
    );

    const observation = await screen.findByTestId("session-observation");
    expect(observation).toHaveTextContent(session.user.id);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "セッションを置換" }));
    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());

    act(() => {
      advisory.dispatch({ version: 1, targetUserId: latestSession.user.id });
    });

    expect(observation.closest("div[hidden][inert]")).not.toBeNull();
    expect(observation).toHaveTextContent(session.user.id);
    expect(client.getQueryData<Session>(["session"])?.user.id).toBe(
      session.user.id,
    );
    expect(publishedUserIds).not.toContain(switchedSession.user.id);

    act(() => releaseQuiesce.resolve());

    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        latestSession.user.id,
      ),
    );
    expect(client.getQueryData<Session>(["session"])?.user.id).toBe(
      latestSession.user.id,
    );
    expect(publishedUserIds).not.toContain(switchedSession.user.id);
    expect(sessionRequests).toBe(2);
    unsubscribe();
  });

  it("keeps a paused changed-user publication fenced after identity becomes unverified", async () => {
    const releaseQuiesce = deferredVoid();
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(async () => {
      await releaseQuiesce.promise;
    });
    const client = createClient();
    const publishedUserIds: string[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== "session") return;
      const publishedSession = event.query.state.data as Session | undefined;
      if (publishedSession !== undefined) {
        publishedUserIds.push(publishedSession.user.id);
      }
    });
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(session);
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <SessionTransitionProbe nextSession={switchedSession} />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    const observation = await screen.findByTestId("session-observation");
    const publishUnverified = sessionRecoveryEvents.capturePublisher();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "セッションを置換" }));
    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());

    act(() => publishUnverified("SESSION_IDENTITY_UNVERIFIED"));
    expect(observation.closest("div[hidden][inert]")).not.toBeNull();
    act(() => releaseQuiesce.resolve());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セッションを安全に確認できませんでした。再読み込みしてください。",
    );
    expect(client.getQueryData<Session>(["session"])?.user.id).toBe(
      session.user.id,
    );
    expect(publishedUserIds).not.toContain(switchedSession.user.id);
    expect(screen.getByTestId("session-observation")).toHaveTextContent(
      session.user.id,
    );
    expect(sessionRequests).toBe(1);
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();
    unsubscribe();
  });

  it("clears non-session query and mutation state before publishing a changed user", async () => {
    stubSession(session);
    const client = createClient();
    const cancellation = deferredVoid();
    const cancelQueries = vi
      .spyOn(client, "cancelQueries")
      .mockReturnValue(cancellation.promise);
    seedUserCaches(client);

    renderProvider(
      <SessionTransitionProbe nextSession={switchedSession} />,
      client,
    );

    expect(await screen.findByTestId("session-observation")).toHaveTextContent(
      `${session.user.id}|${session.csrfToken}|1|1`,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "セッションを置換" }));

    await waitFor(() =>
      expect(cancelQueries).toHaveBeenCalledWith({
        queryKey: ["user", session.user.id],
      }),
    );
    expect(screen.getByTestId("session-observation")).toHaveTextContent(
      `${session.user.id}|${session.csrfToken}|1|1`,
    );

    cancellation.resolve();
    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        `${switchedSession.user.id}|${switchedSession.csrfToken}|0|0`,
      ),
    );
    expect(
      client.getQueryData(userHomeQueryKey(session.user.id)),
    ).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("cancels a queued transition intent when the rendered identity has changed", async () => {
    stubSession(session);
    const client = createClient();
    const firstCancellation = deferredVoid();
    const secondRequest = vi.fn(async () => latestSession);
    const cancelQueries = vi
      .spyOn(client, "cancelQueries")
      .mockReturnValueOnce(firstCancellation.promise);

    renderProvider(
      <QueuedSessionTransitionProbe
        firstSession={switchedSession}
        onSecondRequest={secondRequest}
      />,
      client,
    );

    expect(await screen.findByTestId("queued-session-user")).toHaveTextContent(
      session.user.id,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "置換を連続実行" }));

    await waitFor(() =>
      expect(cancelQueries).toHaveBeenNthCalledWith(1, {
        queryKey: ["user", session.user.id],
      }),
    );
    expect(client.getQueryData<Session>(["session"])).toEqual(session);

    firstCancellation.resolve();
    await waitFor(() =>
      expect(screen.getByTestId("queued-session-user")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    expect(secondRequest).not.toHaveBeenCalled();
    expect(cancelQueries).toHaveBeenCalledOnce();
    expect(client.getQueryData<Session>(["session"])).toEqual(switchedSession);
  });

  it("runs a later intent from the newly rendered identity and clears each old-user cache", async () => {
    stubSession(session);
    const client = createClient();
    const cancelQueries = vi.spyOn(client, "cancelQueries");

    renderProvider(
      <SequentialSessionTransitionProbe
        firstSession={switchedSession}
        secondSession={latestSession}
      />,
      client,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "次のセッションへ置換" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sequential-session-user")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "次のセッションへ置換" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sequential-session-user")).toHaveTextContent(
        latestSession.user.id,
      ),
    );

    expect(cancelQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ["user", session.user.id],
    });
    expect(cancelQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ["user", switchedSession.user.id],
    });
  });

  it("remounts the child subtree when the user identity changes", async () => {
    stubSession(session);
    renderProvider(
      <SessionTransitionProbe nextSession={switchedSession} showEditor />,
    );

    const editor = await screen.findByRole("textbox", {
      name: "identity-bound editor",
    });
    const user = userEvent.setup();
    await user.clear(editor);
    await user.type(editor, "old-user local input");
    await user.click(screen.getByRole("button", { name: "セッションを置換" }));

    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    expect(
      screen.getByRole("textbox", { name: "identity-bound editor" }),
    ).toHaveValue(`initial:${switchedSession.user.id}`);
  });
});

it("passes the execution-time current lease to transition and terminal operations", async () => {
  stubSession(session);
  const observations = vi.fn();

  renderProvider(<OperationLeaseProbe onObserve={observations} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "lease operations" }),
  );

  await waitFor(() => expect(observations).toHaveBeenCalledTimes(2));
  expect(observations).toHaveBeenNthCalledWith(
    1,
    "transition",
    session.user.id,
    true,
    true,
  );
  expect(observations).toHaveBeenNthCalledWith(
    2,
    "terminal",
    session.user.id,
    true,
    true,
  );
});

describe("SessionProvider runtime recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["SESSION_EXPIRED", "SESSION_MISSING"] as const)(
    "single-flights concurrent %s commands and preserves drafts before replacing the identity",
    async (recoveryCode) => {
      const releaseQuiesce = deferredVoid();
      const lifecycle = vi.fn<AutoSaveQuiesceCallback>(
        async ({ preserveDrafts }) => {
          expect(preserveDrafts).toBe(true);
          await releaseQuiesce.promise;
        },
      );
      const leases: AutoSaveScopeLease[] = [];
      const client = createClient();
      seedUserCaches(client);
      let sessionRequests = 0;
      let anonymousRequests = 0;
      let commandRequests = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const path = typeof input === "string" ? input : input.toString();
          if (path === "/api/v1/session") {
            sessionRequests += 1;
            if (sessionRequests === 1) return sessionResponse(session);
            return errorResponse(401, recoveryCode);
          }
          if (path === "/api/v1/session/anonymous") {
            anonymousRequests += 1;
            return sessionResponse(switchedSession);
          }
          if (path.startsWith("/api/v1/test-command/")) {
            commandRequests += 1;
            return errorResponse(401, recoveryCode);
          }
          throw new Error(`unexpected request: ${path}`);
        }),
      );

      renderProvider(
        <>
          <RuntimeRecoveryProbe showEditor />
          <AutoSaveScopeProbe
            onLease={(lease) => leases.push(lease)}
            onQuiesce={lifecycle}
          />
        </>,
        client,
      );

      expect(
        await screen.findByTestId("runtime-session-user"),
      ).toHaveTextContent(session.user.id);
      const user = userEvent.setup();
      const editor = screen.getByRole("textbox", {
        name: "runtime identity-bound editor",
      });
      await user.clear(editor);
      await user.type(editor, "input captured before quiesce");
      await user.click(
        screen.getByRole("button", {
          name:
            recoveryCode === "SESSION_EXPIRED"
              ? "期限切れを並行送信"
              : "セッション欠落を並行送信",
        }),
      );

      await waitFor(() => expect(commandRequests).toBe(2));
      await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());
      expect(editor).toHaveValue("input captured before quiesce");
      expect(editor.closest("div[hidden][inert]")).not.toBeNull();
      expect(leases).toHaveLength(1);
      expect(sessionRequests).toBe(1);
      expect(anonymousRequests).toBe(0);

      releaseQuiesce.resolve();

      await waitFor(() =>
        expect(screen.getByTestId("runtime-session-user")).toHaveTextContent(
          switchedSession.user.id,
        ),
      );
      expect(sessionRequests).toBe(2);
      expect(anonymousRequests).toBe(1);
      expect(lifecycle).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("textbox", {
          name: "runtime identity-bound editor",
        }),
      ).toHaveValue(`initial:${switchedSession.user.id}`);
      expect(
        client.getQueryData(userHomeQueryKey(session.user.id)),
      ).toBeUndefined();
      expect(client.getMutationCache().getAll()).toHaveLength(0);
    },
  );

  it("single-flights CSRF_INVALID commands and refreshes the same user without quiescing or remounting", async () => {
    const refreshedSession: Session = {
      user: session.user,
      csrfToken: "refreshed-csrf-token",
    };
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const leases: AutoSaveScopeLease[] = [];
    const client = createClient();
    const { cachedHome, cachedMutation } = seedUserCaches(client);
    let sessionRequests = 0;
    let commandRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(
            sessionRequests === 1 ? session : refreshedSession,
          );
        }
        if (path.startsWith("/api/v1/test-command/")) {
          commandRequests += 1;
          return errorResponse(403, "CSRF_INVALID");
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider(
      <>
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe
          onLease={(lease) => leases.push(lease)}
          onQuiesce={lifecycle}
        />
      </>,
      client,
    );

    expect(await screen.findByTestId("runtime-session-csrf")).toHaveTextContent(
      session.csrfToken,
    );
    const user = userEvent.setup();
    const editor = screen.getByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    await user.clear(editor);
    await user.type(editor, "same-user unsaved input");
    await user.click(
      screen.getByRole("button", { name: "CSRF失敗を並行送信" }),
    );

    await waitFor(() => expect(commandRequests).toBe(2));
    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-csrf")).toHaveTextContent(
        refreshedSession.csrfToken,
      ),
    );
    expect(sessionRequests).toBe(2);
    expect(lifecycle).not.toHaveBeenCalled();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.isCurrent()).toBe(true);
    expect(
      screen.getByRole("textbox", {
        name: "runtime identity-bound editor",
      }),
    ).toHaveValue("same-user unsaved input");
    expect(client.getQueryData(userHomeQueryKey(session.user.id))).toBe(
      cachedHome,
    );
    expect(client.getMutationCache().getAll()).toContain(cachedMutation);
  });

  it.each(["SESSION_MISSING", "SESSION_EXPIRED"] as const)(
    "preempts CSRF recovery with %s and fences interaction before quiescing",
    async (recoveryCode) => {
      const releaseQuiesce = deferredVoid();
      const ordering: string[] = [];
      const csrfRecoveryAborted = vi.fn();
      const lifecycle = vi.fn<AutoSaveQuiesceCallback>(
        async ({ preserveDrafts }) => {
          ordering.push("quiesce-start");
          expect(preserveDrafts).toBe(true);
          expect(
            screen
              .getByLabelText("runtime identity-bound editor")
              .closest("div[hidden][inert]"),
          ).not.toBeNull();
          await releaseQuiesce.promise;
        },
      );
      let sessionRequests = 0;
      let anonymousRequests = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = typeof input === "string" ? input : input.toString();
          if (path === "/api/v1/session") {
            sessionRequests += 1;
            ordering.push("session-" + sessionRequests);
            if (sessionRequests === 1) return sessionResponse(session);
            if (sessionRequests === 2) {
              if (init?.signal === undefined) {
                throw new Error("recovery request must be abortable");
              }
              return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener(
                  "abort",
                  () => {
                    csrfRecoveryAborted();
                    reject(
                      new DOMException("recovery superseded", "AbortError"),
                    );
                  },
                  { once: true },
                );
              });
            }
            return errorResponse(401, recoveryCode);
          }
          if (path === "/api/v1/session/anonymous") {
            anonymousRequests += 1;
            return sessionResponse(switchedSession);
          }
          if (path.includes("/test-command/csrf/")) {
            return errorResponse(403, "CSRF_INVALID");
          }
          if (path.includes("/test-command/missing/")) {
            return errorResponse(401, recoveryCode);
          }
          throw new Error("unexpected request: " + path);
        }),
      );

      renderProvider(
        <>
          <RuntimeRecoveryProbe showEditor />
          <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
        </>,
      );

      const user = userEvent.setup();
      const editor = await screen.findByRole("textbox", {
        name: "runtime identity-bound editor",
      });
      await user.clear(editor);
      await user.type(editor, "dirty input before mixed recovery");
      await user.click(
        screen.getByRole("button", { name: "CSRF失敗を並行送信" }),
      );
      await waitFor(() => expect(sessionRequests).toBe(2));

      await user.click(
        screen.getByRole("button", { name: "セッション欠落を並行送信" }),
      );

      await waitFor(() => expect(csrfRecoveryAborted).toHaveBeenCalledOnce());
      await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());
      expect(editor).toHaveValue("dirty input before mixed recovery");
      expect(editor.closest("div[hidden][inert]")).not.toBeNull();
      expect(ordering).toEqual(["session-1", "session-2", "quiesce-start"]);
      expect(sessionRequests).toBe(2);
      expect(anonymousRequests).toBe(0);

      releaseQuiesce.resolve();

      await waitFor(() =>
        expect(screen.getByTestId("runtime-session-user")).toHaveTextContent(
          switchedSession.user.id,
        ),
      );
      expect(sessionRequests).toBe(3);
      expect(anonymousRequests).toBe(1);
      expect(lifecycle).toHaveBeenCalledOnce();
    },
  );

  it("preempts a lost-session recovery when an advisory reports a different user", async () => {
    const advisory = createAdvisoryChannelHarness();
    const lostRecoveryAborted = vi.fn();
    let resolveLostRecovery!: (response: Response) => void;
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          if (sessionRequests === 2) {
            if (init?.signal === undefined) {
              throw new Error("recovery request must be abortable");
            }
            return new Promise<Response>((resolve, reject) => {
              resolveLostRecovery = resolve;
              init.signal?.addEventListener(
                "abort",
                () => {
                  lostRecoveryAborted();
                  reject(new DOMException("recovery superseded", "AbortError"));
                },
                { once: true },
              );
            });
          }
          return sessionResponse(switchedSession);
        }
        if (path.startsWith("/api/v1/test-command/expired/")) {
          return errorResponse(401, "SESSION_EXPIRED");
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(<RuntimeRecoveryProbe showEditor />, createClient(), {
      advisoryFactory: () => advisory.channel,
    });

    const editor = await screen.findByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "期限切れを並行送信" }));
    await waitFor(() => expect(sessionRequests).toBe(2));

    act(() => {
      advisory.dispatch({
        version: 1,
        targetUserId: switchedSession.user.id,
      });
      resolveLostRecovery(sessionResponse(session));
    });
    expect(editor.closest("div[hidden][inert]")).not.toBeNull();

    await waitFor(() => expect(lostRecoveryAborted).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-user")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    expect(sessionRequests).toBe(3);
  });

  it("keeps a dirty editor on CSRF recovery failure until an explicit retry", async () => {
    const refreshedSession: Session = {
      user: session.user,
      csrfToken: "explicit-retry-csrf-token",
    };
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    let sessionRequests = 0;
    let anonymousRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          if (sessionRequests === 2) {
            throw new TypeError("network disconnected");
          }
          return sessionResponse(refreshedSession);
        }
        if (path === "/api/v1/session/anonymous") {
          anonymousRequests += 1;
          return sessionResponse(switchedSession);
        }
        if (path.startsWith("/api/v1/test-command/")) {
          return errorResponse(403, "CSRF_INVALID");
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider(
      <>
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
    );

    const user = userEvent.setup();
    const editor = await screen.findByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    await user.clear(editor);
    await user.type(editor, "dirty input during csrf failure");
    await user.click(
      screen.getByRole("button", { name: "CSRF失敗を並行送信" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セッションを再接続できませんでした。",
    );
    expect(editor).toHaveValue("dirty input during csrf failure");
    expect(editor.closest("div[hidden]")).toBeNull();
    expect(sessionRequests).toBe(2);

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionRequests).toBe(2);
    expect(anonymousRequests).toBe(0);
    expect(lifecycle).not.toHaveBeenCalled();
    expect(editor).toHaveValue("dirty input during csrf failure");

    await user.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-csrf")).toHaveTextContent(
        refreshedSession.csrfToken,
      ),
    );
    expect(sessionRequests).toBe(3);
    expect(anonymousRequests).toBe(0);
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("remounts a fresh autosave lease when retry returns the same user after quiesced bootstrap failure", async () => {
    const refreshedSession: Session = {
      user: session.user,
      csrfToken: "same-user-after-quiesce",
    };
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const leases: AutoSaveScopeLease[] = [];
    let sessionRequests = 0;
    let anonymousRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          if (sessionRequests === 2) {
            return errorResponse(401, "SESSION_EXPIRED");
          }
          return sessionResponse(refreshedSession);
        }
        if (path === "/api/v1/session/anonymous") {
          anonymousRequests += 1;
          throw new TypeError("bootstrap response unavailable");
        }
        if (path.startsWith("/api/v1/test-command/")) {
          return errorResponse(403, "CSRF_INVALID");
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe
          onLease={(lease) => leases.push(lease)}
          onQuiesce={lifecycle}
        />
      </>,
    );

    const user = userEvent.setup();
    const editor = await screen.findByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    await user.clear(editor);
    await user.type(editor, "dirty input before quiesced failure");
    await user.click(
      screen.getByRole("button", { name: "CSRF失敗を並行送信" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セッションを再接続できませんでした。",
    );
    expect(editor.closest("div[hidden][inert]")).not.toBeNull();
    expect(editor).toHaveValue("dirty input before quiesced failure");
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.isCurrent()).toBe(false);
    expect(anonymousRequests).toBe(1);

    await user.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-csrf")).toHaveTextContent(
        refreshedSession.csrfToken,
      ),
    );
    expect(sessionRequests).toBe(3);
    expect(anonymousRequests).toBe(1);
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(leases).toHaveLength(2);
    expect(leases[0]?.isCurrent()).toBe(false);
    expect(leases[1]?.isCurrent()).toBe(true);
    expect(
      screen.getByRole("textbox", {
        name: "runtime identity-bound editor",
      }),
    ).not.toBe(editor);
    expect(
      screen.getByRole("textbox", {
        name: "runtime identity-bound editor",
      }),
    ).toHaveValue("initial:" + session.user.id);
  });

  it("keeps the old session and mounted draft behind a safe retry alert when recovery fails", async () => {
    const refreshedSession: Session = {
      user: session.user,
      csrfToken: "retry-refreshed-csrf-token",
    };
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const client = createClient();
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          if (sessionRequests === 2) {
            throw new TypeError("private network diagnostics");
          }
          return sessionResponse(refreshedSession);
        }
        if (path.startsWith("/api/v1/test-command/")) {
          return errorResponse(401, "SESSION_EXPIRED");
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider(
      <>
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    const user = userEvent.setup();
    const editor = await screen.findByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    await user.clear(editor);
    await user.type(editor, "draft kept on recovery failure");
    await user.click(
      screen.getByRole("button", { name: "期限切れを並行送信" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("セッションを再接続できませんでした。");
    expect(alert).not.toHaveTextContent("private network diagnostics");
    expect(screen.getByDisplayValue("draft kept on recovery failure")).toBe(
      editor,
    );
    expect(editor.closest("div[hidden][inert]")).not.toBeNull();
    expect(client.getQueryData<Session>(["session"])).toEqual(session);
    expect(lifecycle).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-csrf")).toHaveTextContent(
        refreshedSession.csrfToken,
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sessionRequests).toBe(3);
  });

  it("does not bootstrap or quiesce for a mismatched SESSION_EXPIRED status", async () => {
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const client = createClient();
    let sessionRequests = 0;
    let anonymousRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          return errorResponse(500, "SESSION_EXPIRED");
        }
        if (path === "/api/v1/session/anonymous") {
          anonymousRequests += 1;
          return sessionResponse(switchedSession);
        }
        if (path.startsWith("/api/v1/test-command/")) {
          return errorResponse(403, "CSRF_INVALID");
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider(
      <>
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    const user = userEvent.setup();
    await screen.findByTestId("runtime-session-user");
    await user.click(
      screen.getByRole("button", { name: "CSRF失敗を並行送信" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セッションを再接続できませんでした。",
    );
    expect(sessionRequests).toBe(2);
    expect(anonymousRequests).toBe(0);
    expect(lifecycle).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("textbox", {
          name: "runtime identity-bound editor",
        })
        .closest("div[hidden]"),
    ).toBeNull();
    expect(client.getQueryData<Session>(["session"])).toEqual(session);
  });

  it("reconciles authoritative identity after an uncertain auth success response", async () => {
    const client = createClient();
    seedUserCaches(client);
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(() => {
      expect(
        screen
          .getByRole("textbox", {
            name: "runtime identity-bound editor",
          })
          .closest("div[hidden][inert]"),
      ).not.toBeNull();
    });
    let resolveReconciliation!: (response: Response) => void;
    const reconciliationResponse = new Promise<Response>((resolve) => {
      resolveReconciliation = resolve;
    });
    let sessionRequests = 0;
    let authRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          return reconciliationResponse;
        }
        if (path === "/api/v1/test-auth-transition") {
          authRequests += 1;
          return authenticatedResponse(session.user.id, {
            user: { id: switchedSession.user.id },
            csrfToken: switchedSession.csrfToken,
          });
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <NetworkSessionTransitionProbe />
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    const user = userEvent.setup();
    const editor = await screen.findByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    await user.clear(editor);
    await user.type(editor, "old input before uncertain auth response");
    await user.click(
      screen.getByRole("button", { name: "認証transitionを開始" }),
    );

    await waitFor(() => expect(sessionRequests).toBe(2));
    expect(authRequests).toBe(1);
    expect(editor).toHaveValue("old input before uncertain auth response");
    expect(editor.closest("div[hidden][inert]")).not.toBeNull();
    expect(client.getQueryData<Session>(["session"])).toEqual(session);

    resolveReconciliation(sessionResponse(switchedSession));

    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-user")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(
      client.getQueryData(userHomeQueryKey(session.user.id)),
    ).toBeUndefined();
    expect(
      screen.getByRole("textbox", {
        name: "runtime identity-bound editor",
      }),
    ).toHaveValue("initial:" + switchedSession.user.id);
  });

  it("serializes auth dispatch ahead of recovery and drops the stale queued bootstrap", async () => {
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const client = createClient();
    const networkOrder: string[] = [];
    let resolveAuthRequest!: (response: Response) => void;
    const authResponse = new Promise<Response>((resolve) => {
      resolveAuthRequest = resolve;
    });
    let sessionRequests = 0;
    let anonymousRequests = 0;
    let authRequests = 0;
    let commandRequests = 0;
    let authCookieCommitted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          networkOrder.push("session-reconcile");
          return sessionResponse(
            authCookieCommitted ? switchedSession : session,
          );
        }
        if (path === "/api/v1/session/anonymous") {
          anonymousRequests += 1;
          return sessionResponse(latestSession);
        }
        if (path === "/api/v1/test-auth-transition") {
          authRequests += 1;
          networkOrder.push("auth-dispatch");
          expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe(
            session.csrfToken,
          );
          return authResponse;
        }
        if (path.includes("/test-command/expired/")) {
          commandRequests += 1;
          networkOrder.push("expiry-response");
          return errorResponse(401, "SESSION_EXPIRED");
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <NetworkSessionTransitionProbe />
        <RuntimeRecoveryProbe />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "認証transitionを開始" }),
    );
    await waitFor(() => expect(authRequests).toBe(1));
    await user.click(
      screen.getByRole("button", { name: "期限切れを並行送信" }),
    );
    await waitFor(() => expect(commandRequests).toBe(2));
    expect(sessionRequests).toBe(1);
    expect(anonymousRequests).toBe(0);

    networkOrder.push("auth-resolve");
    authCookieCommitted = true;
    resolveAuthRequest(authenticatedResponse(session.user.id, switchedSession));

    await waitFor(() =>
      expect(screen.getByTestId("network-transition-user")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    await Promise.resolve();
    expect(networkOrder).toEqual([
      "auth-dispatch",
      "expiry-response",
      "expiry-response",
      "auth-resolve",
      "session-reconcile",
    ]);
    expect(sessionRequests).toBe(2);
    expect(anonymousRequests).toBe(0);
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(client.getQueryData<Session>(["session"])).toEqual(switchedSession);
  });

  it("drops a late old-generation expiry that queues during an identity transition", async () => {
    const releaseQuiesce = deferredVoid();
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(async () => {
      await releaseQuiesce.promise;
    });
    const lateSettled = vi.fn();
    let resolveLateRequest!: (response: Response) => void;
    const lateRequest = new Promise<Response>((resolve) => {
      resolveLateRequest = resolve;
    });
    let sessionRequests = 0;
    let anonymousRequests = 0;
    let lateRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(session);
        }
        if (path === "/api/v1/session/anonymous") {
          anonymousRequests += 1;
          return sessionResponse(latestSession);
        }
        if (path === "/api/v1/late-old-command") {
          lateRequests += 1;
          return lateRequest;
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider(
      <>
        <SessionTransitionProbe nextSession={switchedSession} />
        <LateRequestProbe onSettled={lateSettled} />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
    );

    const user = userEvent.setup();
    expect(await screen.findByTestId("session-observation")).toHaveTextContent(
      session.user.id,
    );
    await user.click(screen.getByRole("button", { name: "旧requestを開始" }));
    await waitFor(() => expect(lateRequests).toBe(1));
    await user.click(screen.getByRole("button", { name: "セッションを置換" }));
    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());

    resolveLateRequest(errorResponse(401, "SESSION_EXPIRED"));
    await waitFor(() => expect(lateSettled).toHaveBeenCalledOnce());
    expect(screen.getByTestId("session-observation")).toHaveTextContent(
      session.user.id,
    );

    releaseQuiesce.resolve();
    await waitFor(() =>
      expect(screen.getByTestId("session-observation")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    expect(sessionRequests).toBe(1);
    expect(anonymousRequests).toBe(0);
  });

  it("registers recovery before mounting children from a preseeded session cache", async () => {
    const refreshedSession: Session = {
      user: session.user,
      csrfToken: "eager-refreshed-csrf-token",
    };
    const client = createClient();
    client.setQueryData(["session"], session);
    let sessionRequests = 0;
    let eagerRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/eager-command") {
          eagerRequests += 1;
          return errorResponse(403, "CSRF_INVALID");
        }
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(refreshedSession);
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider(<EagerRecoveryProbe />, client);

    await waitFor(() =>
      expect(screen.getByTestId("eager-session-csrf")).toHaveTextContent(
        refreshedSession.csrfToken,
      ),
    );
    expect(eagerRequests).toBe(1);
    expect(sessionRequests).toBe(1);
  });

  it("does not mount cached old-session children when remount recovery fails", async () => {
    const client = createClient();
    client.setQueryData(["session"], session);
    await client.invalidateQueries({
      queryKey: ["session"],
      exact: true,
      refetchType: "none",
    });
    const mountedUsers = vi.fn<(userId: string) => void>();
    let sessionRequests = 0;
    let childRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) {
            throw new TypeError("recovery unavailable");
          }
          return sessionResponse(switchedSession);
        }
        if (path === "/api/v1/recovery-mount-command") {
          childRequests += 1;
          return authenticatedVoidResponse(switchedSession.user.id);
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider(<RecoveryMountProbe onMount={mountedUsers} />, client);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セッションを再接続できませんでした。",
    );
    expect(sessionRequests).toBe(1);
    expect(mountedUsers).not.toHaveBeenCalled();
    expect(childRequests).toBe(0);
    expect(
      screen.queryByTestId("recovery-mounted-user"),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "再試行" }));

    expect(
      await screen.findByTestId("recovery-mounted-user"),
    ).toHaveTextContent(switchedSession.user.id);
    await waitFor(() => expect(childRequests).toBe(1));
    expect(sessionRequests).toBe(2);
    expect(mountedUsers).toHaveBeenCalledOnce();
    expect(mountedUsers).toHaveBeenCalledWith(switchedSession.user.id);
  });

  it("hands an in-flight recovery to a remounted provider without publishing the stale response", async () => {
    const firstLifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const secondLifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const client = createClient();
    seedUserCaches(client);
    const publishedUserIds: string[] = [];
    const unsubscribeCache = client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey.length === 1 &&
        event.query.queryKey[0] === "session"
      ) {
        const publishedSession = event.query.state.data as Session | undefined;
        if (publishedSession !== undefined) {
          publishedUserIds.push(publishedSession.user.id);
        }
      }
    });
    let resolveStaleAnonymous!: (response: Response) => void;
    const staleAnonymousResponse = new Promise<Response>((resolve) => {
      resolveStaleAnonymous = resolve;
    });
    let sessionRequests = 0;
    let anonymousRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          if (sessionRequests === 2) {
            return errorResponse(401, "SESSION_EXPIRED");
          }
          if (sessionRequests === 3) return sessionResponse(session);
          return sessionResponse(latestSession);
        }
        if (path === "/api/v1/session/anonymous") {
          anonymousRequests += 1;
          return staleAnonymousResponse;
        }
        if (path.startsWith("/api/v1/test-command/")) {
          return errorResponse(401, "SESSION_EXPIRED");
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    const firstProvider = render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <SessionIdentityBoundary>
            <RuntimeRecoveryProbe />
            <AutoSaveScopeProbe
              onLease={() => undefined}
              onQuiesce={firstLifecycle}
            />
          </SessionIdentityBoundary>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await screen.findByTestId("runtime-session-user");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "期限切れを並行送信" }));
    await waitFor(() => expect(anonymousRequests).toBe(1));
    expect(firstLifecycle).toHaveBeenCalledOnce();

    firstProvider.unmount();
    render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <SessionIdentityBoundary>
            <RuntimeRecoveryProbe />
            <AutoSaveScopeProbe
              onLease={() => undefined}
              onQuiesce={secondLifecycle}
            />
          </SessionIdentityBoundary>
        </SessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(sessionRequests).toBe(3));
    expect(await screen.findByTestId("runtime-session-user")).toHaveTextContent(
      session.user.id,
    );

    resolveStaleAnonymous(sessionResponse(switchedSession));

    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-user")).toHaveTextContent(
        latestSession.user.id,
      ),
    );
    expect(sessionRequests).toBe(4);
    expect(anonymousRequests).toBe(1);
    expect(secondLifecycle).toHaveBeenCalledOnce();
    expect(publishedUserIds).not.toContain(switchedSession.user.id);
    expect(client.getQueryData<Session>(["session"])).toEqual(latestSession);
    expect(
      client.getQueryData(userHomeQueryKey(session.user.id)),
    ).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    unsubscribeCache();
  });

  it("rejects concurrent B responses under A, fences A, and converges through one recovery", async () => {
    const releaseQuiesce = deferredVoid();
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(async () => {
      await releaseQuiesce.promise;
    });
    const requestLeases: AuthenticatedRequestLease[] = [];
    const client = createClient();
    seedUserCaches(client);
    let sessionRequests = 0;
    let protectedRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(
            sessionRequests === 1 ? session : switchedSession,
          );
        }
        if (path.startsWith("/api/v1/drift-command")) {
          protectedRequests += 1;
          return authenticatedResponse(switchedSession.user.id, {
            owner: switchedSession.user.id,
          });
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <AuthenticatedResponseProbe
          path="/api/v1/drift-command"
          requests={2}
          onLease={(lease) => requestLeases.push(lease)}
        />
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    const requestButton = await screen.findByRole("button", {
      name: "identity-bound request",
    });
    await userEvent.click(requestButton);

    await waitFor(() => expect(protectedRequests).toBe(2));
    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());
    expect(requestLeases).toHaveLength(1);
    expect(requestLeases[0]?.isCurrent()).toBe(false);
    expect(requestLeases[0]?.signal.aborted).toBe(true);
    expect(requestButton.closest("div[hidden][inert]")).not.toBeNull();
    expect(sessionRequests).toBe(1);
    expect(
      client.getQueryData(["user", session.user.id, "bound-response"]),
    ).toBeUndefined();

    releaseQuiesce.resolve();

    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-user")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    await waitFor(() => expect(requestLeases).toHaveLength(2));
    expect(sessionRequests).toBe(2);
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(requestLeases[1]?.isCurrent()).toBe(true);
    expect(
      client.getQueryData(userHomeQueryKey(session.user.id)),
    ).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("keeps A hidden with an aborted lease when drift discovery fails", async () => {
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const requestLeases: AuthenticatedRequestLease[] = [];
    const client = createClient();
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          if (sessionRequests === 1) return sessionResponse(session);
          throw new TypeError("private discovery failure");
        }
        if (path.startsWith("/api/v1/drift-failure")) {
          return authenticatedResponse(switchedSession.user.id, {
            owner: switchedSession.user.id,
          });
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <AuthenticatedResponseProbe
          path="/api/v1/drift-failure"
          onLease={(lease) => requestLeases.push(lease)}
        />
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
    );

    const requestButton = await screen.findByRole("button", {
      name: "identity-bound request",
    });
    await userEvent.click(requestButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セッションを再接続できませんでした。",
    );
    expect(requestButton.closest("div[hidden][inert]")).not.toBeNull();
    expect(requestLeases[0]?.isCurrent()).toBe(false);
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(sessionRequests).toBe(2);
    expect(client.getQueryData<Session>(["session"])).toEqual(session);
    expect(
      client.getQueryData(["user", session.user.id, "bound-response"]),
    ).toBeUndefined();
  });

  it("fails closed without automatic discovery when identity is unverified", async () => {
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const reloadApplication = vi.fn();
    const requestLeases: AuthenticatedRequestLease[] = [];
    const advisory = createAdvisoryChannelHarness();
    const client = createClient();
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(session);
        }
        if (path.startsWith("/api/v1/unverified-command")) {
          return Response.json({ owner: switchedSession.user.id });
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <AuthenticatedResponseProbe
          path="/api/v1/unverified-command"
          onLease={(lease) => requestLeases.push(lease)}
        />
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
      {
        reloadApplication,
        advisoryFactory: () => advisory.channel,
      },
    );

    const requestButton = await screen.findByRole("button", {
      name: "identity-bound request",
    });
    await userEvent.click(requestButton);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "セッションを安全に確認できませんでした。再読み込みしてください。",
    );
    expect(requestButton.closest("div[hidden][inert]")).not.toBeNull();
    expect(requestLeases[0]?.isCurrent()).toBe(false);
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(sessionRequests).toBe(1);
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();
    await Promise.resolve();
    expect(sessionRequests).toBe(1);
    expect(
      client.getQueryData(["user", session.user.id, "bound-response"]),
    ).toBeUndefined();

    await act(async () => {
      await Promise.resolve();
      advisory.dispatch({ version: 1, targetUserId: switchedSession.user.id });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sessionRequests).toBe(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "セッションを安全に確認できませんでした。再読み込みしてください。",
    );
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(reloadApplication).toHaveBeenCalledOnce();
  });

  it("stops the old lease synchronously on a different-user advisory", async () => {
    const releaseQuiesce = deferredVoid();
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(async () => {
      await releaseQuiesce.promise;
    });
    const requestLeases: AuthenticatedRequestLease[] = [];
    const advisory = createAdvisoryChannelHarness();
    const advisoryFactory: SessionIdentityAdvisoryFactory = () =>
      advisory.channel;
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(
            sessionRequests === 1 ? session : switchedSession,
          );
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <AuthenticatedResponseProbe
          path="/unused"
          onLease={(lease) => requestLeases.push(lease)}
        />
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      createClient(),
      { advisoryFactory },
    );

    const editor = await screen.findByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    act(() => {
      advisory.dispatch({
        version: 1,
        targetUserId: switchedSession.user.id,
      });
    });

    expect(requestLeases[0]?.isCurrent()).toBe(false);
    expect(requestLeases[0]?.signal.aborted).toBe(true);
    expect(editor.closest("div[hidden][inert]")).not.toBeNull();
    expect(sessionRequests).toBe(1);
    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());

    releaseQuiesce.resolve();
    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-user")).toHaveTextContent(
        switchedSession.user.id,
      ),
    );
    expect(sessionRequests).toBe(2);
  });

  it("stops a deleted-account lease synchronously and discards drafts before reloading", async () => {
    const releaseQuiesce = deferredVoid();
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>(
      async ({ preserveDrafts }) => {
        expect(preserveDrafts).toBe(false);
        await releaseQuiesce.promise;
      },
    );
    const requestLeases: AuthenticatedRequestLease[] = [];
    const advisory = createAdvisoryChannelHarness();
    const reloadApplication = vi.fn();
    const client = createClient();
    stubSession(session);

    renderProvider(
      <>
        <AuthenticatedResponseProbe
          path="/unused"
          onLease={(lease) => requestLeases.push(lease)}
        />
        <RuntimeRecoveryProbe showEditor />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      client,
      {
        accountDeletionAdvisoryFactory: () => advisory.channel,
        reloadApplication,
      },
    );

    const editor = await screen.findByRole("textbox", {
      name: "runtime identity-bound editor",
    });
    act(() => {
      advisory.dispatch({
        version: 1,
        deletedUserId: switchedSession.user.id,
      });
    });
    expect(requestLeases[0]?.isCurrent()).toBe(true);
    expect(lifecycle).not.toHaveBeenCalled();
    expect(clearUserDraftsMock).not.toHaveBeenCalled();

    act(() => {
      advisory.dispatch({ version: 1, deletedUserId: session.user.id });
    });
    expect(requestLeases[0]?.isCurrent()).toBe(false);
    expect(requestLeases[0]?.signal.aborted).toBe(true);
    expect(editor.closest("div[hidden][inert]")).not.toBeNull();
    expect(clearUserDraftsMock).not.toHaveBeenCalled();
    expect(reloadApplication).not.toHaveBeenCalled();
    await waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());

    act(() => releaseQuiesce.resolve());

    await waitFor(() =>
      expect(clearUserDraftsMock).toHaveBeenCalledWith(session.user.id),
    );
    await waitFor(() => expect(reloadApplication).toHaveBeenCalledOnce());
    expect(client.getQueryData<Session>(["session"])).toEqual(session);
  });

  it("treats a same-user advisory as a weak CSRF refresh", async () => {
    const refreshedSession: Session = {
      ...session,
      csrfToken: "advisory-refreshed-csrf",
    };
    const lifecycle = vi.fn<AutoSaveQuiesceCallback>();
    const requestLeases: AuthenticatedRequestLease[] = [];
    const advisory = createAdvisoryChannelHarness();
    const advisoryFactory: SessionIdentityAdvisoryFactory = () =>
      advisory.channel;
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(
            sessionRequests === 1 ? session : refreshedSession,
          );
        }
        throw new Error("unexpected request: " + path);
      }),
    );

    renderProvider(
      <>
        <AuthenticatedResponseProbe
          path="/unused"
          onLease={(lease) => requestLeases.push(lease)}
        />
        <RuntimeRecoveryProbe />
        <AutoSaveScopeProbe onLease={() => undefined} onQuiesce={lifecycle} />
      </>,
      createClient(),
      { advisoryFactory },
    );

    await screen.findByTestId("runtime-session-csrf");
    act(() => {
      advisory.dispatch({ version: 1, targetUserId: session.user.id });
    });

    await waitFor(() =>
      expect(screen.getByTestId("runtime-session-csrf")).toHaveTextContent(
        refreshedSession.csrfToken,
      ),
    );
    expect(sessionRequests).toBe(2);
    expect(lifecycle).not.toHaveBeenCalled();
    expect(requestLeases).toHaveLength(1);
    expect(requestLeases[0]?.isCurrent()).toBe(true);
  });

  it("closes every StrictMode advisory subscription exactly once", async () => {
    stubSession(session);
    const advisories: ReturnType<typeof createAdvisoryChannelHarness>[] = [];
    const advisoryFactory: SessionIdentityAdvisoryFactory = () => {
      const advisory = createAdvisoryChannelHarness();
      advisories.push(advisory);
      return advisory.channel;
    };
    const rendered = render(
      <StrictMode>
        <QueryClientProvider client={createClient()}>
          <SessionProvider advisoryFactory={advisoryFactory}>
            <SessionIdentityBoundary>
              <p>strict advisory ready</p>
            </SessionIdentityBoundary>
          </SessionProvider>
        </QueryClientProvider>
      </StrictMode>,
    );

    expect(
      await screen.findByText("strict advisory ready"),
    ).toBeInTheDocument();
    rendered.unmount();

    expect(advisories.length).toBeGreaterThanOrEqual(2);
    for (const advisory of advisories) {
      expect(advisory.addEventListener).toHaveBeenCalledOnce();
      expect(advisory.removeEventListener).toHaveBeenCalledOnce();
      expect(advisory.close).toHaveBeenCalledOnce();
    }
  });

  it("unsubscribes the recovery listener across StrictMode cleanup and unmount", async () => {
    let sessionRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          sessionRequests += 1;
          return sessionResponse(session);
        }
        if (path === "/api/v1/after-unmount-command") {
          return errorResponse(401, "SESSION_EXPIRED");
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const client = createClient();
    const rendered = render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <SessionProvider>
            <SessionIdentityBoundary>
              <p>strict application ready</p>
            </SessionIdentityBoundary>
          </SessionProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(
      await screen.findByText("strict application ready"),
    ).toBeInTheDocument();

    rendered.unmount();
    sessionRecoveryEvents.capturePublisher()("SESSION_EXPIRED");
    await Promise.resolve();

    expect(sessionRequests).toBe(1);
    expect(client.getQueryData<Session>(["session"])).toEqual(session);
  });
});

function OperationLeaseProbe({
  onObserve,
}: {
  readonly onObserve: (
    operation: "transition" | "terminal",
    expectedUserId: string,
    sameLease: boolean,
    current: boolean,
  ) => void;
}) {
  const currentSession = useSession();
  const contextLease = useAuthenticatedRequestLease();
  const runSessionTransition = useRunSessionTransition();
  const runTerminalSessionOperation = useRunTerminalSessionOperation();

  async function run() {
    await runSessionTransition(
      currentSession.user.id,
      async (latestSession, lease) => {
        onObserve(
          "transition",
          lease.expectedUserId,
          lease === contextLease,
          lease.isCurrent(),
        );
        return { ...latestSession, csrfToken: "transition-csrf" };
      },
    );
    await runTerminalSessionOperation(
      currentSession.user.id,
      async (_latestSession, lease, ownership) => {
        onObserve(
          "terminal",
          lease.expectedUserId,
          lease === contextLease,
          lease.isCurrent() && ownership.isCurrent(),
        );
      },
    );
  }

  return (
    <button type="button" onClick={() => void run()}>
      lease operations
    </button>
  );
}

const boundPayloadSchema = z.object({ owner: z.string() });

function AuthenticatedResponseProbe({
  path,
  onLease,
  requests = 1,
}: {
  readonly path: string;
  readonly onLease: (lease: AuthenticatedRequestLease) => void;
  readonly requests?: number;
}) {
  const currentSession = useSession();
  const requestLease = useAuthenticatedRequestLease();
  const queryClient = useQueryClient();

  useLayoutEffect(() => {
    onLease(requestLease);
  }, [onLease, requestLease]);

  function start() {
    for (let index = 0; index < requests; index += 1) {
      void requestAuthenticatedJSON(
        requestLease,
        `${path}?request=${index}`,
        boundPayloadSchema,
      )
        .then((payload) => {
          queryClient.setQueryData(
            ["user", currentSession.user.id, "bound-response"],
            payload,
          );
        })
        .catch(() => undefined);
    }
  }

  return (
    <button type="button" onClick={start}>
      identity-bound request
    </button>
  );
}

function createAdvisoryChannelHarness() {
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const postMessage = vi.fn();
  const addEventListener = vi.fn(
    (
      _type: "message",
      listener: (event: { readonly data: unknown }) => void,
    ) => {
      listeners.add(listener);
    },
  );
  const removeEventListener = vi.fn(
    (
      _type: "message",
      listener: (event: { readonly data: unknown }) => void,
    ) => {
      listeners.delete(listener);
    },
  );
  const close = vi.fn();
  const channel: SessionIdentityAdvisoryChannelLike &
    AccountDeletionAdvisoryChannelLike = {
    postMessage,
    addEventListener,
    removeEventListener,
    close,
  };
  return {
    channel,
    postMessage,
    addEventListener,
    removeEventListener,
    close,
    dispatch(data: unknown) {
      for (const listener of listeners) listener({ data });
    },
  };
}

function RuntimeRecoveryProbe({
  showEditor = false,
}: {
  showEditor?: boolean;
}) {
  const currentSession = useSession();
  const requestLease = useAuthenticatedRequestLease();

  function sendConcurrentFailures(
    code: "SESSION_MISSING" | "SESSION_EXPIRED" | "CSRF_INVALID",
  ) {
    const suffix =
      code === "SESSION_MISSING"
        ? "missing"
        : code === "SESSION_EXPIRED"
          ? "expired"
          : "csrf";
    void Promise.allSettled([
      requestAuthenticatedJSON(
        requestLease,
        `/api/v1/test-command/${suffix}/1`,
        z.undefined(),
        {
          method: "POST",
          csrfToken: currentSession.csrfToken,
        },
      ),
      requestAuthenticatedJSON(
        requestLease,
        `/api/v1/test-command/${suffix}/2`,
        z.undefined(),
        {
          method: "POST",
          csrfToken: currentSession.csrfToken,
        },
      ),
    ]);
  }

  return (
    <>
      <p data-testid="runtime-session-user">{currentSession.user.id}</p>
      <p data-testid="runtime-session-csrf">{currentSession.csrfToken}</p>
      <button
        type="button"
        onClick={() => sendConcurrentFailures("SESSION_EXPIRED")}
      >
        期限切れを並行送信
      </button>
      <button
        type="button"
        onClick={() => sendConcurrentFailures("SESSION_MISSING")}
      >
        セッション欠落を並行送信
      </button>
      <button
        type="button"
        onClick={() => sendConcurrentFailures("CSRF_INVALID")}
      >
        CSRF失敗を並行送信
      </button>
      {showEditor ? (
        <RuntimeIdentityBoundEditor userId={currentSession.user.id} />
      ) : null}
    </>
  );
}

function EagerRecoveryProbe() {
  const currentSession = useSession();
  const requestLease = useAuthenticatedRequestLease();
  const requestStarted = useRef(false);

  useLayoutEffect(() => {
    if (requestStarted.current) return;
    requestStarted.current = true;
    void requestAuthenticatedJSON(
      requestLease,
      "/api/v1/eager-command",
      z.undefined(),
      {
        method: "POST",
        csrfToken: currentSession.csrfToken,
      },
    ).catch(() => undefined);
  }, [currentSession.csrfToken, requestLease]);

  return <p data-testid="eager-session-csrf">{currentSession.csrfToken}</p>;
}

function RecoveryMountProbe({
  onMount,
}: {
  readonly onMount: (userId: string) => void;
}) {
  const currentSession = useSession();
  const requestLease = useAuthenticatedRequestLease();

  useLayoutEffect(() => {
    onMount(currentSession.user.id);
    void requestAuthenticatedJSON(
      requestLease,
      "/api/v1/recovery-mount-command",
      z.undefined(),
      {
        method: "POST",
        csrfToken: currentSession.csrfToken,
      },
    ).catch(() => undefined);
  }, [currentSession.csrfToken, currentSession.user.id, onMount, requestLease]);

  return <p data-testid="recovery-mounted-user">{currentSession.user.id}</p>;
}

function NetworkSessionTransitionProbe() {
  const currentSession = useSession();
  const runSessionTransition = useRunSessionTransition();

  function startTransition() {
    void runSessionTransition(currentSession.user.id, (latestSession, lease) =>
      requestAuthenticatedJSON(
        lease,
        "/api/v1/test-auth-transition",
        sessionSchema,
        {
          method: "POST",
          csrfToken: latestSession.csrfToken,
        },
      ),
    ).catch(() => undefined);
  }

  return (
    <>
      <p data-testid="network-transition-user">{currentSession.user.id}</p>
      <button type="button" onClick={startTransition}>
        認証transitionを開始
      </button>
    </>
  );
}

function LateRequestProbe({ onSettled }: { onSettled: () => void }) {
  const currentSession = useSession();
  const requestLease = useAuthenticatedRequestLease();

  function startRequest() {
    void requestAuthenticatedJSON(
      requestLease,
      "/api/v1/late-old-command",
      z.undefined(),
      {
        method: "POST",
        csrfToken: currentSession.csrfToken,
      },
    )
      .catch(() => undefined)
      .finally(onSettled);
  }

  return (
    <button type="button" onClick={startRequest}>
      旧requestを開始
    </button>
  );
}

function RuntimeIdentityBoundEditor({ userId }: { userId: string }) {
  const [value, setValue] = useState(`initial:${userId}`);
  return (
    <label>
      runtime identity-bound editor
      <input
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
    </label>
  );
}

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderProvider(
  children: ReactNode = <p>application ready</p>,
  client = createClient(),
  options: {
    readonly reloadApplication?: () => void;
    readonly advisoryFactory?: SessionIdentityAdvisoryFactory;
    readonly accountDeletionAdvisoryFactory?: AccountDeletionAdvisoryFactory;
  } = {},
) {
  render(
    <QueryClientProvider client={client}>
      <SessionProvider
        {...(options.reloadApplication === undefined
          ? {}
          : { reloadApplication: options.reloadApplication })}
        {...(options.advisoryFactory === undefined
          ? {}
          : { advisoryFactory: options.advisoryFactory })}
        {...(options.accountDeletionAdvisoryFactory === undefined
          ? {}
          : {
              accountDeletionAdvisoryFactory:
                options.accountDeletionAdvisoryFactory,
            })}
      >
        <SessionIdentityBoundary>{children}</SessionIdentityBoundary>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function stubSession(value: Session) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/api/v1/session") {
        return sessionResponse(value);
      }
      throw new Error(`unexpected request: ${path}`);
    }),
  );
}

function seedUserCaches(client: QueryClient) {
  const cachedHome = { owner: session.user.id };
  client.setQueryData(userHomeQueryKey(session.user.id), cachedHome);
  const cachedMutation = client.getMutationCache().build(client, {
    mutationKey: ["user", session.user.id, "save-goal-draft"],
    mutationFn: async () => ({ owner: session.user.id }),
  });
  return { cachedHome, cachedMutation };
}

function userHomeQueryKey(userId: string) {
  return ["user", userId, "home"] as const;
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = () => promiseResolve(undefined);
  });
  return { promise, resolve };
}

function SessionTransitionProbe({
  nextSession,
  showEditor = false,
}: {
  nextSession: Session;
  showEditor?: boolean;
}) {
  const currentSession = useSession();
  const runSessionTransition = useRunSessionTransition();
  const queryClient = useQueryClient();
  const nonSessionQueryCount = queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] !== "session").length;
  const mutationCount = queryClient.getMutationCache().getAll().length;

  async function replace() {
    await runSessionTransition(currentSession.user.id, async () => nextSession);
  }

  return (
    <>
      <p data-testid="session-observation">
        {currentSession.user.id}|{currentSession.csrfToken}|
        {nonSessionQueryCount}|{mutationCount}
      </p>
      <button
        type="button"
        onClick={() => void replace().catch(() => undefined)}
      >
        セッションを置換
      </button>
      {showEditor ? (
        <IdentityBoundEditor userId={currentSession.user.id} />
      ) : null}
    </>
  );
}

function QueuedSessionTransitionProbe({
  firstSession,
  onSecondRequest,
}: {
  firstSession: Session;
  onSecondRequest: () => Promise<Session>;
}) {
  const currentSession = useSession();
  const runSessionTransition = useRunSessionTransition();

  function replaceConcurrently() {
    void runSessionTransition(
      currentSession.user.id,
      async () => firstSession,
    ).catch(() => undefined);
    void runSessionTransition(currentSession.user.id, onSecondRequest).catch(
      () => undefined,
    );
  }

  return (
    <>
      <p data-testid="queued-session-user">{currentSession.user.id}</p>
      <button type="button" onClick={replaceConcurrently}>
        置換を連続実行
      </button>
    </>
  );
}

function SequentialSessionTransitionProbe({
  firstSession,
  secondSession,
}: {
  firstSession: Session;
  secondSession: Session;
}) {
  const currentSession = useSession();
  const runSessionTransition = useRunSessionTransition();
  const nextSession =
    currentSession.user.id === firstSession.user.id
      ? secondSession
      : firstSession;

  return (
    <>
      <p data-testid="sequential-session-user">{currentSession.user.id}</p>
      <button
        type="button"
        onClick={() =>
          void runSessionTransition(
            currentSession.user.id,
            async () => nextSession,
          )
        }
      >
        次のセッションへ置換
      </button>
    </>
  );
}

function IdentityBoundEditor({ userId }: { userId: string }) {
  const [value, setValue] = useState(`initial:${userId}`);
  return (
    <label>
      identity-bound editor
      <input
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
    </label>
  );
}

function AutoSaveScopeProbe({
  onLease,
  onQuiesce,
}: {
  readonly onLease: (lease: AutoSaveScopeLease) => void;
  readonly onQuiesce: AutoSaveQuiesceCallback;
}) {
  const session = useSession();
  const registry = useAutoSaveScopeRegistry();
  const lease = useMemo(
    () => registry.prepare("identity:" + session.user.id),
    [registry, session.user.id],
  );

  useLayoutEffect(() => {
    lease.activate();
    onLease(lease);
    return lease.onQuiesce(onQuiesce);
  }, [lease, onLease, onQuiesce]);

  return null;
}

function sessionResponse(value: Session): Response {
  return authenticatedResponse(value.user.id, value);
}

function authenticatedResponse(
  authenticatedUserId: string,
  payload: unknown,
): Response {
  return Response.json(payload, {
    headers: {
      "X-Fukamu-Authenticated-User-ID": authenticatedUserId,
    },
  });
}

function authenticatedVoidResponse(authenticatedUserId: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "X-Fukamu-Authenticated-User-ID": authenticatedUserId,
    },
  });
}

function errorResponse(status: number, code: string): Response {
  const headers =
    status === 403 && code === "CSRF_INVALID"
      ? { "X-Fukamu-Authenticated-User-ID": session.user.id }
      : undefined;
  return Response.json(
    { error: { code, message: "error", requestId: requestID } },
    headers === undefined ? { status } : { status, headers },
  );
}
