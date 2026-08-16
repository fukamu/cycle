import { useSession } from "../features/auth/sessionContext";

export function SettingsPage() {
  const session = useSession();
  return (
    <main className="page settings-page">
      <header className="page-heading">
        <p className="eyebrow">ACCOUNT</p>
        <h1>設定</h1>
      </header>
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
          <button
            className="secondary-button"
            type="button"
            disabled
            title="Google Identity接続を準備中です"
          >
            Google Account 連携
          </button>
        )}
      </section>
      <section className="danger-zone">
        <h2>アカウントの削除</h2>
        <p>PDCA履歴を含むすべてのデータを削除します。</p>
        <button type="button" disabled title="削除APIを接続中です">
          アカウントを削除
        </button>
      </section>
    </main>
  );
}
