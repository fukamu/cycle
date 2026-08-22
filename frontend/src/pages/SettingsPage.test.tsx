import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ReplaceSessionContext,
  SessionContext,
} from "../features/auth/sessionContext";
import { deleteAccount } from "../shared/api/account";
import { clearUserDrafts } from "../shared/drafts/browserDraftCache";
import type { Session } from "../shared/api/schemas";
import { SettingsPage } from "./SettingsPage";

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

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.mocked(deleteAccount).mockReset();
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

function renderPage(value = session) {
  render(
    <ReplaceSessionContext.Provider value={vi.fn()}>
      <SessionContext.Provider value={value}>
        <SettingsPage />
      </SessionContext.Provider>
    </ReplaceSessionContext.Provider>,
  );
}
