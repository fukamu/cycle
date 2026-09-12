import { render, screen } from "@testing-library/react";

import { InteractionAvailabilityProvider } from "./InteractionAvailabilityProvider";
import { useInteractionAvailability } from "./interactionAvailabilityContext";

function AvailabilityProbe({ label }: { readonly label: string }) {
  const available = useInteractionAvailability();
  return (
    <output aria-label={label}>{available ? "available" : "blocked"}</output>
  );
}

describe("interaction availability", () => {
  it("defaults to available and lets any unavailable ancestor fence descendants", () => {
    render(
      <>
        <AvailabilityProbe label="default" />
        <InteractionAvailabilityProvider available={false}>
          <InteractionAvailabilityProvider available={true}>
            <AvailabilityProbe label="nested" />
          </InteractionAvailabilityProvider>
        </InteractionAvailabilityProvider>
      </>,
    );

    expect(screen.getByLabelText("default")).toHaveTextContent("available");
    expect(screen.getByLabelText("nested")).toHaveTextContent("blocked");
  });
});
