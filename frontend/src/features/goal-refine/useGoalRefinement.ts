import { useEffect, useRef, useState } from "react";

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
type IsCurrentScope = () => boolean;

export function useGoalRefinement() {
  const [state, setState] = useState<GoalRefinementState>({ kind: "idle" });
  const [requestError, setRequestError] = useState<string>();
  const requestGenerationRef = useRef(0);
  useEffect(
    () => () => {
      requestGenerationRef.current += 1;
    },
    [],
  );

  async function request(
    sourceBody: string,
    requestSuggestion: RequestSuggestion,
    isCurrentScope: IsCurrentScope = () => true,
  ): Promise<void> {
    const requestGeneration = ++requestGenerationRef.current;
    const isCurrentRequest = () =>
      requestGenerationRef.current === requestGeneration && isCurrentScope();
    const previousSuggestion = state.kind === "suggested" ? state : undefined;
    setRequestError(undefined);
    setState({ kind: "running" });
    try {
      const response = await requestSuggestion();
      if (!isCurrentRequest()) return;
      setState({ kind: "suggested", response, sourceBody });
    } catch {
      if (!isCurrentRequest()) return;
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
      requestGenerationRef.current += 1;
      setState({ kind: "idle" });
      setRequestError(undefined);
    },
  } as const;
}
