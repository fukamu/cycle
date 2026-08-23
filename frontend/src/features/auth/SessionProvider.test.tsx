import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { Session } from "../../shared/api/schemas";
import {
  type AutoSaveQuiesceCallback,
  type AutoSaveScopeLease,
  useAutoSaveScopeRegistry,
} from "../../shared/autosave/AutoSaveScopeProvider";
import { cleanupExpiredBrowserDrafts } from "../../shared/drafts/browserDraftCache";
import { SessionProvider } from "./SessionProvider";
import { useReplaceSession, useSession } from "./sessionContext";

vi.mock("../../shared/drafts/browserDraftCache", () => ({
  cleanupExpiredBrowserDrafts: vi.fn(),
}));

const cleanupExpiredBrowserDraftsMock = vi.mocked(cleanupExpiredBrowserDrafts);

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
  cleanupExpiredBrowserDraftsMock.mockReset();
  cleanupExpiredBrowserDraftsMock.mockResolvedValue(undefined);
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
          return Response.json(session);
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
          return Response.json(session);
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

  it("starts browser draft cleanup once without blocking startup when cleanup fails", async () => {
    cleanupExpiredBrowserDraftsMock.mockRejectedValueOnce(
      new Error("IndexedDB is unavailable"),
    );
    stubSession(session);

    render(
      <StrictMode>
        <QueryClientProvider client={createClient()}>
          <SessionProvider>
            <p>application ready</p>
          </SessionProvider>
        </QueryClientProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("application ready")).toBeInTheDocument();
    expect(cleanupExpiredBrowserDraftsMock).toHaveBeenCalledOnce();
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
        await releaseQuiesce.promise;
      },
    );
    let oldLease: AutoSaveScopeLease | undefined;

    renderProvider(
      <>
        <SessionTransitionProbe nextSession={switchedSession} />
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

  it("serializes concurrent replacements and re-reads the current identity", async () => {
    stubSession(session);
    const client = createClient();
    const firstCancellation = deferredVoid();
    const secondCancellation = deferredVoid();
    const cancelQueries = vi
      .spyOn(client, "cancelQueries")
      .mockReturnValueOnce(firstCancellation.promise)
      .mockReturnValueOnce(secondCancellation.promise);

    renderProvider(
      <QueuedSessionTransitionProbe
        firstSession={switchedSession}
        secondSession={latestSession}
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
      expect(cancelQueries).toHaveBeenNthCalledWith(2, {
        queryKey: ["user", switchedSession.user.id],
      }),
    );
    expect(client.getQueryData<Session>(["session"])).toEqual(switchedSession);

    secondCancellation.resolve();
    await waitFor(() =>
      expect(screen.getByTestId("queued-session-user")).toHaveTextContent(
        latestSession.user.id,
      ),
    );
    expect(client.getQueryData<Session>(["session"])).toEqual(latestSession);
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

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderProvider(
  children: ReactNode = <p>application ready</p>,
  client = createClient(),
) {
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>,
  );
}

function stubSession(value: Session) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/api/v1/session") {
        return Response.json(value);
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
  const replaceSession = useReplaceSession();
  const queryClient = useQueryClient();
  const nonSessionQueryCount = queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] !== "session").length;
  const mutationCount = queryClient.getMutationCache().getAll().length;

  async function replace() {
    await replaceSession(nextSession);
  }

  return (
    <>
      <p data-testid="session-observation">
        {currentSession.user.id}|{currentSession.csrfToken}|
        {nonSessionQueryCount}|{mutationCount}
      </p>
      <button type="button" onClick={() => void replace()}>
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
  secondSession,
}: {
  firstSession: Session;
  secondSession: Session;
}) {
  const currentSession = useSession();
  const replaceSession = useReplaceSession();

  function replaceConcurrently() {
    void replaceSession(firstSession);
    void replaceSession(secondSession);
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

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "error", requestId: requestID } },
    { status },
  );
}
