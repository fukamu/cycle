import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { PastCycleDetailPage } from "./PastCycleDetailPage";
import { PastCyclesPage } from "./PastCyclesPage";

const mocks = vi.hoisted(() => ({
  getCompletedCycle: vi.fn(),
  listCompletedCycles: vi.fn(),
}));

vi.mock("../shared/api/cycles", () => mocks);

const completedCycle = {
  id: "00000000-0000-4000-8000-000000000007",
  sequenceNumber: 7,
  status: "completed" as const,
  startedAt: "2026-08-01T00:00:00Z",
  completedAt: "2026-08-02T00:00:00Z",
  plan: "計画",
  do: "実行",
  check: "確認",
  action: "改善",
};

describe("past cycle number typography", () => {
  beforeEach(() => {
    mocks.listCompletedCycles.mockResolvedValue({
      items: [
        {
          id: completedCycle.id,
          sequenceNumber: completedCycle.sequenceNumber,
          startedAt: completedCycle.startedAt,
          completedAt: completedCycle.completedAt,
          planPreview: completedCycle.plan,
        },
      ],
      nextCursor: null,
    });
    mocks.getCompletedCycle.mockResolvedValue({ cycle: completedCycle });
  });

  it("uses the cycle sequence typography for list card numbers", async () => {
    renderPage(
      "/cycles",
      <Route path="/cycles" element={<PastCyclesPage />} />,
    );

    const badge = await screen.findByText("07");
    expect(badge).toHaveClass("cycle-card__number", "cycle-sequence");
    const heading = screen.getByRole("heading", { name: "Cycle 7" });
    expect(heading.querySelector(".cycle-sequence")).toHaveTextContent("7");
  });

  it("uses the cycle sequence typography on the detail heading", async () => {
    renderPage(
      `/cycles/${completedCycle.id}`,
      <Route path="/cycles/:cycleId" element={<PastCycleDetailPage />} />,
    );

    const heading = await screen.findByRole("heading", { name: "Cycle 7" });
    expect(heading.querySelector(".cycle-sequence")).toHaveTextContent("7");
  });
});

function renderPage(initialEntry: string, route: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>{route}</Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
