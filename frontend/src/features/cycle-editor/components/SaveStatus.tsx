import type { SaveState } from "../model/eligibility";

type SaveStatusProps = {
  readonly state: SaveState;
  readonly onRetry: () => void;
};

export function SaveStatus({ state, onRetry }: SaveStatusProps) {
  if (state.kind === "saved")
    return <p className="save-status save-status--saved">● 保存済み</p>;
  if (state.kind === "saving") return <p className="save-status">○ 保存中…</p>;
  if (state.kind === "dirty")
    return <p className="save-status">○ 未保存の変更があります</p>;
  const conflict = state.errorCode === "CYCLE_REVISION_CONFLICT";
  return (
    <div className="save-status save-status--error" role="alert">
      <p>
        {conflict
          ? "この端末の未保存入力と別の更新が見つかりました。入力は端末に保持されています。"
          : "保存に失敗しました。入力は端末に保持されています。"}
      </p>
      {!conflict && (
        <button className="text-button" type="button" onClick={onRetry}>
          再試行
        </button>
      )}
    </div>
  );
}
