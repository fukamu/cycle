import { APIError } from "../shared/api/client";
import { NetworkError } from "../shared/api/networkError";
import {
  createReactRootErrorOptions,
  reactRootErrorOptions,
} from "./reactRootErrorReporter";

const requestId = "00000000-0000-7000-8000-000000000001";

describe("React root error reporting", () => {
  it("reports only a fixed phase, safe presentation code, and validated request ID", () => {
    const report = vi.fn();
    const options = createReactRootErrorOptions(report);
    const runtimeFailure = Object.assign(
      new Error("private draft in message", {
        cause: new Error("provider secret in cause"),
      }),
      { details: { sql: "private SQL details" } },
    );
    const apiFailure = new APIError(
      500,
      "INTERNAL_ERROR",
      "private server message",
      requestId,
      { providerBody: "private provider body" },
    );

    options.onUncaughtError(runtimeFailure, {
      componentStack: "private uncaught component stack",
    });
    options.onCaughtError(apiFailure, {
      componentStack: "private caught component stack",
    });
    options.onRecoverableError(new NetworkError(), {
      componentStack: "private recoverable component stack",
    });

    expect(report.mock.calls).toEqual([
      [
        {
          event: "react-root-error",
          phase: "uncaught",
          code: "UNEXPECTED_ERROR",
        },
      ],
      [
        {
          event: "react-root-error",
          phase: "caught",
          code: "INTERNAL_ERROR",
          requestId,
        },
      ],
      [
        {
          event: "react-root-error",
          phase: "recoverable",
          code: "NETWORK_ERROR",
        },
      ],
    ]);
    const serialized = JSON.stringify(report.mock.calls);
    for (const secret of [
      "private draft",
      "provider secret",
      "private SQL",
      "private server",
      "private provider",
      "component stack",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not report an invalid request ID", () => {
    const report = vi.fn();
    const options = createReactRootErrorOptions(report);

    options.onCaughtError(
      new APIError(
        500,
        "INTERNAL_ERROR",
        "private message",
        "invalid-request-id\nprivate",
      ),
      { componentStack: "private stack" },
    );

    expect(report).toHaveBeenCalledWith({
      event: "react-root-error",
      phase: "caught",
      code: "INTERNAL_ERROR",
    });
  });

  it("uses the same sanitized shape for the production console reporter", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      reactRootErrorOptions.onUncaughtError(
        new Error("raw production secret"),
        { componentStack: "raw component stack" },
      );

      expect(consoleError).toHaveBeenCalledWith({
        event: "react-root-error",
        phase: "uncaught",
        code: "UNEXPECTED_ERROR",
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("stack");
    } finally {
      consoleError.mockRestore();
    }
  });
});
