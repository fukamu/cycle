const action = "anonymous_bootstrap";

type Turnstile = {
  readonly render: (
    container: HTMLElement,
    options: {
      readonly sitekey: string;
      readonly action: string;
      readonly execution: "execute";
      readonly size: "invisible";
      readonly callback: (token: string) => void;
      readonly "error-callback": () => void;
      readonly "expired-callback": () => void;
      readonly "timeout-callback": () => void;
    },
  ) => string;
  readonly execute: (widgetId: string) => void;
  readonly remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let scriptPromise: Promise<void> | undefined;

export async function getAnonymousBootstrapToken(): Promise<string> {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  if (!siteKey) return "";
  await loadScript();
  const turnstile = window.turnstile;
  if (turnstile === undefined) {
    throw new Error("Cloudflare Turnstileを読み込めませんでした。");
  }

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  document.body.append(container);
  return new Promise<string>((resolve, reject) => {
    const widget: { id?: string } = {};
    const cleanup = () => {
      if (widget.id !== undefined) turnstile.remove(widget.id);
      container.remove();
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    widget.id = turnstile.render(container, {
      sitekey: siteKey,
      action,
      execution: "execute",
      size: "invisible",
      callback: (token) => {
        cleanup();
        resolve(token);
      },
      "error-callback": () => fail("Turnstile verification failed"),
      "expired-callback": () => fail("Turnstile token expired"),
      "timeout-callback": () => fail("Turnstile verification timed out"),
    });
    turnstile.execute(widget.id);
  });
}

function loadScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-pdcai-turnstile="true"]',
    );
    if (existing !== null) {
      if (window.turnstile !== undefined) resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Turnstile load failed")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.pdcaiTurnstile = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Turnstile load failed")),
      { once: true },
    );
    document.head.append(script);
  });
  return scriptPromise;
}
