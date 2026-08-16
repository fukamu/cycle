import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ReplaceSessionContext,
  SessionContext,
} from "../features/auth/sessionContext";
import { deleteAccount } from "../shared/api/account";
import { clearUserDrafts } from "../features/cycle-editor/draft/draftRepository";
import { SettingsPage } from "./SettingsPage";

vi.mock("../shared/api/account", () => ({
  deleteAccount: vi.fn(),
  loginGoogle: vi.fn(),
  upgradeGoogle: vi.fn(),
}));
vi.mock("../features/cycle-editor/draft/draftRepository", () => ({
  clearUserDrafts: vi.fn(),
}));

const session = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    googleConnected: false,
  },
  csrfToken: "csrf-token",
  activeCycleId: "00000000-0000-4000-8000-000000000002",
};

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.mocked(deleteAccount).mockReset();
    vi.mocked(clearUserDrafts).mockReset();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps local drafts when server deletion fails", async () => {
    vi.mocked(deleteAccount).mockRejectedValue(new Error("network"));
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "アカウントを削除できませんでした",
    );
    expect(clearUserDrafts).not.toHaveBeenCalled();
  });

  it("clears only this user's drafts after a successful 204", async () => {
    vi.mocked(deleteAccount).mockResolvedValue(undefined);
    vi.mocked(clearUserDrafts).mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(
      screen.getByRole("button", { name: "アカウントを削除" }),
    );

    await waitFor(() =>
      expect(clearUserDrafts).toHaveBeenCalledWith(session.user.id),
    );
  });
});

function renderPage() {
  render(
    <ReplaceSessionContext.Provider value={vi.fn()}>
      <SessionContext.Provider value={session}>
        <SettingsPage />
      </SessionContext.Provider>
    </ReplaceSessionContext.Provider>,
  );
}
