import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete window.turnstile;
  document
    .querySelectorAll('script[data-fukamu-cycle-turnstile="true"]')
    .forEach((script) => script.remove());
});

describe("getAnonymousBootstrapToken", () => {
  it("returns an empty token when Turnstile is disabled locally", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "");
    const { getAnonymousBootstrapToken } = await import("./turnstile");

    await expect(getAnonymousBootstrapToken()).resolves.toBe("");
    expect(document.querySelector("script")).toBeNull();
  });

  it("loads, executes, and removes an invisible widget", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "site-key");
    const remove = vi.fn();
    const execute = vi.fn((widgetId: string) => {
      expect(widgetId).toBe("widget-id");
      callback?.("verified-token");
    });
    let callback: ((token: string) => void) | undefined;
    const render = vi.fn(
      (_container: HTMLElement, options: Record<string, unknown>) => {
        expect(options.sitekey).toBe("site-key");
        expect(options.action).toBe("anonymous_bootstrap");
        expect(options.execution).toBe("execute");
        expect(options.size).toBe("invisible");
        callback = options.callback as (token: string) => void;
        return "widget-id";
      },
    );
    window.turnstile = { render, execute, remove };
    const { getAnonymousBootstrapToken } = await import("./turnstile");

    const token = getAnonymousBootstrapToken();
    const script = document.querySelector<HTMLScriptElement>(
      'script[data-fukamu-cycle-turnstile="true"]',
    );
    expect(script?.src).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    );
    script?.dispatchEvent(new Event("load"));

    await expect(token).resolves.toBe("verified-token");
    expect(render).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("widget-id");
  });
});
