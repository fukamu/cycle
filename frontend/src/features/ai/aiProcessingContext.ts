import { createContext, useContext } from "react";

import type { AIActionResponse } from "../../shared/api/schemas";
import type { AIState } from "../cycle-editor/model/eligibility";

export type AIProcessingContextValue = {
  readonly state: AIState;
  readonly errorMessage: string | null;
  readonly contextChanged: boolean;
  readonly generate: (
    expectedContentRevision: number,
    confirmReplace: boolean,
  ) => Promise<AIActionResponse>;
  readonly refine: (
    expectedContentRevision: number,
  ) => Promise<AIActionResponse>;
};

export const AIProcessingContext =
  createContext<AIProcessingContextValue | null>(null);

export function useAIProcessing(): AIProcessingContextValue {
  const value = useContext(AIProcessingContext);
  if (value === null) {
    throw new Error("useAIProcessing must be used within AIProcessingProvider");
  }
  return value;
}
