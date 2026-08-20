import { useCallback, useState } from "react";

import { GoogleIdentityButton } from "../features/auth/GoogleIdentityButton";
import { useReplaceSession, useSession } from "../features/auth/sessionContext";
import { ConfirmationDialog } from "../shared/components/ConfirmationDialog";
import { clearUserDrafts } from "../shared/drafts/browserDraftCache";
import {
  deleteAccount,
  loginGoogle,
  upgradeGoogle,
} from "../shared/api/account";
import { APIError } from "../shared/api/client";

type SettingsConfirmation =
  | { readonly kind: "google-login"; readonly credential: string }
  | { readonly kind: "delete-account" };

export function SettingsPage() {
  const session = useSession();
  const replaceSession = useReplaceSession();
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<SettingsConfirmation>();
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
          cause.code === "GOOGLE_IDENTITY_ALREADY_LINKED"
        ) {
          setConfirmation({ kind: "google-login", credential });
          return;
        }
        setError(errorMessage(cause, "Google Accountを連携できませんでした。"));
      } finally {
        setPending(false);
      }
    },
    [replaceSession, session.csrfToken],
  );

  async function loginExistingGoogle(credential: string) {
    setPending(true);
    setError(undefined);
    try {
      const loggedIn = await loginGoogle(credential, session.csrfToken);
      replaceSession(loggedIn);
      setMessage("既存のPDCAIアカウントへ切り替えました。");
    } catch (cause) {
      setError(errorMessage(cause, "Googleログインに失敗しました。"));
    } finally {
      setPending(false);
    }
  }

  async function removeAccount() {
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
          {session.user.googleConnected && (
            <span className="settings-account-detail">
              {session.user.googleEmail ??
                "連携したメールアドレスは取得できませんでした"}
            </span>
          )}
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
          onClick={() => setConfirmation({ kind: "delete-account" })}
        >
          {pending ? "処理中…" : "アカウントを削除"}
        </button>
      </section>
      {confirmation?.kind === "google-login" && (
        <ConfirmationDialog
          title="既存のアカウントでログインしますか？"
          confirmLabel="既存アカウントでログイン"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            const { credential } = confirmation;
            setConfirmation(undefined);
            void loginExistingGoogle(credential);
          }}
        >
          <p>
            このGoogle
            Accountは既存のPDCAIアカウントに連携されています。現在の匿名データは統合されません。
          </p>
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "delete-account" && (
        <ConfirmationDialog
          title="アカウントを削除しますか？"
          confirmLabel="アカウントを削除"
          confirmTone="danger"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            setConfirmation(undefined);
            void removeAccount();
          }}
        >
          <p>
            目標・Goal
            Version・PDCAサイクルを含むすべてのアカウントデータを削除します。この操作は取り消せません。
          </p>
        </ConfirmationDialog>
      )}
    </main>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof APIError
    ? `${cause.message}（${cause.code}）`
    : fallback;
}
