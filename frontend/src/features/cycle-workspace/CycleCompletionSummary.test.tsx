import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CycleCompletionSummary } from "./CycleCompletionSummary";

describe("CycleCompletionSummary", () => {
  it("shows the immutable goal and every frame in reading order without truncation", () => {
    const longLine = `長い本文${"あ".repeat(220)}\n二行目`;
    const view = render(
      <CycleCompletionSummary
        goalVersionNumber={3}
        cycleSequenceNumber={7}
        goalBody={`目標の一行目\n${longLine}`}
        values={{
          plan: `P:${longLine}`,
          do: `D:${longLine}`,
          check: `C:${longLine}`,
          action: `A:${longLine}`,
        }}
        onEdit={() => undefined}
      />,
    );

    expect(screen.getByText("Goal v3 · Cycle 7")).toBeVisible();
    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "目標",
      "P — Plan",
      "D — Do",
      "C — Check",
      "A — Action",
    ]);
    const goal = view.container.querySelector(
      ".cycle-completion-summary__goal > p",
    );
    const frames = view.container.querySelectorAll(
      ".cycle-completion-summary__frame > p",
    );
    expect(goal?.textContent).toBe(`目標の一行目\n${longLine}`);
    expect([...frames].map((frame) => frame.textContent)).toEqual(
      ["P:", "D:", "C:", "A:"].map((prefix) => `${prefix}${longLine}`),
    );
    expect(view.container.querySelector("[tabindex]")).toBeNull();
  });

  it("identifies which frame an Edit action targets", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <CycleCompletionSummary
        goalVersionNumber={1}
        cycleSequenceNumber={2}
        goalBody="目標"
        values={{ plan: "計画", do: "実行", check: "確認", action: "改善" }}
        onEdit={onEdit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dを編集" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith("do");
  });
});
