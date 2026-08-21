import { render, screen } from "@testing-library/react";

import { App } from "./App";

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
    render(<App />);
    expect(screen.getByRole("heading", { name: "ホーム" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "FUKAMU Cycle ホーム" }),
    ).toHaveAttribute("href", "/");
  });
});
