import { useCallback, useState } from "react";

import { GoogleIdentityButton } from "../features/auth/GoogleIdentityButton";
import { useDeleteCurrentAccount } from "../features/auth/accountDeletionContext";
import {
  useAccountSwitchNotice,
  useAnnounceAccountSwitch,
} from "../features/auth/sessionTransitionNoticeContext";
import {
  useRunSessionTransition,
  useSession,
} from "../features/auth/sessionContext";
import { ConfirmationDialog } from "../shared/components/ConfirmationDialog";
import { loginGoogle, upgradeGoogle } from "../shared/api/account";
import { APIError } from "../shared/api/client";
import {
  toErrorPresentation,
  type ErrorPresentation,
} from "../shared/api/errorPresentation";

type SettingsConfirmation =
  | { readonly kind: "google-login"; readonly credential: string }
  | { readonly kind: "delete-account" };

const accountSwitchMessage = "既存のFUKAMU Cycleアカウントへ切り替えました。";

export function SettingsPage() {
  const session = useSession();
  const runSessionTransition = useRunSessionTransition();
  const deleteCurrentAccount = useDeleteCurrentAccount();
  const announceAccountSwitch = useAnnounceAccountSwitch();
  const accountSwitchNotice = useAccountSwitchNotice(session.user.id);
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<SettingsConfirmation>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<ErrorPresentation>();

  const connect = useCallback(
    async (credential: string) => {
      setPending(true);
      setError(undefined);
      try {
        await runSessionTransition(session.user.id, (currentSession, lease) =>
          upgradeGoogle(lease, credential, currentSession.csrfToken),
        );
        setMessage("Google Accountを連携しました。");
      } catch (cause) {
        if (
          cause instanceof APIError &&
          cause.code === "GOOGLE_IDENTITY_ALREADY_LINKED"
        ) {
          setConfirmation({ kind: "google-login", credential });
          return;
        }
        setError(toErrorPresentation(cause));
      } finally {
        setPending(false);
      }
    },
    [runSessionTransition, session.user.id],
  );

  async function loginExistingGoogle(credential: string) {
    setPending(true);
    setError(undefined);
    try {
      const { previousSession, session: loggedIn } = await runSessionTransition(
        session.user.id,
        (currentSession, lease) =>
          loginGoogle(lease, credential, currentSession.csrfToken),
      );
      const previousUserId = previousSession.user.id;
      if (loggedIn.user.id === previousUserId) {
        setMessage("Google Accountを連携しました。");
        return;
      }
      announceAccountSwitch(previousUserId, loggedIn.user.id);
    } catch (cause) {
      setError(toErrorPresentation(cause));
    } finally {
      setPending(false);
    }
  }

  async function removeAccount() {
    setPending(true);
    setError(undefined);
    try {
      await deleteCurrentAccount();
    } catch (cause) {
      setError(toErrorPresentation(cause));
      setPending(false);
    }
  }

  return (
    <main className="page settings-page">
      <header className="page-heading">
        <p className="eyebrow">ACCOUNT</p>
        <h1>設定</h1>
      </header>
      {(message || accountSwitchNotice) && (
        <p className="settings-message" role="status">
          {accountSwitchNotice ? accountSwitchMessage : message}
        </p>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <p>{error.message}</p>
          {error.requestId !== undefined && (
            <p>
              問い合わせID: <code>{error.requestId}</code>
            </p>
          )}
        </div>
      )}
      <section className="settings-card">
        <div className="settings-field">
          <span>User ID</span>
          <code>{session.user.id}</code>
        </div>
        <div className="settings-field">
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
            このGoogle Accountは既存のFUKAMU
            Cycleアカウントに連携されています。現在の匿名データは統合されません。
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
