import { useState } from "react";

import { appReferralUrl } from "./config";
import { shareAppReferral } from "./shareAppReferral";
import "./AppReferralPromotion.css";

type ShareState = "idle" | "sharing" | "shared" | "copied" | "error";

export function AppReferralPromotion() {
  const referralUrl = appReferralUrl();
  const [state, setState] = useState<ShareState>("idle");
  if (!referralUrl) return null;

  const share = async () => {
    setState("sharing");
    try {
      const result = await shareAppReferral(referralUrl);
      if (result === "canceled") {
        setState("idle");
        return;
      }
      setState(result);
    } catch {
      setState("error");
    }
  };

  return (
    <aside className="app-referral" aria-labelledby="app-referral-heading">
      <p className="eyebrow">SHARE FUKAMU Cycle</p>
      <h2 id="app-referral-heading">FUKAMU Cycleを友人・同僚に紹介</h2>
      <p className="app-referral__description">
        共有されるのはアプリの紹介リンクだけです。あなたの目標やPDCAの内容は含まれません。
      </p>
      <button
        className="button button--secondary"
        type="button"
        disabled={state === "sharing"}
        onClick={() => void share()}
      >
        {state === "sharing"
          ? "共有を準備中…"
          : "FUKAMU Cycleの紹介リンクを共有"}
      </button>
      {state === "shared" && (
        <p className="app-referral__status" role="status">
          紹介ありがとうございます。
        </p>
      )}
      {state === "copied" && (
        <p className="app-referral__status" role="status">
          紹介文とリンクをコピーしました。
        </p>
      )}
      {state === "error" && (
        <p className="app-referral__error" role="alert">
          紹介リンクを共有できませんでした。もう一度お試しください。
        </p>
      )}
    </aside>
  );
}
