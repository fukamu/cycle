import { render, screen } from "@testing-library/react";

import type { Cycle } from "../../shared/api/schemas";
import { cycleCancellationReasonCopy } from "../../shared/copy/ja";
import { CycleCancellationReason } from "./CycleCancellationReason";

describe("CycleCancellationReason", () => {
  it("identifies only a Cycle canceled for replanning", () => {
    const { rerender } = render(
      <CycleCancellationReason
        cycle={{ status: "canceled", cancellationReason: "replanned" }}
      />,
    );

    expect(
      screen.getByText(cycleCancellationReasonCopy.replanned),
    ).toBeVisible();

    for (const cancellationReason of [
      "goal_achieved",
      "goal_ended",
      null,
    ] satisfies readonly Cycle["cancellationReason"][]) {
      rerender(
        <CycleCancellationReason
          cycle={{ status: "canceled", cancellationReason }}
        />,
      );
      expect(
        screen.queryByText(cycleCancellationReasonCopy.replanned),
      ).not.toBeInTheDocument();
    }

    rerender(
      <CycleCancellationReason
        cycle={{ status: "completed", cancellationReason: null }}
      />,
    );
    expect(
      screen.queryByText(cycleCancellationReasonCopy.replanned),
    ).not.toBeInTheDocument();
  });
});
