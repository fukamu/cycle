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

  it("shares a failed script attempt and retries once on the next call", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "site-key");
    const { getAnonymousBootstrapToken } = await import("./turnstile");

    const firstToken = getAnonymousBootstrapToken();
    const concurrentToken = getAnonymousBootstrapToken();
    const failedScript = document.querySelector<HTMLScriptElement>(
      'script[data-fukamu-cycle-turnstile="true"]',
    );
    expect(failedScript).not.toBeNull();
    expect(
      document.querySelectorAll('script[data-fukamu-cycle-turnstile="true"]'),
    ).toHaveLength(1);

    failedScript?.dispatchEvent(new Event("error"));

    await expect(firstToken).rejects.toThrow("Turnstile load failed");
    await expect(concurrentToken).rejects.toThrow("Turnstile load failed");
    expect(failedScript?.isConnected).toBe(false);
    expect(
      document.querySelectorAll('script[data-fukamu-cycle-turnstile="true"]'),
    ).toHaveLength(0);

    const callbacks = new Map<string, (token: string) => void>();
    const remove = vi.fn();
    const render = vi.fn(
      (_container: HTMLElement, options: Record<string, unknown>) => {
        const widgetId = `widget-${String(callbacks.size + 1)}`;
        callbacks.set(widgetId, options.callback as (token: string) => void);
        return widgetId;
      },
    );
    const execute = vi.fn((widgetId: string) => {
      callbacks.get(widgetId)?.(`token-${widgetId}`);
    });
    window.turnstile = { render, execute, remove };

    const retryToken = getAnonymousBootstrapToken();
    const concurrentRetryToken = getAnonymousBootstrapToken();
    const retryScript = document.querySelector<HTMLScriptElement>(
      'script[data-fukamu-cycle-turnstile="true"]',
    );
    expect(retryScript).not.toBe(failedScript);
    expect(
      document.querySelectorAll('script[data-fukamu-cycle-turnstile="true"]'),
    ).toHaveLength(1);

    retryScript?.dispatchEvent(new Event("load"));

    await expect(retryToken).resolves.toBe("token-widget-1");
    await expect(concurrentRetryToken).resolves.toBe("token-widget-2");
    expect(render).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(
      document.querySelectorAll('script[data-fukamu-cycle-turnstile="true"]'),
    ).toHaveLength(1);
  });

  it("does not remove a failed matching script it did not create", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "site-key");
    const externalScript = document.createElement("script");
    externalScript.dataset.fukamuCycleTurnstile = "true";
    document.head.append(externalScript);
    const { getAnonymousBootstrapToken } = await import("./turnstile");

    const token = getAnonymousBootstrapToken();
    externalScript.dispatchEvent(new Event("error"));

    await expect(token).rejects.toThrow("Turnstile load failed");
    expect(externalScript.isConnected).toBe(true);
  });

  it("handles a widget error without allowing Turnstile's default retry", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "site-key");
    const remove = vi.fn();
    const execute = vi.fn((widgetId: string) => {
      expect(widgetId).toBe("widget-id");
      expect(errorCallback?.("110200")).toBe(true);
    });
    let errorCallback: ((errorCode: string) => boolean) | undefined;
    const render = vi.fn(
      (_container: HTMLElement, options: Record<string, unknown>) => {
        errorCallback = options["error-callback"] as (
          errorCode: string,
        ) => boolean;
        return "widget-id";
      },
    );
    window.turnstile = { render, execute, remove };
    const { getAnonymousBootstrapToken } = await import("./turnstile");

    const token = getAnonymousBootstrapToken();
    document
      .querySelector<HTMLScriptElement>(
        'script[data-fukamu-cycle-turnstile="true"]',
      )
      ?.dispatchEvent(new Event("load"));

    await expect(token).rejects.toThrow(
      "Turnstile verification failed (110200)",
    );
    expect(remove).toHaveBeenCalledWith("widget-id");
    expect(
      document.querySelectorAll('script[data-fukamu-cycle-turnstile="true"]'),
    ).toHaveLength(1);
  });
});
