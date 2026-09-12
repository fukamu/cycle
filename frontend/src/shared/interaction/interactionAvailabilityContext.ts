import { createContext, useContext } from "react";

export const InteractionAvailabilityContext = createContext(true);

export function useInteractionAvailability(): boolean {
  return useContext(InteractionAvailabilityContext);
}
