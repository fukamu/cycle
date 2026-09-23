import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

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
import { readPublicInformationConfiguration } from "../features/public-information/config";

type SettingsConfirmation =
  | { readonly kind: "google-login"; readonly credential: string }
  | { readonly kind: "delete-account" };

const accountSwitchMessage = "既存のFUKAMU Cycleアカウントへ切り替えました。";

export function SettingsPage() {
  const session = useSession();
  const publicInformation = readPublicInformationConfiguration();
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
      <section className="settings-card settings-privacy-card">
        <h2>データの取扱い・お問い合わせ</h2>
        <p>
          保存する情報、任意のAI送信、削除後の保持例外、問い合わせ窓口を確認できます。
        </p>
        <Link className="touch-target touch-target--inline" to="/legal/privacy">
          データの取扱いを確認
        </Link>
      </section>
      <section className="danger-zone">
        <h2>アカウントの削除</h2>
        <p>
          運用中のデータベースにある、アカウントに紐づく目標・PDCA履歴・Google連携・セッション等を削除します。削除後は取り出せません。バックアップ、匿名集計、端末データには下記の扱いがあります。
        </p>
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
          <ul className="account-deletion-disclosure">
            <li>
              運用中のデータベースにあるアカウント、Google連携、セッション、目標、Goal
              Version、PDCA、下書き、AI処理内容・利用記録を削除します。
            </li>
            <li>
              個人へ再関連付けできない月次の費用・運用集計は保持する場合があります。
            </li>
            <li>
              入力本文・認証トークン・安定した利用者識別子を記録しない設計の運用・障害調査データは、個別削除の対象ではありません。
            </li>
            <li>
              {publicInformation === undefined
                ? "バックアップの最大保持期間は未設定です。この状態では外部利用を開始できません。"
                : `バックアップには削除前の複製が最長${publicInformation.accountDeletionBackupMaxDays}日残る場合があります。`}
            </li>
            <li>
              このブラウザの下書き・一時表示データは、サーバー削除成功後に消去します。別端末では24時間で利用対象外になりますが、その端末を次に開くまで物理削除されない場合があります。
            </li>
          </ul>
          <p>
            この操作は取り消せず、削除後はデータを取り出せません。詳しくは
            <Link to="/legal/privacy#account-deletion">データの取扱い</Link>
            を確認してください。
          </p>
        </ConfirmationDialog>
      )}
    </main>
  );
}
