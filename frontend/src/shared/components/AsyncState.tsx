export function PageLoading() {
  return (
    <main className="page">
      <p className="app-message" role="status" aria-live="polite">
        読み込んでいます…
      </p>
    </main>
  );
}

export function DraftRecoveryNotice({
  onRestore,
  onDiscard,
}: {
  readonly onRestore: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <div className="draft-notice draft-notice--conflict" role="alert">
      <div>
        <strong>別の更新が見つかりました</strong>
        <p>
          この端末に残っていた入力を表示しています。自動送信せず、選択を待っています。
        </p>
      </div>
      <div className="button-row">
        <button
          className="button button--primary"
          type="button"
          onClick={onRestore}
        >
          この端末の入力を復元
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={onDiscard}
        >
          サーバーの内容を使用
        </button>
      </div>
    </div>
  );
}

export function DraftCacheWarning() {
  return (
    <p className="draft-notice draft-notice--warning" role="alert">
      この端末の復旧用保存を利用できません。サーバーへの保存完了を確認してから画面を閉じてください。
    </p>
  );
}
export function PageError({ retry }: { readonly retry: () => void }) {
  return (
    <main className="page">
      <div className="app-message app-message--error" role="alert">
        <p>読み込めませんでした。</p>
        <button type="button" onClick={retry}>
          再試行
        </button>
      </div>
    </main>
  );
}
export function SaveBadge({
  state,
  retry,
}: {
  readonly state: "dirty" | "saving" | "saved" | "failed";
  readonly retry?: (() => void) | undefined;
}) {
  if (state === "failed")
    return (
      <div className="save-status save-status--error" role="alert">
        保存失敗{" "}
        {retry && (
          <button type="button" className="text-button" onClick={retry}>
            再試行
          </button>
        )}
      </div>
    );
  return (
    <p
      className={
        state === "saved" ? "save-status save-status--saved" : "save-status"
      }
    >
      {state === "dirty"
        ? "未保存"
        : state === "saving"
          ? "保存中"
          : "保存済み"}
    </p>
  );
}
