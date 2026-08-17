import { useMemo, useReducer, type ReactNode } from "react";

import { APIError } from "../../shared/api/client";
import { generateAction, refineAction } from "../../shared/api/cycles";
import type { AIState } from "../cycle-editor/model/eligibility";
import {
  AIProcessingContext,
  type AIProcessingContextValue,
} from "./aiProcessingContext";

type ProviderState = {
  readonly ai: AIState;
  readonly errorMessage: string | null;
  readonly contextChanged: boolean;
};

type ProviderAction =
  | { readonly type: "start-generate" }
  | { readonly type: "start-refine" }
  | { readonly type: "success"; readonly contextChanged: boolean }
  | { readonly type: "failure"; readonly message: string };

export function AIProcessingProvider({
  cycleId,
  csrfToken,
  children,
}: {
  readonly cycleId: string;
  readonly csrfToken: string;
  readonly children: ReactNode;
}) {
  const [providerState, dispatch] = useReducer(reducer, {
    ai: { kind: "idle" },
    errorMessage: null,
    contextChanged: false,
  });

  const value = useMemo<AIProcessingContextValue>(
    () => ({
      state: providerState.ai,
      errorMessage: providerState.errorMessage,
      contextChanged: providerState.contextChanged,
      generate: async (expectedContentRevision, confirmReplace) => {
        dispatch({ type: "start-generate" });
        try {
          const result = await generateAction(
            cycleId,
            expectedContentRevision,
            confirmReplace,
            csrfToken,
          );
          dispatch({
            type: "success",
            contextChanged: result.contextChanged,
          });
          return result;
        } catch (error) {
          dispatch({ type: "failure", message: aiErrorMessage(error) });
          throw error;
        }
      },
      refine: async (expectedContentRevision) => {
        dispatch({ type: "start-refine" });
        try {
          const result = await refineAction(
            cycleId,
            expectedContentRevision,
            csrfToken,
          );
          dispatch({
            type: "success",
            contextChanged: result.contextChanged,
          });
          return result;
        } catch (error) {
          dispatch({ type: "failure", message: aiErrorMessage(error) });
          throw error;
        }
      },
    }),
    [csrfToken, cycleId, providerState],
  );

  return (
    <AIProcessingContext.Provider value={value}>
      {children}
    </AIProcessingContext.Provider>
  );
}

function reducer(state: ProviderState, action: ProviderAction): ProviderState {
  switch (action.type) {
    case "start-generate":
      return {
        ai: { kind: "generating" },
        errorMessage: null,
        contextChanged: false,
      };
    case "start-refine":
      return {
        ai: { kind: "refining" },
        errorMessage: null,
        contextChanged: false,
      };
    case "success":
      return {
        ai: { kind: "idle" },
        errorMessage: null,
        contextChanged: action.contextChanged,
      };
    case "failure":
      return {
        ...state,
        ai: { kind: "idle" },
        errorMessage: action.message,
      };
  }
}

function aiErrorMessage(error: unknown): string {
  if (!(error instanceof APIError)) {
    return "AIサービスに接続できませんでした。Aの内容は変更されていません。";
  }
  const messages: Readonly<Record<string, string>> = {
    AI_USER_ROLLING_LIMIT_EXCEEDED:
      "直近24時間のAI利用上限に達しました。Aの内容は変更されていません。",
    AI_RATE_LIMIT_EXCEEDED:
      "短時間のAI利用が続いています。少し待ってからお試しください。",
    AI_SERVICE_BUDGET_EXCEEDED:
      "現在AI機能を一時停止しています。自分でAを記録できます。",
    AI_PROVIDER_TIMEOUT:
      "AI処理が時間内に完了しませんでした。Aの内容は変更されていません。",
    AI_INVALID_RESPONSE:
      "AIの応答を確認できませんでした。Aの内容は変更されていません。",
    AI_PROVIDER_UNAVAILABLE:
      "AIサービスに接続できませんでした。Aの内容は変更されていません。",
    CYCLE_REVISION_CONFLICT:
      "保存内容が更新されています。画面の内容を確認してからもう一度お試しください。",
  };
  return messages[error.code] ?? error.message;
}
