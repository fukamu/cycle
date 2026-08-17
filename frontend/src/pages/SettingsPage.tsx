import { useCallback, useState } from "react";

import { GoogleIdentityButton } from "../features/auth/GoogleIdentityButton";
import { useReplaceSession, useSession } from "../features/auth/sessionContext";
import { clearUserDrafts } from "../features/cycle-editor/draft/draftRepository";
import {
  deleteAccount,
  loginGoogle,
  upgradeGoogle,
} from "../shared/api/account";
import { APIError } from "../shared/api/client";

export function SettingsPage() {
  const session = useSession();
  const replaceSession = useReplaceSession();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const connect = useCallback(
    async (credential: string) => {
      setPending(true);
      setError(undefined);
      try {
        const upgraded = await upgradeGoogle(credential, session.csrfToken);
        replaceSession(upgraded);
        setMessage("Google Accountを連携しました。");
      } catch (cause) {
        if (
          cause instanceof APIError &&
          cause.code === "GOOGLE_IDENTITY_ALREADY_LINKED" &&
          window.confirm(
            "このGoogle Accountは既存のPDCAIアカウントに連携されています。既存アカウントでログインしますか？現在の匿名データは統合されません。",
          )
        ) {
          try {
            const loggedIn = await loginGoogle(credential, session.csrfToken);
            replaceSession(loggedIn);
            setMessage("既存のPDCAIアカウントへ切り替えました。");
            return;
          } catch (loginCause) {
            setError(
              errorMessage(loginCause, "Googleログインに失敗しました。"),
            );
            return;
          }
        }
        setError(errorMessage(cause, "Google Accountを連携できませんでした。"));
      } finally {
        setPending(false);
      }
    },
    [replaceSession, session.csrfToken],
  );

  async function removeAccount() {
    if (
      !window.confirm(
        "PDCA履歴を含むすべてのアカウントデータを削除します。この操作は取り消せません。削除しますか？",
      )
    ) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await deleteAccount(session.csrfToken);
      await clearUserDrafts(session.user.id);
      window.location.assign("/");
    } catch (cause) {
      setError(errorMessage(cause, "アカウントを削除できませんでした。"));
      setPending(false);
    }
  }

  return (
    <main className="page settings-page">
      <header className="page-heading">
        <p className="eyebrow">ACCOUNT</p>
        <h1>設定</h1>
      </header>
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <section className="settings-card">
        <div>
          <span>User ID</span>
          <code>{session.user.id}</code>
        </div>
        <div>
          <span>Google Account</span>
          <strong>
            {session.user.googleConnected ? "連携済み" : "未連携"}
          </strong>
        </div>
        {!session.user.googleConnected && (
          <GoogleIdentityButton onCredential={connect} disabled={pending} />
        )}
      </section>
      <section className="danger-zone">
        <h2>アカウントの削除</h2>
        <p>PDCA履歴を含むすべてのデータを削除します。</p>
        <button
          type="button"
          disabled={pending}
          onClick={() => void removeAccount()}
        >
          {pending ? "処理中…" : "アカウントを削除"}
        </button>
      </section>
    </main>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof APIError
    ? `${cause.message}（${cause.code}）`
    : fallback;
}
