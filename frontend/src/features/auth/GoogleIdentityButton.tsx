import { useEffect, useRef, useState } from "react";

type CredentialResponse = { readonly credential?: string };
type GoogleAccounts = {
  readonly id: {
    readonly initialize: (options: {
      readonly client_id: string;
      readonly callback: (response: CredentialResponse) => void;
    }) => void;
    readonly renderButton: (
      parent: HTMLElement,
      options: Readonly<Record<string, string>>,
    ) => void;
  };
};

declare global {
  interface Window {
    google?: { readonly accounts?: GoogleAccounts };
  }
}

let googleScriptPromise: Promise<void> | undefined;

export function GoogleIdentityButton({
  onCredential,
  disabled = false,
}: {
  readonly onCredential: (credential: string) => void;
  readonly disabled?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const onCredentialRef = useRef(onCredential);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [loadAttempt, setLoadAttempt] = useState(0);
  const clientId = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as
    | string
    | undefined;

  useEffect(() => {
    onCredentialRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    void loadGoogleIdentity()
      .then(() => {
        if (!active || parent.current === null) return;
        const accounts = window.google?.accounts;
        if (accounts === undefined)
          throw new Error("Google Identity unavailable");
        accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response.credential)
              onCredentialRef.current(response.credential);
          },
        });
        parent.current.replaceChildren();
        accounts.id.renderButton(parent.current, {
          type: "standard",
          size: "large",
          theme: "outline",
          text: "continue_with",
          shape: "pill",
          locale: "ja",
          width: String(Math.min(parent.current.clientWidth || 320, 400)),
        });
        setLoadState("ready");
      })
      .catch(() => active && setLoadState("failed"));
    return () => {
      active = false;
    };
  }, [clientId, loadAttempt]);

  if (!clientId) {
    return (
      <p className="settings-hint">Google連携は運用設定後に利用できます。</p>
    );
  }
  if (loadState === "failed") {
    return (
      <div className="google-identity__error">
        <p className="inline-error" role="alert">
          Google認証を読み込めませんでした。通信状態を確認して、もう一度読み込んでください。
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() => {
            setLoadState("loading");
            setLoadAttempt((current) => current + 1);
          }}
        >
          Google認証を再読み込み
        </button>
      </div>
    );
  }
  return (
    <div
      className="google-identity"
      data-disabled={disabled || undefined}
      aria-busy={loadState === "loading" || disabled}
    >
      <div
        ref={parent}
        className="google-identity__button"
        aria-label="Google Account 連携"
      />
      {loadState === "loading" && (
        <span className="settings-hint" role="status">
          Google認証を読み込み中…
        </span>
      )}
    </div>
  );
}

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts !== undefined) return Promise.resolve();
  if (googleScriptPromise !== undefined) return googleScriptPromise;

  let ownedScript: HTMLScriptElement | undefined;
  const attempt = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    ownedScript = script;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.fukamuCycleGoogleIdentity = "true";
    script.addEventListener(
      "load",
      () => {
        if (window.google?.accounts === undefined) {
          reject(new Error("Google Identity unavailable"));
          return;
        }
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("Google Identity load failed")),
      { once: true },
    );
    document.head.append(script);
  });
  googleScriptPromise = attempt;
  void attempt.catch(() => {
    if (googleScriptPromise !== attempt) return;
    googleScriptPromise = undefined;
    ownedScript?.remove();
  });
  return attempt;
}
