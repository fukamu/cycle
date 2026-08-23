import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useEffect, useLayoutEffect, useState } from "react";

import { AccountDeletionProvider } from "../features/auth/AccountDeletionProvider";
import {
  ReplaceSessionContext,
  SessionContext,
} from "../features/auth/sessionContext";
import {
  deleteAccount,
  loginGoogle,
  upgradeGoogle,
} from "../shared/api/account";
import { APIError } from "../shared/api/client";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
  type AutoSaveQuiesceCallback,
  type AutoSaveScopeLease,
} from "../shared/autosave/AutoSaveScopeProvider";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
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

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.mocked(deleteAccount).mockReset();
    vi.mocked(loginGoogle).mockReset();
    vi.mocked(upgradeGoogle).mockReset();
    vi.mocked(clearUserDrafts).mockReset();
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
    const replaceSession = vi.fn(() => replacement.promise);
    vi.mocked(upgradeGoogle).mockRejectedValue(
      new APIError(
        409,
        "GOOGLE_IDENTITY_ALREADY_LINKED",
        "already linked",
        "request-id",
      ),
    );
    vi.mocked(loginGoogle).mockResolvedValue(switchedSession);
    renderPage(session, replaceSession);

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
        "google-credential",
        session.csrfToken,
      ),
    );
    expect(replaceSession).toHaveBeenCalledWith(switchedSession);
    expect(
      screen.queryByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).not.toBeInTheDocument();

    replacement.resolve();
    expect(
      await screen.findByText("既存のFUKAMU Cycleアカウントへ切り替えました。"),
    ).toBeInTheDocument();
  });

  it("keeps local drafts when server deletion fails", async () => {
    const events: string[] = [];
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
      throw new Error("network");
    });
    renderPage(session, undefined, { onQuiesce });

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "アカウントを削除できませんでした",
    );
    expect(onQuiesce).toHaveBeenCalledWith(
      expect.objectContaining({ preserveDrafts: true }),
    );
    expect(persistDraft).toHaveBeenCalledOnce();
    expect(events).toEqual(["persist", "delete"]);
    expect(clearUserDrafts).not.toHaveBeenCalled();
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

  it("quiesces writers before deletion and clears only this user's drafts after a successful 204", async () => {
    const persistence = deferredVoid();
    const events: string[] = [];
    let staleQueue!: AutoSaveScopeLease["queueBrowserOperation"];
    const onQuiesce = vi.fn<AutoSaveQuiesceCallback>(
      async ({ queueBrowserOperation }) => {
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

    await waitFor(() => expect(events).toEqual(["persist-start"]));
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(clearUserDrafts).not.toHaveBeenCalled();

    persistence.resolve();
    await waitFor(() =>
      expect(clearUserDrafts).toHaveBeenCalledWith(session.user.id),
    );
    expect(onQuiesce).toHaveBeenCalledWith(
      expect.objectContaining({ preserveDrafts: true }),
    );
    expect(events).toEqual([
      "persist-start",
      "persist-finish",
      "delete",
      "clear",
    ]);

    expect(staleQueue).toBeTypeOf("function");
    await staleQueue(async () => {
      events.push("late-write");
    });
    expect(events).toEqual([
      "persist-start",
      "persist-finish",
      "delete",
      "clear",
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
  render(
    <AutoSaveScopeProvider>
      {autoSaveScope && <AutoSaveScopeProbe {...autoSaveScope} />}
      <ReplaceSessionContext.Provider value={replaceSession}>
        <SessionContext.Provider value={value}>
          <MemoryRouter>
            <PostCommitCleanupBoundary>
              <AccountDeletionProvider reloadApplication={reloadApplication}>
                {withRouteNavigation ? (
                  <SettingsRouteHarness onUnmount={onSettingsUnmount} />
                ) : (
                  <SettingsRouteProbe onUnmount={onSettingsUnmount} />
                )}
              </AccountDeletionProvider>
            </PostCommitCleanupBoundary>
          </MemoryRouter>
        </SessionContext.Provider>
      </ReplaceSessionContext.Provider>
    </AutoSaveScopeProvider>,
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
