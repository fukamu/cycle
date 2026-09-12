import { useContext, type PropsWithChildren } from "react";

import { InteractionAvailabilityContext } from "./interactionAvailabilityContext";

type InteractionAvailabilityProviderProps = PropsWithChildren<{
  readonly available: boolean;
}>;

export function InteractionAvailabilityProvider({
  available,
  children,
}: InteractionAvailabilityProviderProps) {
  const parentAvailable = useContext(InteractionAvailabilityContext);

  return (
    <InteractionAvailabilityContext.Provider
      value={parentAvailable && available}
    >
      {children}
    </InteractionAvailabilityContext.Provider>
  );
}
