import { render, screen } from "@testing-library/react";

import { App } from "./App";

vi.mock("../pages/HomePage", () => ({ HomePage: () => <h1>PDCAI</h1> }));
vi.mock("../pages/PastCyclesPage", () => ({ PastCyclesPage: () => null }));
vi.mock("../pages/PastCycleDetailPage", () => ({
  PastCycleDetailPage: () => null,
}));
vi.mock("../pages/SettingsPage", () => ({ SettingsPage: () => null }));

describe("App", () => {
  it("renders the product name", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "PDCAI" })).toBeInTheDocument();
  });
});
