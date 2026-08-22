import { type FormEvent, useState } from "react";

import { APIError } from "../../shared/api/client";
import { redeemBetaInvite } from "./api";
import {
  clearInitialBetaInviteToken,
  getInitialBetaInviteToken,
} from "./inviteFragment";
import "./BetaAdmissionGate.css";

type BetaAdmissionGateProps = {
  readonly onAdmitted: () => Promise<unknown>;
};

export function BetaAdmissionGate({ onAdmitted }: BetaAdmissionGateProps) {
  const [token, setToken] = useState(getInitialBetaInviteToken);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = token.trim();
    if (candidate === "") {
      setError("招待Tokenを入力してください。");
      return;
    }

    setPending(true);
    setError("");
    try {
      await redeemBetaInvite(candidate);
      clearInitialBetaInviteToken();
      setToken("");
      await onAdmitted();
    } catch (cause) {
      if (cause instanceof APIError && cause.code === "BETA_INVITE_INVALID") {
        setError("招待Tokenを確認できませんでした。入力内容をご確認ください。");
      } else if (
        cause instanceof APIError &&
        cause.code === "BETA_ADMISSION_UNAVAILABLE"
      ) {
        setError(
          "現在、新しい利用を開始できません。時間を空けてお試しください。",
        );
      } else {
        setError("招待Tokenを確認できませんでした。もう一度お試しください。");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="beta-admission">
      <section className="beta-admission__card" aria-labelledby="beta-heading">
        <p className="beta-admission__eyebrow">FUKAMU Cycle Closed Beta</p>
        <h1 id="beta-heading">招待された方のみご利用いただけます</h1>
        <p className="beta-admission__description">
          招待時にお送りしたTokenを入力してください。このブラウザでの確認は初回だけです。
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="beta-invite-token">招待Token</label>
          <input
            id="beta-invite-token"
            name="betaInviteToken"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={pending}
          />
          {error !== "" && (
            <p className="beta-admission__error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" type="submit" disabled={pending}>
            {pending ? "確認しています…" : "利用を開始する"}
          </button>
        </form>
      </section>
    </main>
  );
}
