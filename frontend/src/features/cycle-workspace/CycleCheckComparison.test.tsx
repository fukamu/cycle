import { fireEvent, render, screen, within } from "@testing-library/react";

import { CycleCheckComparison } from "./CycleCheckComparison";

describe("CycleCheckComparison", () => {
  it("shows the current Plan and Do as plain read-only comparison content", () => {
    render(
      <CycleCheckComparison
        values={{ plan: "朝に試す\n通知を切る", do: "4日実行した" }}
        recoveryPending={new Set()}
        onReviewRecovery={() => undefined}
      />,
    );

    const comparison = screen.getByRole("region", {
      name: "今回のPとDを比べる",
    });
    expect(
      within(comparison).getByRole("heading", { name: "P — Plan" }),
    ).toBeInTheDocument();
    expect(
      within(comparison).getByRole("heading", { name: "D — Do" }),
    ).toBeInTheDocument();
    expect(
      Array.from(
        comparison.querySelectorAll(".cycle-check-comparison__content"),
        (element) => element.textContent,
      ),
    ).toContain("朝に試す\n通知を切る");
    expect(within(comparison).getByText("4日実行した")).toBeInTheDocument();
    expect(within(comparison).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("labels whitespace-only frames as empty", () => {
    render(
      <CycleCheckComparison
        values={{ plan: "", do: " \n " }}
        recoveryPending={new Set()}
        onReviewRecovery={() => undefined}
      />,
    );

    expect(screen.getAllByText("まだ入力されていません")).toHaveLength(2);
  });

  it("marks recovery without exposing it and delegates the explicit review", () => {
    const onReviewRecovery = vi.fn();
    render(
      <CycleCheckComparison
        values={{ plan: "サーバー上の計画", do: "実行内容" }}
        recoveryPending={new Set(["plan"])}
        onReviewRecovery={onReviewRecovery}
      />,
    );

    expect(screen.getByText("要確認")).toBeInTheDocument();
    expect(screen.getByText("サーバー上の計画")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pの入力を確認" }));
    expect(onReviewRecovery).toHaveBeenCalledOnce();
    expect(onReviewRecovery).toHaveBeenCalledWith("plan");
  });
});
