import { StrictMode, isValidElement, type ReactNode } from "react";

import { AppRoot } from "./AppRoot";
import { mountApplication } from "./mountApplication";
import { reactRootErrorOptions } from "./reactRootErrorReporter";

const rootMocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
  unmount: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  createRoot: rootMocks.createRoot,
}));

describe("mountApplication", () => {
  it("passes every sanitized error callback to the production React root", () => {
    rootMocks.createRoot.mockReturnValue({
      render: rootMocks.render,
      unmount: rootMocks.unmount,
    });
    const container = document.createElement("div");

    mountApplication(container);

    expect(rootMocks.createRoot).toHaveBeenCalledWith(
      container,
      reactRootErrorOptions,
    );
    const rendered = rootMocks.render.mock.calls[0]?.[0];
    expect(isValidElement<{ children: ReactNode }>(rendered)).toBe(true);
    if (!isValidElement<{ children: ReactNode }>(rendered)) {
      throw new Error("expected a React element");
    }
    expect(rendered.type).toBe(StrictMode);
    const application = rendered.props.children;
    expect(isValidElement(application)).toBe(true);
    if (!isValidElement(application)) throw new Error("expected AppRoot");
    expect(application.type).toBe(AppRoot);
  });
});
