export function PageLoading() {
  return (
    <main className="page">
      <p className="app-message">読み込んでいます…</p>
    </main>
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
  readonly retry?: () => void;
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
