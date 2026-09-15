import { render, screen, within } from "@testing-library/react";

import { cyclePreviousActionReferenceCopy } from "../../shared/copy/ja";
import { CyclePreviousActionReference } from "./CyclePreviousActionReference";

const previousAction = {
  cycleId: "40000000-0000-7000-8000-000000000001",
  cycleSequenceNumber: 1,
  goalVersionNumber: 1,
  action: "通知を切る\n30分集中する",
} as const;

describe("CyclePreviousActionReference", () => {
  it("shows the complete previous Action as a static labelled reference", () => {
    const { container } = render(
      <CyclePreviousActionReference
        previousAction={previousAction}
        currentGoalVersionNumber={1}
      />,
    );

    const reference = screen.getByRole("region", {
      name: cyclePreviousActionReferenceCopy.heading,
    });
    expect(
      within(reference).getByRole("heading", {
        name: cyclePreviousActionReferenceCopy.heading,
      }),
    ).toBeVisible();
    expect(within(reference).getByText("Cycle 1 · Goal v1")).toBeVisible();
    expect(
      within(reference).getByText(
        cyclePreviousActionReferenceCopy.referenceOnly,
      ),
    ).toBeVisible();
    expect(
      within(reference).getByText(cyclePreviousActionReferenceCopy.guide),
    ).toBeVisible();
    expect(
      within(reference).getByText(
        (_content, element) => element?.textContent === previousAction.action,
      ),
    ).toBeVisible();
    expect(within(reference).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(reference).queryByRole("button")).not.toBeInTheDocument();
    expect(within(reference).queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-live]")).not.toBeInTheDocument();
  });

  it("shows a textual warning only across a Goal Version change", () => {
    const { rerender } = render(
      <CyclePreviousActionReference
        previousAction={previousAction}
        currentGoalVersionNumber={2}
      />,
    );

    expect(
      screen.getByText(cyclePreviousActionReferenceCopy.goalVersionChanged),
    ).toBeVisible();

    rerender(
      <CyclePreviousActionReference
        previousAction={previousAction}
        currentGoalVersionNumber={1}
      />,
    );
    expect(
      screen.queryByText(cyclePreviousActionReferenceCopy.goalVersionChanged),
    ).not.toBeInTheDocument();
  });
});
