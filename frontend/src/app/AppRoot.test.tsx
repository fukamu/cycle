import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";

import type { AuthenticatedRequestLease } from "../shared/api/client";
import type { PostCommitSessionOwnershipToken } from "../shared/cleanup/postCommitCleanupContext";
import type { Session } from "../shared/api/schemas";
import { AppRoot } from "./AppRoot";

const appRootMocks = vi.hoisted(() => ({
  appShouldThrow: false,
  providerShouldThrow: false,
  routeModuleShouldThrow: false,
  sessionMounts: 0,
  sessionUnmounts: 0,
}));

vi.mock(
  "../features/auth/SessionTransitionNoticeProvider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../features/auth/SessionTransitionNoticeProvider")
      >();
    return {
      ...actual,
      SessionTransitionNoticeProvider({ children }: PropsWithChildren) {
        return (
          <section data-testid="notice-provider">
            <actual.SessionTransitionNoticeProvider>
              {children}
            </actual.SessionTransitionNoticeProvider>
          </section>
        );
      },
    };
  },
);

vi.mock("../features/auth/SessionProvider", async () => {
  const { createContext, useContext, useEffect, useMemo, useState } =
    await import("react");
  const {
    AuthenticatedRequestLeaseContext,
    RunTerminalSessionOperationContext,
    RunPostCommitSessionOperationContext,
    RunSessionTransitionContext,
    SessionContext,
  } = await import("../features/auth/sessionContext");
  const { AccountDeletionAdvisoryPublishContext } =
    await import("../features/auth/accountDeletionContext");
  const { AutoSaveScopeProvider } =
    await import("../shared/autosave/AutoSaveScopeProvider");
  const SessionOwnerContext = createContext<{
    readonly session: Session;
    readonly setSession: (session: Session) => void;
    readonly lease: AuthenticatedRequestLease;
  } | null>(null);

  const initialSession: Session = {
    user: {
      id: "00000000-0000-7000-8000-000000000001",
      googleConnected: false,
      googleEmail: null,
    },
    csrfToken: "old-csrf",
  };
  return {
    SessionProvider({ children }: PropsWithChildren) {
      const [session, setSession] = useState(initialSession);
      const lease = useMemo<AuthenticatedRequestLease>(() => {
        const abortController = new AbortController();
        return {
          expectedUserId: session.user.id,
          signal: abortController.signal,
          isCurrent: () => !abortController.signal.aborted,
        };
      }, [session.user.id]);
      useEffect(() => {
        appRootMocks.sessionMounts += 1;
        return () => {
          appRootMocks.sessionUnmounts += 1;
        };
      }, []);
      if (appRootMocks.providerShouldThrow) {
        throw new Error("provider private failure");
      }
      const runTerminalSessionOperation = async <Result,>(
        expectedUserId: string,
        operation: (
          currentSession: Session,
          currentLease: AuthenticatedRequestLease,
          ownership: PostCommitSessionOwnershipToken,
        ) => Promise<Result>,
      ) => {
        if (session.user.id !== expectedUserId) {
          throw new Error("session operation interrupted");
        }
        const ownership = Object.freeze({
          isCurrent: () => session.user.id === expectedUserId,
        }) as PostCommitSessionOwnershipToken;
        return operation(session, lease, ownership);
      };
      const runPostCommitSessionOperation = async <Result,>(
        expectedUserId: string,
        operation: (identityIsCurrent: () => boolean) => Promise<Result>,
      ) => operation(() => session.user.id === expectedUserId);
      const runSessionTransition = async (
        _expectedUserId: string,
        request: (
          currentSession: Session,
          currentLease: AuthenticatedRequestLease,
        ) => Promise<Session>,
      ) => {
        const previousSession = session;
        const nextSession = await request(previousSession, lease);
        setSession(nextSession);
        return { previousSession, session: nextSession };
      };
      return (
        <AutoSaveScopeProvider>
          <AccountDeletionAdvisoryPublishContext.Provider
            value={() => undefined}
          >
            <RunTerminalSessionOperationContext.Provider
              value={runTerminalSessionOperation}
            >
              <RunPostCommitSessionOperationContext.Provider
                value={runPostCommitSessionOperation}
              >
                <RunSessionTransitionContext.Provider
                  value={runSessionTransition}
                >
                  <SessionOwnerContext.Provider
                    value={{ session, setSession, lease }}
                  >
                    <section data-testid="session-provider">{children}</section>
                  </SessionOwnerContext.Provider>
                </RunSessionTransitionContext.Provider>
              </RunPostCommitSessionOperationContext.Provider>
            </RunTerminalSessionOperationContext.Provider>
          </AccountDeletionAdvisoryPublishContext.Provider>
        </AutoSaveScopeProvider>
      );
    },
    SessionIdentityBoundary({ children }: PropsWithChildren) {
      const owner = useContext(SessionOwnerContext);
      if (owner === null) {
        throw new Error("missing mock session owner");
      }
      return (
        <SessionContext.Provider
          key={owner.session.user.id}
          value={owner.session}
        >
          <AuthenticatedRequestLeaseContext.Provider value={owner.lease}>
            <section data-testid="session-identity-boundary">
              {children}
            </section>
          </AuthenticatedRequestLeaseContext.Provider>
        </SessionContext.Provider>
      );
    },
  };
});

vi.mock("./App", async () => {
  const { Link } = await import("react-router-dom");
  const { RouteModuleLoadError } = await import("./routeModuleLoader");
  const { useAccountSwitchNotice, useAnnounceAccountSwitch } =
    await import("../features/auth/sessionTransitionNoticeContext");
  const { useRunSessionTransition, useSession } =
    await import("../features/auth/sessionContext");
  const nextSession: Session = {
    user: {
      id: "00000000-0000-7000-8000-000000000002",
      googleConnected: true,
      googleEmail: "user@example.test",
    },
    csrfToken: "new-csrf",
  };
  return {
    App() {
      const session = useSession();
      const runSessionTransition = useRunSessionTransition();
      const announceAccountSwitch = useAnnounceAccountSwitch();
      const accountSwitchNotice = useAccountSwitchNotice(session.user.id);

      if (appRootMocks.appShouldThrow) {
        throw new Error("application private failure");
      }
      if (appRootMocks.routeModuleShouldThrow) {
        throw new RouteModuleLoadError();
      }
      const switchIdentity = async () => {
        const previousUserId = session.user.id;
        await runSessionTransition(session.user.id, async () => nextSession);
        announceAccountSwitch(previousUserId, nextSession.user.id);
      };
      return (
        <>
          <button type="button" onClick={() => void switchIdentity()}>
            アカウントを切り替える
          </button>
          <p data-testid="application">{session.user.id}</p>
          <Link to="/legal/privacy">データの取扱いへ移動</Link>
          {accountSwitchNotice && (
            <p role="status">既存のアカウントへ切り替えました。</p>
          )}
        </>
      );
    },
  };
});

describe("AppRoot production composition", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("VITE_PRIVACY_OPERATOR_NAME", "Example Cycle Operator");
    vi.stubEnv(
      "VITE_PRIVACY_CONTACT_URL",
      "https://support.example.test/cycle",
    );
    vi.stubEnv("VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS", "30");
    window.history.replaceState(null, "", "/");
    appRootMocks.appShouldThrow = false;
    appRootMocks.providerShouldThrow = false;
    appRootMocks.routeModuleShouldThrow = false;
    appRootMocks.sessionMounts = 0;
    appRootMocks.sessionUnmounts = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  });

  it("renders the public information route without mounting session or request boundaries", () => {
    window.history.replaceState(null, "", "/legal/privacy");
    const fetchRequest = vi.spyOn(globalThis, "fetch");

    try {
      render(<AppRoot />);

      expect(
        screen.getByRole("heading", {
          name: "データの取扱いとお問い合わせ",
        }),
      ).toBeInTheDocument();
      expect(appRootMocks.sessionMounts).toBe(0);
      expect(screen.queryByTestId("session-provider")).not.toBeInTheDocument();
      expect(fetchRequest).not.toHaveBeenCalled();
      expect(
        document.querySelector(
          'script[src*="accounts.google.com"], script[src*="challenges.cloudflare.com"]',
        ),
      ).toBeNull();
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it("keeps the public information route request-free when disclosure configuration is missing", () => {
    vi.stubEnv("VITE_PRIVACY_OPERATOR_NAME", "");
    vi.stubEnv("VITE_PRIVACY_CONTACT_URL", "");
    vi.stubEnv("VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS", "");
    window.history.replaceState(null, "", "/legal/privacy");
    const fetchRequest = vi.spyOn(globalThis, "fetch");

    try {
      render(<AppRoot />);

      expect(
        screen.getByRole("heading", {
          name: "公開情報の設定が完了していません",
        }),
      ).toBeInTheDocument();
      expect(appRootMocks.sessionMounts).toBe(0);
      expect(screen.queryByTestId("session-provider")).not.toBeInTheDocument();
      expect(fetchRequest).not.toHaveBeenCalled();
      expect(
        document.querySelector(
          'script[src*="accounts.google.com"], script[src*="challenges.cloudflare.com"]',
        ),
      ).toBeNull();
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it("blocks normal routes before session discovery when public information is incomplete", () => {
    vi.stubEnv("VITE_PRIVACY_CONTACT_URL", "");
    const fetchRequest = vi.spyOn(globalThis, "fetch");

    try {
      render(<AppRoot />);

      expect(
        screen.getByRole("heading", {
          name: "公開情報の設定が完了していません",
        }),
      ).toBeInTheDocument();
      expect(appRootMocks.sessionMounts).toBe(0);
      expect(screen.queryByTestId("session-provider")).not.toBeInTheDocument();
      expect(fetchRequest).not.toHaveBeenCalled();
      expect(
        document.querySelector(
          'script[src*="accounts.google.com"], script[src*="challenges.cloudflare.com"]',
        ),
      ).toBeNull();
    } finally {
      fetchRequest.mockRestore();
    }
  });

  it("mounts the existing session bootstrap only with complete public information", () => {
    render(<AppRoot />);

    expect(screen.getByTestId("session-provider")).toBeInTheDocument();
    expect(appRootMocks.sessionMounts).toBe(1);
  });

  it("focuses the public heading after in-app navigation leaves the session boundary", async () => {
    const user = userEvent.setup();
    render(<AppRoot />);

    await user.click(
      screen.getByRole("link", { name: "データの取扱いへ移動" }),
    );

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "データの取扱いとお問い合わせ",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(appRootMocks.sessionUnmounts).toBe(1);
  });

  it("keeps transition notices outside the identity-keyed session boundary", () => {
    render(<AppRoot />);

    const noticeProvider = screen.getByTestId("notice-provider");
    const sessionProvider = screen.getByTestId("session-provider");
    const identityBoundary = screen.getByTestId("session-identity-boundary");
    const application = screen.getByTestId("application");
    const cleanupOwner = identityBoundary.parentElement;
    expect(cleanupOwner).not.toBeNull();
    expect(noticeProvider).toContainElement(sessionProvider);
    expect(sessionProvider).toContainElement(cleanupOwner);
    expect(cleanupOwner).toContainElement(identityBoundary);
    expect(identityBoundary).toContainElement(application);
  });

  it("preserves a pending notice across the identity-keyed remount", async () => {
    render(<AppRoot />);
    const cleanupOwner = screen.getByTestId(
      "session-identity-boundary",
    ).parentElement;
    const oldIdentityBoundary = screen.getByTestId("session-identity-boundary");

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを切り替える" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "既存のアカウントへ切り替えました。",
    );
    const newIdentityBoundary = screen.getByTestId("session-identity-boundary");
    expect(newIdentityBoundary).not.toBe(oldIdentityBoundary);
    expect(newIdentityBoundary.parentElement).toBe(cleanupOwner);
  });

  it("keeps session and cleanup owners mounted while an App render failure is retried", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const view = render(<AppRoot />);
      const sessionProvider = screen.getByTestId("session-provider");
      const cleanupOwner = screen.getByTestId(
        "session-identity-boundary",
      ).parentElement;
      expect(cleanupOwner).not.toBeNull();
      expect(appRootMocks.sessionMounts).toBe(1);

      appRootMocks.appShouldThrow = true;
      view.rerender(<AppRoot />);

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("予期しないエラーが発生しました");
      expect(alert).not.toHaveTextContent("application private failure");
      expect(screen.getByTestId("session-provider")).toBe(sessionProvider);
      expect(cleanupOwner).toContainElement(alert.closest("main"));
      expect(
        screen.getByTestId("session-identity-boundary").parentElement,
      ).toBe(cleanupOwner);
      expect(appRootMocks.sessionMounts).toBe(1);
      expect(appRootMocks.sessionUnmounts).toBe(0);

      appRootMocks.appShouldThrow = false;
      await userEvent.click(screen.getByRole("button", { name: "再試行" }));
      expect(screen.getByTestId("application")).toHaveTextContent(
        "00000000-0000-7000-8000-000000000001",
      );
      expect(screen.getByTestId("session-provider")).toBe(sessionProvider);
      expect(appRootMocks.sessionMounts).toBe(1);
      expect(appRootMocks.sessionUnmounts).toBe(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses a full reload callback for a route module failure inside the provider tree", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    appRootMocks.routeModuleShouldThrow = true;

    try {
      render(<AppRoot reloadApplication={reloadApplication} />);
      const sessionProvider = screen.getByTestId("session-provider");
      const alert = screen.getByRole("alert");

      expect(sessionProvider).toContainElement(alert.closest("main"));
      await user.click(screen.getByRole("button", { name: "再試行" }));

      expect(reloadApplication).toHaveBeenCalledOnce();
      expect(alert).toBeInTheDocument();
      expect(screen.getByTestId("session-provider")).toBe(sessionProvider);
      expect(appRootMocks.sessionMounts).toBe(1);
      expect(appRootMocks.sessionUnmounts).toBe(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses a full application reload callback for an outer provider failure", async () => {
    const user = userEvent.setup();
    const reloadApplication = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    appRootMocks.providerShouldThrow = true;

    try {
      render(<AppRoot reloadApplication={reloadApplication} />);
      const alert = screen.getByRole("alert");
      expect(screen.queryByTestId("session-provider")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "再試行" }));
      expect(reloadApplication).toHaveBeenCalledOnce();
      expect(alert).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
