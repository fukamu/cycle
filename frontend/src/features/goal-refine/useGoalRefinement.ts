import { useState } from "react";

import type { GoalRefineResponse } from "../../shared/api/schemas";

export type GoalRefinementState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "suggested";
      readonly response: GoalRefineResponse;
      readonly sourceBody: string;
    }
  | { readonly kind: "failed" };

type RequestSuggestion = () => Promise<GoalRefineResponse>;

export function useGoalRefinement() {
  const [state, setState] = useState<GoalRefinementState>({ kind: "idle" });
  const [requestError, setRequestError] = useState<string>();

  async function request(
    sourceBody: string,
    requestSuggestion: RequestSuggestion,
  ): Promise<void> {
    const previousSuggestion = state.kind === "suggested" ? state : undefined;
    setRequestError(undefined);
    setState({ kind: "running" });
    try {
      const response = await requestSuggestion();
      setState({ kind: "suggested", response, sourceBody });
    } catch {
      if (previousSuggestion) {
        setState(previousSuggestion);
        setRequestError(
          "AIから新しい提案を取得できませんでした。前の提案を表示しています。",
        );
      } else {
        setState({ kind: "failed" });
      }
    }
  }

  return {
    state,
    requestError,
    request,
    dismiss: () => {
      setState({ kind: "idle" });
      setRequestError(undefined);
    },
  } as const;
}
