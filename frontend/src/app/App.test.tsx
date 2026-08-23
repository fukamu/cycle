import { render, screen } from "@testing-library/react";

import { SessionContext } from "../features/auth/sessionContext";
import type { Session } from "../shared/api/schemas";
import { AutoSaveScopeProvider } from "../shared/autosave/AutoSaveScopeProvider";
import { App } from "./App";

const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

vi.mock("../pages/HomePage", () => ({ HomePage: () => <h1>ホーム</h1> }));
vi.mock("../pages/NewGoalPage", () => ({ NewGoalPage: () => null }));
vi.mock("../pages/GoalWorkspacePage", () => ({
  GoalWorkspacePage: () => null,
}));
vi.mock("../pages/GoalReviewPage", () => ({ GoalReviewPage: () => null }));
vi.mock("../pages/GoalHistoryPage", () => ({ GoalHistoryPage: () => null }));
vi.mock("../pages/GoalTimelinePage", () => ({ GoalTimelinePage: () => null }));
vi.mock("../pages/SettingsPage", () => ({ SettingsPage: () => null }));

describe("App", () => {
  it("renders the G-PDCA home route", () => {
    render(
      <AutoSaveScopeProvider>
        <SessionContext.Provider value={session}>
          <App />
        </SessionContext.Provider>
      </AutoSaveScopeProvider>,
    );
    expect(screen.getByRole("heading", { name: "ホーム" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "FUKAMU Cycle ホーム" }),
    ).toHaveAttribute("href", "/");
  });
});
