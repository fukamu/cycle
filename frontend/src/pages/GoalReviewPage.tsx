import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import type { AIResponse, GoalReview } from "../shared/api/schemas";
import {
  adoptReview,
  continueReview,
  deleteGoal,
  getReview,
  refineReview,
  saveReview,
  terminateGoal,
} from "../shared/api/workspace";
import {
  PageError,
  PageLoading,
  SaveBadge,
} from "../shared/components/AsyncState";
import { frameCopy } from "../shared/copy/ja";
import { useDraftAutoSave } from "../shared/hooks/useDraftAutoSave";

export function GoalReviewPage() {
  const { goalId = "" } = useParams();
  const query = useQuery({
    queryKey: ["goal", goalId, "review"],
    queryFn: () => getReview(goalId),
  });
  if (query.isPending) return <PageLoading />;
  if (query.isError) return <PageError retry={() => void query.refetch()} />;
  return <ReviewEditor key={query.data.reviewDraft.id} review={query.data} />;
}

type Refine =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "suggested"; response: AIResponse }
  | { kind: "failed" };

function ReviewEditor({ review }: { readonly review: GoalReview }) {
  const { goal, reviewDraft, triggerCycle } = review;
  const session = useSession();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [refine, setRefine] = useState<Refine>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const requestBody = useRef("");
  const save = useCallback(
    async (body: string, revision: number) =>
      (await saveReview(goal.id, body, revision, session.csrfToken))
        .reviewDraft,
    [goal.id, session.csrfToken],
  );
  const editor = useDraftAutoSave({
    userId: session.user.id,
    subjectKey: `goal-review:${goal.id}`,
    initialBody: reviewDraft.body,
    initialRevision: reviewDraft.revision,
    save,
  });
  const count = Array.from(editor.body).length;
  const changed =
    editor.body.replaceAll("\r\n", "\n").trim() !==
    goal.currentVersion.body.replaceAll("\r\n", "\n").trim();

  async function requestRefine() {
    setRefine({ kind: "running" });
    setError(undefined);
    requestBody.current = editor.body;
    try {
      const response = await refineReview(
        goal.id,
        editor.revision,
        goal.revision,
        session.csrfToken,
      );
      setRefine({
        kind: "suggested",
        response: {
          ...response,
          contextChanged:
            response.contextChanged || requestBody.current !== editor.body,
        },
      });
    } catch {
      setRefine({ kind: "failed" });
    }
  }
  async function adopt() {
    if (refine.kind !== "suggested") return;
    setPending(true);
    try {
      const result = await adoptReview(
        goal.id,
        refine.response.generationId,
        editor.revision,
        goal.revision,
        session.csrfToken,
      );
      editor.synchronize(result.reviewDraft.body, result.reviewDraft.revision);
      setRefine({ kind: "idle" });
    } catch {
      setError("提案を採用できませんでした。現在の下書きを確認してください。");
    } finally {
      setPending(false);
    }
  }
  async function nextCycle() {
    setPending(true);
    setError(undefined);
    try {
      const result = await continueReview(
        goal.id,
        goal.revision,
        editor.revision,
        session.csrfToken,
      );
      await cache.invalidateQueries();
      navigate(`/goals/${goal.id}/cycles/${result.cycle.id}`, {
        replace: true,
      });
    } catch {
      setError(
        "次のサイクルを開始できませんでした。保存状態を確認してください。",
      );
      setPending(false);
    }
  }
  async function terminate(outcome: "achieved" | "ended") {
    const label = outcome === "achieved" ? "達成として終了" : "終了";
    const discard = changed
      ? `\nこの変更案は、次のサイクルを開始しないため保存されません。\n現在の目標のまま${outcome === "achieved" ? "達成として終了" : "終了"}します。`
      : "";
    if (!window.confirm(`目標を${label}しますか？${discard}`)) return;
    setPending(true);
    setError(undefined);
    try {
      await terminateGoal(
        goal.id,
        outcome,
        goal.revision,
        "goal_review",
        session.csrfToken,
      );
      await cache.invalidateQueries();
      navigate("/", { replace: true });
    } catch {
      setError(`目標を${label}できませんでした。`);
      setPending(false);
    }
  }
  async function remove() {
    if (
      !window.confirm(
        "この目標とすべてのCycle履歴を完全に削除します。この操作は取り消せません。",
      )
    )
      return;
    setPending(true);
    try {
      await deleteGoal(goal.id, goal.revision, session.csrfToken);
      await cache.invalidateQueries();
      navigate("/", { replace: true });
    } catch {
      setError("目標を削除できませんでした。");
      setPending(false);
    }
  }
  const stale =
    refine.kind === "suggested" &&
    (refine.response.contextChanged ||
      refine.response.sourceDraftRevision !== editor.revision ||
      editor.state !== "saved");
  const valid = editor.body.trim().length > 0 && count <= 500;
  return (
    <main className="page review-page">
      <header className="goal-context">
        <p className="eyebrow">GOAL REVIEW</p>
        <h1>{goal.currentVersion.body}</h1>
        <p>
          Goal v{goal.currentVersion.versionNumber} · Cycle{" "}
          {triggerCycle.sequenceNumber} を完了しました
        </p>
      </header>
      <details className="cycle-summary" open>
        <summary>直前のCycleを振り返る</summary>
        {(["plan", "do", "check", "action"] as const).map((frame) => (
          <div key={frame}>
            <h3>
              {frameCopy[frame].label} — {frameCopy[frame].name}
            </h3>
            <p>{triggerCycle[frame]}</p>
          </div>
        ))}
      </details>
      <section className="editor-card">
        <label htmlFor="review-goal">次のサイクルで目指す目標</label>
        <textarea
          id="review-goal"
          value={editor.body}
          maxLength={500}
          onChange={(event) => editor.setBody(event.target.value)}
        />
        <div className="editor-meta">
          <SaveBadge state={editor.state} retry={editor.retry} />
          <span>{count} / 500</span>
        </div>
        <div className="button-row">
          <button
            className="button button--secondary"
            type="button"
            disabled={
              !valid ||
              editor.state !== "saved" ||
              refine.kind === "running" ||
              pending
            }
            onClick={() => void requestRefine()}
          >
            {refine.kind === "running"
              ? "AIが整理しています…"
              : "AIで目標を整える"}
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={
              !valid ||
              editor.state !== "saved" ||
              refine.kind === "running" ||
              pending
            }
            onClick={() => void nextCycle()}
          >
            この目標で次のサイクルへ
          </button>
        </div>
        <p className="next-cycle-note">
          {changed
            ? `変更した目標をGoal v${goal.currentVersion.versionNumber + 1}として保存し、Cycle ${goal.nextCycleSequenceNumber}を開始します`
            : `目標を維持してCycle ${goal.nextCycleSequenceNumber}を開始します`}
        </p>
      </section>
      {refine.kind === "suggested" && (
        <section className="suggestion-panel">
          <p className="eyebrow">AIからの提案</p>
          <p>{refine.response.suggestion}</p>
          {stale && (
            <p className="inline-error">
              提案後に下書きが変更されたため、この提案は採用できません。
            </p>
          )}
          <div className="button-row">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setRefine({ kind: "idle" })}
            >
              元の目標を維持
            </button>
            <button
              className="button button--primary"
              type="button"
              disabled={stale || pending}
              onClick={() => void adopt()}
            >
              提案を採用
            </button>
          </div>
        </section>
      )}
      {refine.kind === "failed" && (
        <p className="inline-error">AIから提案を取得できませんでした。</p>
      )}
      <section className="terminal-actions">
        <h2>この目標を終える</h2>
        {changed && (
          <p>次のサイクルを開始しない場合、現在の変更案は保存されません。</p>
        )}
        <div className="button-row">
          <button
            type="button"
            disabled={refine.kind === "running" || pending}
            onClick={() => void terminate("achieved")}
          >
            目標を達成として終了
          </button>
          <button
            type="button"
            disabled={refine.kind === "running" || pending}
            onClick={() => void terminate("ended")}
          >
            目標を終了
          </button>
          <button
            className="danger-link"
            type="button"
            disabled={pending}
            onClick={() => void remove()}
          >
            目標を削除
          </button>
        </div>
      </section>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
