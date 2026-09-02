import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { APIError } from "../shared/api/client";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { RouteModuleLoadError } from "./routeModuleLoader";

const requestId = "00000000-0000-7000-8000-000000000001";

describe("AppErrorBoundary", () => {
  it("replaces a render failure with a safe alert and can retry", async () => {
    const user = userEvent.setup();
    const reloadRouteModule = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let shouldThrow = true;

    function UnstableContent() {
      if (shouldThrow) throw new Error("stack contains private draft text");
      return <h1>回復しました</h1>;
    }

    try {
      render(
        <AppErrorBoundary onRouteModuleRetry={reloadRouteModule}>
          <UnstableContent />
        </AppErrorBoundary>,
      );

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(
        "予期しないエラーが発生しました。もう一度お試しください。",
      );
      expect(alert).not.toHaveTextContent("private draft text");

      shouldThrow = false;
      await user.click(screen.getByRole("button", { name: "再試行" }));
      expect(
        screen.getByRole("heading", { name: "回復しました" }),
      ).toBeInTheDocument();
      expect(reloadRouteModule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("requests a full reload when retrying a route module load failure", async () => {
    const user = userEvent.setup();
    const reloadRouteModule = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    function FailingRoute(): never {
      throw new RouteModuleLoadError();
    }

    try {
      render(
        <AppErrorBoundary onRouteModuleRetry={reloadRouteModule}>
          <FailingRoute />
        </AppErrorBoundary>,
      );

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(
        "予期しないエラーが発生しました。もう一度お試しください。",
      );
      await user.click(screen.getByRole("button", { name: "再試行" }));

      expect(reloadRouteModule).toHaveBeenCalledOnce();
      expect(alert).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shows only a validated request ID from an API failure", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    function FailingContent(): never {
      throw new APIError(
        500,
        "INTERNAL_ERROR",
        "SQL and provider secret must stay hidden",
        requestId,
      );
    }

    try {
      render(
        <AppErrorBoundary>
          <FailingContent />
        </AppErrorBoundary>,
      );

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("問い合わせID: " + requestId);
      expect(alert).not.toHaveTextContent("SQL");
      expect(alert).not.toHaveTextContent("provider secret");
    } finally {
      consoleError.mockRestore();
    }
  });
});
