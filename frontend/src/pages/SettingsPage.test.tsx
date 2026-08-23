import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
    vi.mocked(deleteAccount).mockRejectedValue(new Error("network"));
    renderPage();

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
    expect(clearUserDrafts).not.toHaveBeenCalled();
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

  it("clears only this user's drafts after a successful 204", async () => {
    vi.mocked(deleteAccount).mockResolvedValue(undefined);
    vi.mocked(clearUserDrafts).mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    await waitFor(() =>
      expect(clearUserDrafts).toHaveBeenCalledWith(session.user.id),
    );
  });

  it("does not report server deletion as failed when local cleanup fails", async () => {
    vi.mocked(deleteAccount).mockResolvedValue(undefined);
    vi.mocked(clearUserDrafts).mockRejectedValue(new Error("indexeddb"));
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "アカウントを削除",
      }),
    );

    await waitFor(() =>
      expect(clearUserDrafts).toHaveBeenCalledWith(session.user.id),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function renderPage(
  value: Session = session,
  replaceSession: (next: Session) => Promise<void> = async () => undefined,
) {
  render(
    <ReplaceSessionContext.Provider value={replaceSession}>
      <SessionContext.Provider value={value}>
        <SettingsPage />
      </SessionContext.Provider>
    </ReplaceSessionContext.Provider>,
  );
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = () => promiseResolve(undefined);
  });
  return { promise, resolve };
}
