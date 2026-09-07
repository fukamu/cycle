import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { CurrentWork, Goal } from "../../shared/api/schemas";
import { ProgressingGoalCard } from "./ProgressingGoalCard";
import { getProgressingGoalCardViewModel } from "./progressingGoalCardModel";

type ActiveGoal = Goal & {
  readonly status: "active_cycle";
  readonly currentWork: Extract<CurrentWork, { kind: "active_cycle" }>;
};

const activeGoal: ActiveGoal = {
  id: "10000000-0000-7000-8000-000000000001",
  status: "active_cycle",
  revision: 0,
  currentVersion: {
    id: "20000000-0000-7000-8000-000000000001",
    versionNumber: 1,
    body: "平日は主要業務を18時までに終えたい",
    createdAt: "2026-08-20T00:00:00.000Z",
  },
  currentWork: {
    kind: "active_cycle",
    cycleId: "30000000-0000-7000-8000-000000000001",
    cycleSequenceNumber: 3,
  },
  nextCycleSequenceNumber: 4,
  cycleCount: 3,
  createdAt: "2026-08-20T00:00:00.000Z",
  terminalAt: null,
};

const reviewGoal: Goal = {
  ...activeGoal,
  status: "goal_review",
  currentWork: {
    kind: "goal_review",
    reviewDraftId: "40000000-0000-7000-8000-000000000001",
    triggerCycleId: activeGoal.currentWork.cycleId,
    triggerCycleSequenceNumber: 3,
  },
};

describe("ProgressingGoalCard", () => {
  it("presents the active Cycle as the current place and sole next action", () => {
    expect(getProgressingGoalCardViewModel(activeGoal)).toEqual({
      goalId: activeGoal.id,
      goalBody: activeGoal.currentVersion.body,
      currentPlace: "Cycle 3 実行中",
      helper: "P/D/C/Aの記録を続けましょう。",
      target: `/goals/${activeGoal.id}/cycles/${activeGoal.currentWork.cycleId}`,
      cta: "Cycle 3を続ける",
    });

    renderCard(activeGoal);

    const card = screen.getByRole("article", {
      name: activeGoal.currentVersion.body,
    });
    expect(
      within(card).getByRole("heading", {
        level: 3,
        name: activeGoal.currentVersion.body,
      }),
    ).toBeInTheDocument();
    expect(within(card).getByText("Cycle 3 実行中")).toBeVisible();
    expect(
      within(card).getByText("P/D/C/Aの記録を続けましょう。"),
    ).toBeVisible();
    expect(within(card).getAllByRole("link")).toHaveLength(1);
    expect(
      within(card).getByRole("link", { name: "Cycle 3を続ける" }),
    ).toHaveAttribute(
      "href",
      `/goals/${activeGoal.id}/cycles/${activeGoal.currentWork.cycleId}`,
    );
    expect(
      card.querySelectorAll("button, input, select, textarea"),
    ).toHaveLength(0);
  });

  it("presents Goal Review with its trigger Cycle and existing route", () => {
    expect(getProgressingGoalCardViewModel(reviewGoal)).toEqual({
      goalId: reviewGoal.id,
      goalBody: reviewGoal.currentVersion.body,
      currentPlace: "目標の見直し中",
      helper: "Cycle 3を振り返り、目標を続けるか決めましょう。",
      target: `/goals/${reviewGoal.id}/review`,
      cta: "目標を見直す",
    });

    renderCard(reviewGoal);

    const card = screen.getByRole("article", {
      name: reviewGoal.currentVersion.body,
    });
    expect(within(card).getByText("目標の見直し中")).toBeVisible();
    expect(
      within(card).getByText("Cycle 3を振り返り、目標を続けるか決めましょう。"),
    ).toBeVisible();
    expect(within(card).getAllByRole("link")).toHaveLength(1);
    expect(
      within(card).getByRole("link", { name: "目標を見直す" }),
    ).toHaveAttribute("href", `/goals/${reviewGoal.id}/review`);
  });

  it.each([
    ["missing current work", { ...activeGoal, currentWork: null }],
    [
      "mismatched status and current work",
      { ...activeGoal, status: "goal_review" as const },
    ],
    [
      "a non-progressing status",
      { ...activeGoal, status: "achieved" as const },
    ],
  ])("rejects %s instead of presenting a guessed action", (_label, goal) => {
    expect(getProgressingGoalCardViewModel(goal)).toBeNull();
  });
});

function renderCard(goal: Goal) {
  const view = getProgressingGoalCardViewModel(goal);
  if (!view) throw new Error("test fixture is not a progressing Goal");
  render(
    <MemoryRouter>
      <ProgressingGoalCard view={view} />
    </MemoryRouter>,
  );
}
