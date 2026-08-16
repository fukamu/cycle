const action = "anonymous_bootstrap";

type RecaptchaEnterprise = {
  readonly ready: (callback: () => void) => void;
  readonly execute: (
    siteKey: string,
    options: { readonly action: string },
  ) => Promise<string>;
};

declare global {
  interface Window {
    grecaptcha?: { readonly enterprise?: RecaptchaEnterprise };
  }
}

let scriptPromise: Promise<void> | undefined;

export async function getAnonymousBootstrapToken(): Promise<string> {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
  if (!siteKey) return "";
  await loadScript(siteKey);
  const enterprise = window.grecaptcha?.enterprise;
  if (enterprise === undefined) {
    throw new Error("reCAPTCHA Enterpriseを読み込めませんでした。");
  }
  await new Promise<void>((resolve) => enterprise.ready(resolve));
  return enterprise.execute(siteKey, { action });
}

function loadScript(siteKey: string): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-pdcai-recaptcha="true"]',
    );
    if (existing !== null) {
      if (window.grecaptcha?.enterprise !== undefined) resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("reCAPTCHA load failed")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`;
    script.async = true;
    script.defer = true;
    script.dataset.pdcaiRecaptcha = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("reCAPTCHA load failed")),
      { once: true },
    );
    document.head.append(script);
  });
  return scriptPromise;
}
