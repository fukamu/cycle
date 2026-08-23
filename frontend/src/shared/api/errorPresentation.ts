import { isUUIDv7 } from "../id/uuid";
import { APIError } from "./client";
import { isStableAPIErrorCode, type StableAPIErrorCode } from "./errorCodes";
import { NetworkError } from "./networkError";

export type StableAPIError = {
  [Code in StableAPIErrorCode]: APIError<Code>;
}[StableAPIErrorCode];

type PresentationBase = {
  readonly message: string;
  readonly requestId?: string;
};

export type ErrorPresentation =
  | (PresentationBase & {
      readonly kind: "api";
      readonly code: StableAPIErrorCode;
    })
  | (PresentationBase & {
      readonly kind: "invalid-response";
      readonly code: "INVALID_ERROR_RESPONSE";
    })
  | (PresentationBase & {
      readonly kind: "network";
      readonly code: "NETWORK_ERROR";
    })
  | (PresentationBase & {
      readonly kind: "unexpected";
      readonly code: "UNEXPECTED_ERROR";
    });

const inputMessage = "入力内容を確認してください。";
const notFoundMessage =
  "対象が見つかりませんでした。画面を読み込み直してください。";
const conflictMessage =
  "別の更新が反映されています。画面の内容を確認して、もう一度お試しください。";
const operationMessage = "処理を完了できませんでした。もう一度お試しください。";
const preservedInputMessage =
  "処理中にエラーが発生しました。入力内容は保持されています。もう一度お試しください。";
const serviceMessage =
  "現在この機能を利用できません。時間をおいて、もう一度お試しください。";

const messageByCode = {
  VALIDATION_ERROR: inputMessage,
  GOAL_TEXT_REQUIRED: inputMessage,
  GOAL_TEXT_TOO_LONG: inputMessage,
  FRAME_TEXT_TOO_LONG: inputMessage,
  GOAL_REFINE_INPUT_EMPTY: inputMessage,
  ACTION_GENERATE_INPUT_INCOMPLETE: inputMessage,
  ACTION_REFINE_INPUT_INCOMPLETE: inputMessage,
  CYCLE_COMPLETION_INPUT_INCOMPLETE: inputMessage,
  INVALID_GOAL_OUTCOME: inputMessage,
  INVALID_CURSOR: "一覧を先頭から読み込み直してください。",
  GOOGLE_ID_TOKEN_INVALID:
    "Googleアカウントを確認して、もう一度お試しください。",
  GOAL_REVIEW_DISCARD_CONFIRMATION_REQUIRED:
    "操作内容をもう一度確認してください。",
  GOAL_DELETE_CONFIRMATION_REQUIRED: "操作内容をもう一度確認してください。",
  ACCOUNT_DELETE_CONFIRMATION_REQUIRED: "操作内容をもう一度確認してください。",
  SESSION_MISSING:
    "セッションを確認できませんでした。もう一度認証してください。",
  SESSION_EXPIRED:
    "セッションが切れました。入力内容を保持したまま再認証します。",
  SESSION_IDENTITY_CHANGED:
    "セッションが切り替わりました。画面を読み込み直してください。",
  CSRF_INVALID: "ページを読み込み直して、もう一度お試しください。",
  ANONYMOUS_CREATION_BLOCKED:
    "現在、新しい利用を開始できません。時間をおいてお試しください。",
  GOAL_DRAFT_NOT_FOUND: notFoundMessage,
  GOAL_NOT_FOUND: notFoundMessage,
  CYCLE_NOT_FOUND: notFoundMessage,
  AI_SUGGESTION_NOT_FOUND: notFoundMessage,
  GOOGLE_ACCOUNT_NOT_LINKED: notFoundMessage,
  GOAL_ACTIVE_LIMIT_EXCEEDED:
    "取り組んでいる目標が上限に達しています。目標を整理してからお試しください。",
  GOAL_CREATION_DRAFT_ALREADY_EXISTS:
    "目標の下書きはすでにあります。既存の下書きを開いてください。",
  GOAL_DRAFT_TYPE_MISMATCH: conflictMessage,
  GOAL_DRAFT_REVISION_CONFLICT: conflictMessage,
  GOAL_REVIEW_NOT_ACTIVE: conflictMessage,
  GOAL_REVIEW_REQUIRED: conflictMessage,
  GOAL_REVIEW_DRAFT_REVISION_CONFLICT: conflictMessage,
  GOAL_REFINE_CONTEXT_STALE: conflictMessage,
  GOAL_REFINE_RESULT_ALREADY_ADOPTED: conflictMessage,
  GOAL_VERSION_CONFLICT: conflictMessage,
  GOAL_ALREADY_TERMINAL: conflictMessage,
  GOAL_STATE_CONFLICT: conflictMessage,
  GOAL_DELETE_CONFLICT: conflictMessage,
  CYCLE_NOT_ACTIVE: conflictMessage,
  CYCLE_REVISION_CONFLICT: conflictMessage,
  AI_OPERATION_IN_PROGRESS: "AI処理の完了をお待ちください。",
  ACTION_REPLACEMENT_CONFIRMATION_REQUIRED:
    "現在の内容を置き換えるか確認してください。",
  GOOGLE_IDENTITY_ALREADY_LINKED:
    "このGoogleアカウントは別のアカウントに接続されています。",
  IDEMPOTENCY_KEY_REUSED: operationMessage,
  AI_USER_ROLLING_LIMIT_EXCEEDED:
    "AIの利用上限に達しています。時間をおいてお試しください。",
  AI_RATE_LIMIT_EXCEEDED:
    "短時間のAI利用が続いています。時間をおいてお試しください。",
  RATE_LIMIT_EXCEEDED: "操作が続いています。時間をおいてお試しください。",
  AI_INVALID_RESPONSE: serviceMessage,
  AI_PROVIDER_UNAVAILABLE: serviceMessage,
  AI_SERVICE_BUDGET_EXCEEDED: serviceMessage,
  ANTI_ABUSE_SERVICE_UNAVAILABLE: serviceMessage,
  GOOGLE_IDENTITY_VERIFICATION_UNAVAILABLE: serviceMessage,
  AI_PROVIDER_TIMEOUT: serviceMessage,
  ACCOUNT_UPGRADE_FAILED: operationMessage,
  GOOGLE_LOGIN_FAILED: operationMessage,
  GOAL_DRAFT_SAVE_FAILED: preservedInputMessage,
  GOAL_DRAFT_DELETE_FAILED: operationMessage,
  GOAL_START_FAILED: preservedInputMessage,
  FRAME_SAVE_FAILED: preservedInputMessage,
  CYCLE_COMPLETION_FAILED: preservedInputMessage,
  GOAL_REVIEW_INVARIANT_BROKEN: operationMessage,
  GOAL_REVIEW_DRAFT_SAVE_FAILED: preservedInputMessage,
  GOAL_REVIEW_CONTINUE_FAILED: preservedInputMessage,
  GOAL_TERMINATION_FAILED: preservedInputMessage,
  GOAL_DELETE_FAILED: operationMessage,
  ACCOUNT_DELETE_FAILED: operationMessage,
  INTERNAL_ERROR: preservedInputMessage,
  BETA_ADMISSION_REQUIRED: "招待を確認してください。",
  BETA_ADMISSION_UNAVAILABLE: serviceMessage,
  BETA_INVITE_INVALID: "招待を確認できませんでした。",
} satisfies Readonly<Record<StableAPIErrorCode, string>>;

function requestIdOf(error: APIError): Readonly<{ requestId?: string }> {
  return isUUIDv7(error.requestId) ? { requestId: error.requestId } : {};
}

export function isStableAPIError(error: unknown): error is StableAPIError {
  return error instanceof APIError && isStableAPIErrorCode(error.code);
}

export function toErrorPresentation(error: unknown): ErrorPresentation {
  if (isStableAPIError(error)) {
    return {
      kind: "api",
      code: error.code,
      message: messageByCode[error.code],
      ...requestIdOf(error),
    };
  }
  if (error instanceof APIError) {
    const base = requestIdOf(error);
    if (error.code === "INVALID_ERROR_RESPONSE") {
      return {
        kind: "invalid-response",
        code: "INVALID_ERROR_RESPONSE",
        message:
          "サーバーから正しい応答を受け取れませんでした。もう一度お試しください。",
        ...base,
      };
    }
    return {
      kind: "unexpected",
      code: "UNEXPECTED_ERROR",
      message: "予期しないエラーが発生しました。もう一度お試しください。",
      ...base,
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "network",
      code: "NETWORK_ERROR",
      message: "通信できませんでした。接続を確認して、もう一度お試しください。",
    };
  }
  return {
    kind: "unexpected",
    code: "UNEXPECTED_ERROR",
    message: "予期しないエラーが発生しました。もう一度お試しください。",
  };
}
