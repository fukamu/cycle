import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import type { ActiveCycle } from "../../../shared/api/schemas";
import {
  AIProcessingContext,
  type AIProcessingContextValue,
} from "../../ai/aiProcessingContext";
import { CycleEditor } from "./CycleEditor";

const mocks = vi.hoisted(() => ({
  change: vi.fn(),
  flush: vi.fn(),
  retry: vi.fn(),
  synchronizeFrame: vi.fn(),
}));

vi.mock("../hooks/useAutoSave", () => ({
  useAutoSave: () => ({
    saveState: { kind: "saved" },
    change: mocks.change,
    flush: mocks.flush,
    retry: mocks.retry,
    synchronizeFrame: mocks.synchronizeFrame,
  }),
}));

const cycle: ActiveCycle = {
  id: "00000000-0000-4000-8000-000000000001",
  sequenceNumber: 1,
  status: "active",
  startedAt: "2026-08-16T00:00:00Z",
  completedAt: null,
  plan: "保存済みのP",
  do: "保存済みのD",
  check: "保存済みのC",
  action: "保存済みのA",
  contentRevision: 4,
  frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
  actionUserModifiedAfterAI: false,
};

const ai: AIProcessingContextValue = {
  state: { kind: "idle" },
  errorMessage: null,
  contextChanged: false,
  generate: vi.fn(),
  refine: vi.fn(),
};

describe("CycleEditor", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("keeps each frame's current value while moving between tabs", async () => {
    const user = userEvent.setup();
    renderEditor();

    const plan = screen.getByRole("textbox", { name: "P — Plan" });
    await user.clear(plan);
    await user.type(plan, "編集中のP");
    await user.click(screen.getByRole("tab", { name: "DDo" }));
    expect(screen.getByRole("textbox", { name: "D — Do" })).toHaveValue(
      "保存済みのD",
    );

    await user.click(screen.getByRole("tab", { name: "PPlan" }));
    expect(screen.getByRole("textbox", { name: "P — Plan" })).toHaveValue(
      "編集中のP",
    );
  });

  it("renders the saved value belonging to every selected tab", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("tab", { name: "DDo" }));
    expect(screen.getByRole("textbox", { name: "D — Do" })).toHaveValue(
      "保存済みのD",
    );
    await user.click(screen.getByRole("tab", { name: "CCheck" }));
    expect(screen.getByRole("textbox", { name: "C — Check" })).toHaveValue(
      "保存済みのC",
    );
    await user.click(screen.getByRole("tab", { name: "AAction" }));
    expect(screen.getByRole("textbox", { name: "A — Action" })).toHaveValue(
      "保存済みのA",
    );
  });

  it("restores the selected tab when the editor is mounted again", async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    await user.click(screen.getByRole("tab", { name: "CCheck" }));
    first.unmount();

    renderEditor();

    expect(screen.getByRole("tab", { name: "CCheck" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "C — Check" })).toHaveValue(
      "保存済みのC",
    );
  });
});

function renderEditor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AIProcessingContext.Provider value={ai}>
        {children}
      </AIProcessingContext.Provider>
    </QueryClientProvider>
  );
  return render(
    <CycleEditor cycle={cycle} userId="user-1" csrfToken="csrf" drafts={[]} />,
    { wrapper: Wrapper },
  );
}
