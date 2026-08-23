import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import type { GoalDraft, Home, Session } from "../shared/api/schemas";
import {
  adoptGoalDraft,
  getHome,
  refineGoalDraft,
  saveGoalDraft,
} from "../shared/api/workspace";
import {
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import { NewGoalPage } from "./NewGoalPage";

vi.mock("../shared/api/workspace", () => ({
  adoptGoalDraft: vi.fn(),
  createGoalDraft: vi.fn(),
  discardGoalDraft: vi.fn(),
  getHome: vi.fn(),
  refineGoalDraft: vi.fn(),
  saveGoalDraft: vi.fn(),
  startGoal: vi.fn(),
}));

vi.mock("../shared/drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn(),
  getBrowserDraft: vi.fn(),
  putBrowserDraft: vi.fn(),
}));

const draft: GoalDraft = {
  id: "20000000-0000-7000-8000-000000000001",
  draftType: "creation",
  body: "元の目標",
  revision: 0,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const home: Home = {
  progressingGoals: [],
  creationDraft: draft,
  canCreateGoalDraft: false,
  progressingGoalLimit: 2,
  canStartProgressingGoal: true,
};

const session: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

describe("NewGoalPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHome).mockResolvedValue(home);
    vi.mocked(getBrowserDraft).mockResolvedValue(null);
    vi.mocked(putBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(deleteBrowserDraft).mockResolvedValue(undefined);
    vi.mocked(refineGoalDraft).mockResolvedValue({
      generationId: "30000000-0000-7000-8000-000000000001",
      sourceDraftRevision: draft.revision,
      suggestion: "整理された目標",
      contextChanged: false,
    });
    vi.mocked(adoptGoalDraft).mockResolvedValue({
      draft: {
        ...draft,
        body: "整理された目標",
        revision: 1,
        updatedAt: "2026-08-20T00:01:00.000Z",
      },
    });
  });

  it("keeps refinement separate until the user explicitly adopts it", async () => {
    renderPage();
    const editor = await screen.findByRole("textbox", {
      name: "あなたの目標",
    });

    fireEvent.click(screen.getByRole("button", { name: "AIで目標を整える" }));

    expect(await screen.findByText("整理された目標")).toBeInTheDocument();
    expect(editor).toHaveValue("元の目標");
    expect(adoptGoalDraft).not.toHaveBeenCalled();
    expect(saveGoalDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提案を採用" }));

    await waitFor(() =>
      expect(adoptGoalDraft).toHaveBeenCalledWith(
        draft.id,
        "30000000-0000-7000-8000-000000000001",
        draft.revision,
        session.csrfToken,
      ),
    );
    await waitFor(() => expect(editor).toHaveValue("整理された目標"));
  });
});

function renderPage() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={cache}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={["/goals/new"]}>
          <Routes>
            <Route path="/goals/new" element={<NewGoalPage />} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}
