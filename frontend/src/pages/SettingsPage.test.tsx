import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useEffect, useLayoutEffect, useState } from "react";

import { AccountDeletionProvider } from "../features/auth/AccountDeletionProvider";
import { AccountDeletionAdvisoryPublishContext } from "../features/auth/accountDeletionContext";
import { SessionTransitionNoticeProvider } from "../features/auth/SessionTransitionNoticeProvider";
import {
  AuthenticatedRequestLeaseContext,
  RunTerminalSessionOperationContext,
  RunSessionTransitionContext,
  SessionContext,
} from "../features/auth/sessionContext";
import {
  deleteAccount,
  loginGoogle,
  upgradeGoogle,
} from "../shared/api/account";
import { APIError, type AuthenticatedRequestLease } from "../shared/api/client";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
  type AutoSaveQuiesceCallback,
  type AutoSaveScopeLease,
} from "../shared/autosave/AutoSaveScopeProvider";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import type { PostCommitSessionOwnershipToken } from "../shared/cleanup/postCommitCleanupContext";
import { clearUserDrafts } from "../shared/drafts/browserDraftCache";
import type { Session } from "../shared/api/schemas";
import { SettingsPage } from "./SettingsPage";

vi.mock("../features/auth/GoogleIdentityButton", () => ({
  GoogleIdentityButton: ({
    onCredential,
    disabled,
  }: {
    readonly onCredential: (credential: string) => void;
    readonly disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onCredential("google-credential")}
    >
      Google Account 連携
    </button>
  ),
}));
vi.mock("../shared/api/account", () => ({
  deleteAccount: vi.fn(),
  loginGoogle: vi.fn(),
  upgradeGoogle: vi.fn(),
}));
vi.mock("../shared/drafts/browserDraftCache", () => ({
  clearUserDrafts: vi.fn(),
}));

const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};
const upgradedSession: Session = {
  user: {
    ...session.user,
    googleConnected: true,
    googleEmail: "person@example.com",
  },
  csrfToken: "upgraded-csrf-token",
};
const switchedSession: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000002",
    googleConnected: true,
    googleEmail: "existing@example.com",
  },
  csrfToken: "switched-csrf-token",
};

const currentRequestLease: AuthenticatedRequestLease = {
  expectedUserId: session.user.id,
  signal: new AbortController().signal,
  isCurrent: () => true,
};

const currentSessionOwnership = Object.freeze({
  isCurrent: () => true,
}) as PostCommitSessionOwnershipToken;
const publishAccountDeletionAdvisory = vi.fn<(deletedUserId: string) => void>();

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.mocked(deleteAccount).mockReset();
    vi.mocked(loginGoogle).mockReset();
    vi.mocked(upgradeGoogle).mockReset();
    vi.mocked(clearUserDrafts).mockReset();
    publishAccountDeletionAdvisory.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("identifies the connected Google Account by its verified email", () => {
    renderPage({
      ...session,
      user: {
        ...session.user,
        googleConnected: true,
        googleEmail: "person@example.com",
      },
    });

    expect(screen.getByText("連携済み")).toBeInTheDocument();
    expect(screen.getByText("person@example.com")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Google Account 連携"),
    ).not.toBeInTheDocument();
  });

  it("uses fixed copy for an internal error and shows only a validated request ID", async () => {
    vi.mocked(upgradeGoogle).mockRejectedValue(
      new APIError(
        500,
        "INTERNAL_ERROR",
        "upstream token=server-secret-value",
        "00000000-0000-7000-8000-000000000099",
      ),
    );
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: "Google Account 連携" }),
    );

    const presentation = await screen.findByRole("alert");
    expect(presentation).toHaveTextContent(
      "処理中にエラーが発生しました。入力内容は保持されています。もう一度お試しください。",
    );
    expect(presentation).toHaveTextContent("問い合わせID:");
    expect(presentation).toHaveTextContent(
      "00000000-0000-7000-8000-000000000099",
    );
    expect(presentation).not.toHaveTextContent("INTERNAL_ERROR");
    expect(presentation).not.toHaveTextContent(
      "upstream token=server-secret-value",
    );
    expect(document.body).not.toHaveTextContent("server-secret-value");
  });

  it("does not expose an unrecognized server error or invalid request ID", async () => {
    vi.mocked(upgradeGoogle).mockRejectedValue(
      Object.assign(new Error("upstream token=another-server-secret"), {
        code: "PRIVATE_PROVIDER_FAILURE",
        requestId: "invalid-request-id token=invalid-id-secret",
      }),
    );
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: "Google Account 連携" }),
    );

    const presentation = await screen.findByRole("alert");
    expect(presentation).toHaveTextContent(
      "予期しないエラーが発生しました。もう一度お試しください。",
    );
    expect(presentation).not.toHaveTextContent("PRIVATE_PROVIDER_FAILURE");
    expect(presentation).not.toHaveTextContent("another-server-secret");
    expect(presentation).not.toHaveTextContent("invalid-request-id");
    expect(presentation).not.toHaveTextContent("invalid-id-secret");
    expect(presentation).not.toHaveTextContent("問い合わせID:");
  });

  it("awaits same-user replacement before reporting Google connection success", async () => {
    const replacement = deferredVoid();
    const replaceSession = vi.fn(() => replacement.promise);
    vi.mocked(upgradeGoogle).mockResolvedValue(upgradedSession);
    renderPage(session, replaceSession);

    await userEvent.click(
      screen.getByRole("button", { name: "Google Account 連携" }),
    );

    await waitFor(() =>
      expect(upgradeGoogle).toHaveBeenCalledWith(
        currentRequestLease,
        "google-credential",
        session.csrfToken,
      ),
    );
    expect(replaceSession).toHaveBeenCalledWith(upgradedSession);
    expect(
      screen.queryByText("Google Accountを連携しました。"),
    ).not.toBeInTheDocument();

    replacement.resolve();
    expect(
      await screen.findByText("Google Accountを連携しました。"),
    ).toBeInTheDocument();
  });

  it("awaits changed-user replacement before reporting login success", async () => {
    const replacement = deferredVoid();
    vi.mocked(upgradeGoogle).mockRejectedValue(
      new APIError(
        409,
        "GOOGLE_IDENTITY_ALREADY_LINKED",
        "already linked",
        "request-id",
      ),
    );
    vi.mocked(loginGoogle).mockResolvedValue(switchedSession);
    renderIdentityTransitionPage(replacement.promise);

    await userEvent.click(
      screen.getByRole("button", { name: "Google Account 連携" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "既存アカウントでログイン",
      }),
    );

    await waitFor(() =>
      expect(loginGoogle).toHaveBeenCalledWith(
        currentRequestLease,
        "google-credential",
        session.csrfToken,
      ),
    );
    expect(screen.getByText(session.user.id)).toBeInTheDocument();
    expect(
      screen.queryByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).not.toBeInTheDocument();

    replacement.resolve();
    expect(
      await screen.findByText(switchedSession.user.id),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).toBeInTheDocument();
  });

  it("reports a changed-user login exactly once after the identity-keyed subtree remounts", async () => {
    vi.mocked(upgradeGoogle).mockRejectedValue(
      new APIError(
        409,
        "GOOGLE_IDENTITY_ALREADY_LINKED",
        "already linked",
        "request-id",
      ),
    );
    vi.mocked(loginGoogle).mockResolvedValue(switchedSession);
    renderIdentityTransitionPage();

    await userEvent.click(
      screen.getByRole("button", { name: "Google Account 連携" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "既存アカウントでログイン",
      }),
    );

    expect(
      await screen.findByText(switchedSession.user.id),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).toHaveLength(1);

    await userEvent.click(
      screen.getByRole("button", { name: "設定画面を再マウント" }),
    );
    expect(
      screen.queryByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).not.toBeInTheDocument();
  });

  it("does not report an account switch when replacement keeps the same user", async () => {
    vi.mocked(upgradeGoogle).mockRejectedValue(
      new APIError(
        409,
        "GOOGLE_IDENTITY_ALREADY_LINKED",
        "already linked",
        "request-id",
      ),
    );
    vi.mocked(loginGoogle).mockResolvedValue(upgradedSession);
    renderIdentityTransitionPage();

    await userEvent.click(
      screen.getByRole("button", { name: "Google Account 連携" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "既存アカウントでログイン",
      }),
    );

    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    expect(
      screen.queryByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).not.toBeInTheDocument();
  });

  it("keeps local drafts when server deletion fails", async () => {
    const events: string[] = [];
    let activeLease: AutoSaveScopeLease | undefined;
    const persistDraft = vi.fn(async () => {
      events.push("persist");
    });
    const onQuiesce = vi.fn<AutoSaveQuiesceCallback>(
      async ({ queueBrowserOperation }) => {
        await queueBrowserOperation(persistDraft);
      },
    );
    vi.mocked(deleteAccount).mockImplementation(async () => {
      events.push("delete");
      throw new TypeError("network token=do-not-render");
    });
    renderPage(session, undefined, {
      onLease: (lease) => {
        activeLease = lease;
      },
      onQuiesce,
    });

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "予期しないエラーが発生しました。もう一度お試しください。",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "network token=do-not-render",
    );
    expect(deleteAccount).toHaveBeenCalledWith(
      currentRequestLease,
      session.csrfToken,
    );
    expect(onQuiesce).not.toHaveBeenCalled();
    expect(persistDraft).not.toHaveBeenCalled();
    expect(events).toEqual(["delete"]);
    expect(activeLease?.isCurrent()).toBe(true);
    expect(activeLease?.signal.aborted).toBe(false);
    expect(clearUserDrafts).not.toHaveBeenCalled();
    expect(publishAccountDeletionAdvisory).not.toHaveBeenCalled();
    expect(screen.getByText(session.user.id)).toBeInTheDocument();
  });

  it("does not delete the account when the in-app dialog is canceled", async () => {
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "キャンセル",
      }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("holds the cookie-writer lock through delete confirmation but not browser cleanup", async () => {
    const cleanup = deferredVoid();
    const reloadApplication = vi.fn();
    vi.mocked(deleteAccount).mockResolvedValue(undefined);
    vi.mocked(clearUserDrafts).mockReturnValue(cleanup.promise);
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
    renderPage(session, undefined, undefined, reloadApplication);

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    await waitFor(() => expect(lockRequest).toHaveBeenCalledOnce());
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(publishAccountDeletionAdvisory).not.toHaveBeenCalled();

    grantLock();

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(publishAccountDeletionAdvisory).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(clearUserDrafts).toHaveBeenCalledOnce());
    expect(lockReleased).toBe(true);
    expect(reloadApplication).not.toHaveBeenCalled();

    cleanup.resolve();

    await waitFor(() => expect(reloadApplication).toHaveBeenCalledOnce());
    expect(publishAccountDeletionAdvisory).toHaveBeenCalledTimes(2);
    const [name] = lockRequest.mock.calls[0]!;
    expect(name).toBe("fukamu-session-cookie-writer-v1");
  });

  it("fences writers after deletion commits and clears only this user's drafts", async () => {
    const persistence = deferredVoid();
    const events: string[] = [];
    let staleQueue!: AutoSaveScopeLease["queueBrowserOperation"];
    const onQuiesce = vi.fn<AutoSaveQuiesceCallback>(
      async ({ queueBrowserOperation }) => {
        expect(
          screen.getByText(session.user.id).closest("div[hidden][inert]"),
        ).not.toBeNull();
        await queueBrowserOperation(async () => {
          events.push("persist-start");
          await persistence.promise;
          events.push("persist-finish");
        });
      },
    );
    vi.mocked(deleteAccount).mockImplementation(async () => {
      events.push("delete");
    });
    vi.mocked(clearUserDrafts).mockImplementation(async () => {
      events.push("clear");
    });
    publishAccountDeletionAdvisory.mockImplementation(() => {
      events.push("advisory");
    });
    renderPage(session, undefined, {
      onLease: (lease) => {
        staleQueue = lease.queueBrowserOperation;
      },
      onQuiesce,
    });

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    await waitFor(() =>
      expect(events).toEqual(["delete", "advisory", "persist-start"]),
    );
    expect(deleteAccount).toHaveBeenCalledOnce();
    expect(clearUserDrafts).not.toHaveBeenCalled();

    persistence.resolve();
    await waitFor(() =>
      expect(clearUserDrafts).toHaveBeenCalledWith(session.user.id),
    );
    expect(onQuiesce).toHaveBeenCalledWith(
      expect.objectContaining({ preserveDrafts: true }),
    );
    expect(events).toEqual([
      "delete",
      "advisory",
      "persist-start",
      "persist-finish",
      "clear",
      "advisory",
    ]);
    expect(publishAccountDeletionAdvisory).toHaveBeenCalledTimes(2);
    expect(publishAccountDeletionAdvisory).toHaveBeenNthCalledWith(
      1,
      session.user.id,
    );
    expect(publishAccountDeletionAdvisory).toHaveBeenNthCalledWith(
      2,
      session.user.id,
    );

    expect(staleQueue).toBeTypeOf("function");
    await staleQueue(async () => {
      events.push("late-write");
    });
    expect(events).toEqual([
      "delete",
      "advisory",
      "persist-start",
      "persist-finish",
      "clear",
      "advisory",
    ]);
  });

  it("keeps post-204 cleanup alive after the Settings route subtree unmounts", async () => {
    const deletion = deferredVoid();
    const cleanup = deferredVoid();
    const reloadApplication = vi.fn();
    const onSettingsUnmount = vi.fn();
    vi.mocked(deleteAccount).mockReturnValue(deletion.promise);
    vi.mocked(clearUserDrafts).mockReturnValue(cleanup.promise);
    renderPage(
      session,
      undefined,
      undefined,
      reloadApplication,
      onSettingsUnmount,
      true,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledOnce());
    await userEvent.click(
      screen.getByRole("button", { name: "別routeへ移動" }),
    );
    expect(onSettingsUnmount).toHaveBeenCalledOnce();
    expect(screen.getByText("home route")).toBeInTheDocument();
    expect(clearUserDrafts).not.toHaveBeenCalled();

    deletion.resolve();

    await waitFor(() => expect(clearUserDrafts).toHaveBeenCalledOnce());
    expect(screen.queryByText("home route")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "ブラウザに残る下書きを削除しています",
    );
    expect(reloadApplication).not.toHaveBeenCalled();

    cleanup.resolve();

    await waitFor(() => expect(reloadApplication).toHaveBeenCalledOnce());
    expect(deleteAccount).toHaveBeenCalledOnce();
    expect(clearUserDrafts).toHaveBeenCalledWith(session.user.id);
  });

  it("retries only local cleanup after a successful delete before reloading", async () => {
    const reloadApplication = vi.fn();
    vi.mocked(deleteAccount).mockResolvedValue(undefined);
    vi.mocked(clearUserDrafts)
      .mockRejectedValueOnce(new Error("indexeddb"))
      .mockResolvedValueOnce(undefined);
    renderPage(session, undefined, undefined, reloadApplication);

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "アカウントは削除されましたが、このブラウザに残る下書きを削除できませんでした",
    );
    expect(
      screen.queryByRole("button", { name: "アカウントを削除" }),
    ).not.toBeInTheDocument();
    expect(deleteAccount).toHaveBeenCalledOnce();
    expect(clearUserDrafts).toHaveBeenCalledOnce();
    expect(publishAccountDeletionAdvisory).toHaveBeenCalledOnce();
    expect(reloadApplication).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", {
        name: "ブラウザデータの削除を再試行",
      }),
    );

    await waitFor(() => expect(reloadApplication).toHaveBeenCalledOnce());
    expect(deleteAccount).toHaveBeenCalledOnce();
    expect(clearUserDrafts).toHaveBeenCalledTimes(2);
    expect(clearUserDrafts).toHaveBeenNthCalledWith(1, session.user.id);
    expect(clearUserDrafts).toHaveBeenNthCalledWith(2, session.user.id);
    expect(publishAccountDeletionAdvisory).toHaveBeenCalledTimes(2);
  });
});

function renderPage(
  value: Session = session,
  replaceSession: (next: Session) => Promise<void> = async () => undefined,
  autoSaveScope?: {
    readonly onLease?: (lease: AutoSaveScopeLease) => void;
    readonly onQuiesce?: AutoSaveQuiesceCallback;
  },
  reloadApplication: () => void = () => undefined,
  onSettingsUnmount?: () => void,
  withRouteNavigation = false,
) {
  const runSessionTransition = async (
    _expectedUserId: string,
    request: (
      currentSession: Session,
      lease: AuthenticatedRequestLease,
    ) => Promise<Session>,
  ) => {
    const nextSession = await request(value, currentRequestLease);
    await replaceSession(nextSession);
    return { previousSession: value, session: nextSession };
  };
  const runTerminalSessionOperation = async <Result,>(
    _expectedUserId: string,
    operation: (
      currentSession: Session,
      _lease: AuthenticatedRequestLease,
      _ownership: PostCommitSessionOwnershipToken,
    ) => Promise<Result>,
  ) => operation(value, currentRequestLease, currentSessionOwnership);

  render(
    <AutoSaveScopeProvider>
      {autoSaveScope && <AutoSaveScopeProbe {...autoSaveScope} />}
      <SessionTransitionNoticeProvider>
        <RunTerminalSessionOperationContext.Provider
          value={runTerminalSessionOperation}
        >
          <RunSessionTransitionContext.Provider value={runSessionTransition}>
            <SessionContext.Provider value={value}>
              <AuthenticatedRequestLeaseContext.Provider
                value={currentRequestLease}
              >
                <MemoryRouter>
                  <PostCommitCleanupBoundary
                    runSessionOperation={async (_expectedUserId, operation) =>
                      operation(() => true)
                    }
                  >
                    <AccountDeletionAdvisoryPublishContext.Provider
                      value={publishAccountDeletionAdvisory}
                    >
                      <AccountDeletionProvider
                        reloadApplication={reloadApplication}
                      >
                        {withRouteNavigation ? (
                          <SettingsRouteHarness onUnmount={onSettingsUnmount} />
                        ) : (
                          <SettingsRouteProbe onUnmount={onSettingsUnmount} />
                        )}
                      </AccountDeletionProvider>
                    </AccountDeletionAdvisoryPublishContext.Provider>
                  </PostCommitCleanupBoundary>
                </MemoryRouter>
              </AuthenticatedRequestLeaseContext.Provider>
            </SessionContext.Provider>
          </RunSessionTransitionContext.Provider>
        </RunTerminalSessionOperationContext.Provider>
      </SessionTransitionNoticeProvider>
    </AutoSaveScopeProvider>,
  );
}

function renderIdentityTransitionPage(replacementGate?: Promise<void>) {
  render(
    <AutoSaveScopeProvider>
      <MemoryRouter>
        <PostCommitCleanupBoundary
          runSessionOperation={async (_expectedUserId, operation) =>
            operation(() => true)
          }
        >
          <SessionTransitionNoticeProvider>
            <IdentityTransitionHarness replacementGate={replacementGate} />
          </SessionTransitionNoticeProvider>
        </PostCommitCleanupBoundary>
      </MemoryRouter>
    </AutoSaveScopeProvider>,
  );
}

function IdentityTransitionHarness({
  replacementGate,
}: {
  readonly replacementGate: Promise<void> | undefined;
}) {
  const [currentSession, setCurrentSession] = useState(session);
  const [routeGeneration, setRouteGeneration] = useState(0);

  async function runSessionTransition(
    _expectedUserId: string,
    request: (
      currentSession: Session,
      lease: AuthenticatedRequestLease,
    ) => Promise<Session>,
  ) {
    const previousSession = currentSession;
    const nextSession = await request(previousSession, currentRequestLease);
    await replacementGate;
    setCurrentSession(nextSession);
    return { previousSession, session: nextSession };
  }

  async function runTerminalSessionOperation<Result>(
    _expectedUserId: string,
    operation: (
      currentSession: Session,
      _lease: AuthenticatedRequestLease,
      _ownership: PostCommitSessionOwnershipToken,
    ) => Promise<Result>,
  ) {
    return operation(
      currentSession,
      currentRequestLease,
      currentSessionOwnership,
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setRouteGeneration((generation) => generation + 1)}
      >
        設定画面を再マウント
      </button>
      <RunTerminalSessionOperationContext.Provider
        value={runTerminalSessionOperation}
      >
        <RunSessionTransitionContext.Provider value={runSessionTransition}>
          <SessionContext.Provider
            key={currentSession.user.id}
            value={currentSession}
          >
            <AuthenticatedRequestLeaseContext.Provider
              value={currentRequestLease}
            >
              <AccountDeletionAdvisoryPublishContext.Provider
                value={publishAccountDeletionAdvisory}
              >
                <AccountDeletionProvider reloadApplication={() => undefined}>
                  <div key={routeGeneration}>
                    <SettingsPage />
                  </div>
                </AccountDeletionProvider>
              </AccountDeletionAdvisoryPublishContext.Provider>
            </AuthenticatedRequestLeaseContext.Provider>
          </SessionContext.Provider>
        </RunSessionTransitionContext.Provider>
      </RunTerminalSessionOperationContext.Provider>
    </>
  );
}

function SettingsRouteHarness({
  onUnmount,
}: {
  readonly onUnmount: (() => void) | undefined;
}) {
  const [settingsRoute, setSettingsRoute] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setSettingsRoute(false)}>
        別routeへ移動
      </button>
      {settingsRoute ? (
        <SettingsRouteProbe onUnmount={onUnmount} />
      ) : (
        <p>home route</p>
      )}
    </>
  );
}

function SettingsRouteProbe({
  onUnmount,
}: {
  readonly onUnmount: (() => void) | undefined;
}) {
  useEffect(() => () => onUnmount?.(), [onUnmount]);
  return <SettingsPage />;
}

function AutoSaveScopeProbe({
  onLease,
  onQuiesce,
}: {
  readonly onLease?: (lease: AutoSaveScopeLease) => void;
  readonly onQuiesce?: AutoSaveQuiesceCallback;
}) {
  const registry = useAutoSaveScopeRegistry();

  useLayoutEffect(() => {
    const lease = registry.prepare("settings-account-delete-test");
    lease.activate();
    onLease?.(lease);
    if (!onQuiesce) return undefined;
    return lease.onQuiesce(onQuiesce);
  }, [onLease, onQuiesce, registry]);

  return null;
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = () => promiseResolve(undefined);
  });
  return { promise, resolve };
}
