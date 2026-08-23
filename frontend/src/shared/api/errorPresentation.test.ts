import { APIError, type APIErrorCode } from "./client";
import type { StableAPIErrorCode } from "./errorCodes";
import { isStableAPIError, toErrorPresentation } from "./errorPresentation";
import { NetworkError } from "./networkError";
import { parseAPIError } from "./schemas";

const requestId = "00000000-0000-7000-8000-000000000001";

describe("toErrorPresentation", () => {
  it("selects fixed copy by stable code without trusting the server message", () => {
    const presentation = toErrorPresentation(
      new APIError(
        500,
        "INTERNAL_ERROR",
        "database password=do-not-render",
        requestId,
      ),
    );

    expect(presentation).toEqual({
      kind: "api",
      code: "INTERNAL_ERROR",
      message:
        "処理中にエラーが発生しました。入力内容は保持されています。もう一度お試しください。",
      requestId,
    });
    expect(JSON.stringify(presentation)).not.toContain("do-not-render");
  });

  it("accepts and safely presents a changed session identity", () => {
    const parsed = parseAPIError({
      error: {
        code: "SESSION_IDENTITY_CHANGED",
        message: "private current-user context",
        requestId,
      },
    });
    expect(parsed.success).toBe(true);

    const presentation = toErrorPresentation(
      new APIError(
        409,
        "SESSION_IDENTITY_CHANGED",
        "private current-user context",
        requestId,
      ),
    );
    expect(presentation).toEqual({
      kind: "api",
      code: "SESSION_IDENTITY_CHANGED",
      message: "セッションが切り替わりました。画面を読み込み直してください。",
      requestId,
    });
    expect(JSON.stringify(presentation)).not.toContain(
      "private current-user context",
    );
  });

  it("preserves a constructed stable code as a literal type", () => {
    const error = new APIError(
      409,
      "GOAL_VERSION_CONFLICT",
      "ignored",
      requestId,
    );
    expectTypeOf(error.code).toEqualTypeOf<"GOAL_VERSION_CONFLICT">();
  });

  it("excludes private and misspelled codes from the constructor code type", () => {
    type PrivateCodeIsAllowed = "PRIVATE_PROVIDER_FAILURE" extends APIErrorCode
      ? true
      : false;
    type MisspelledCodeIsAllowed = "GOAL_VERSOIN_CONFLICT" extends APIErrorCode
      ? true
      : false;

    expectTypeOf<PrivateCodeIsAllowed>().toEqualTypeOf<false>();
    expectTypeOf<MisspelledCodeIsAllowed>().toEqualTypeOf<false>();
  });

  it("narrows only documented stable API codes", () => {
    expect(
      isStableAPIError(
        new APIError(409, "GOAL_VERSION_CONFLICT", "ignored", requestId),
      ),
    ).toBe(true);
    expect(
      isStableAPIError(
        new APIError(502, "INVALID_ERROR_RESPONSE", "ignored", requestId),
      ),
    ).toBe(false);
  });

  it("parses the wire error code as a stable union and rejects unknown codes", () => {
    const parsed = parseAPIError({
      error: {
        code: "GOAL_VERSION_CONFLICT",
        message: "untrusted",
        requestId,
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected a parsed stable error");
    expectTypeOf(parsed.data.error.code).toEqualTypeOf<StableAPIErrorCode>();

    expect(
      parseAPIError({
        error: {
          code: "PROVIDER_RAW_FAILURE",
          message: "secret",
          requestId,
        },
      }).success,
    ).toBe(false);
  });

  it("normalizes an unrecognized runtime error without exposing its fields", () => {
    const presentation = toErrorPresentation(
      Object.assign(new Error("provider token=do-not-render"), {
        code: "PROVIDER_RAW_FAILURE",
        requestId,
      }),
    );

    expect(presentation).toEqual({
      kind: "unexpected",
      code: "UNEXPECTED_ERROR",
      message: "予期しないエラーが発生しました。もう一度お試しください。",
    });
    expect(JSON.stringify(presentation)).not.toContain("PROVIDER_RAW_FAILURE");
    expect(JSON.stringify(presentation)).not.toContain("do-not-render");
  });

  it("distinguishes a malformed response and rejects an invalid request ID", () => {
    const presentation = toErrorPresentation(
      new APIError(
        502,
        "INVALID_ERROR_RESPONSE",
        "<html>upstream secret</html>",
        "not-a-request-id\nsecret",
      ),
    );

    expect(presentation).toEqual({
      kind: "invalid-response",
      code: "INVALID_ERROR_RESPONSE",
      message:
        "サーバーから正しい応答を受け取れませんでした。もう一度お試しください。",
    });
  });

  it("presents network and arbitrary runtime failures with safe fixed copy", () => {
    expect(toErrorPresentation(new NetworkError())).toEqual({
      kind: "network",
      code: "NETWORK_ERROR",
      message: "通信できませんでした。接続を確認して、もう一度お試しください。",
    });

    const runtimeTypeError = toErrorPresentation(
      new Error("stack includes private user content"),
    );
    expect(runtimeTypeError).toEqual({
      kind: "unexpected",
      code: "UNEXPECTED_ERROR",
      message: "予期しないエラーが発生しました。もう一度お試しください。",
    });
    expect(JSON.stringify(runtimeTypeError)).not.toContain(
      "private user content",
    );

    expect(toErrorPresentation(new TypeError("programming failure"))).toEqual({
      kind: "unexpected",
      code: "UNEXPECTED_ERROR",
      message: "予期しないエラーが発生しました。もう一度お試しください。",
    });
  });
});
