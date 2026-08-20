import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import {
  cacheCycle,
  cacheReviewDraft,
} from "../features/goal-collection/goalCache";
import { GoalRefinementPanel } from "../features/goal-refine/GoalRefinementPanel";
import { useGoalRefinement } from "../features/goal-refine/useGoalRefinement";
import type { GoalReview } from "../shared/api/schemas";
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
import { ConfirmationDialog } from "../shared/components/ConfirmationDialog";
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

type ReviewConfirmation =
  | { readonly kind: "terminate"; readonly outcome: "achieved" | "ended" }
  | { readonly kind: "delete" };

function ReviewEditor({ review }: { readonly review: GoalReview }) {
  const { goal, reviewDraft, triggerCycle } = review;
  const session = useSession();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const refinement = useGoalRefinement();
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<ReviewConfirmation>();
  const [error, setError] = useState<string>();
  const save = useCallback(
    async (body: string, revision: number) => {
      const saved = (
        await saveReview(goal.id, body, revision, session.csrfToken)
      ).reviewDraft;
      cacheReviewDraft(cache, goal.id, saved);
      return saved;
    },
    [cache, goal.id, session.csrfToken],
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
    setError(undefined);
    await refinement.request(editor.body, () =>
      refineReview(goal.id, editor.revision, goal.revision, session.csrfToken),
    );
  }
  async function adopt() {
    if (refinement.state.kind !== "suggested") return;
    setPending(true);
    try {
      const result = await adoptReview(
        goal.id,
        refinement.state.response.generationId,
        editor.revision,
        goal.revision,
        session.csrfToken,
      );
      editor.synchronize(result.reviewDraft.body, result.reviewDraft.revision);
      cacheReviewDraft(cache, goal.id, result.reviewDraft);
      refinement.dismiss();
    } catch {
      setError("提案を採用できませんでした。現在の下書きを確認してください。");
    } finally {
      setPending(false);
    }
  }
  async function nextCycle() {
    setPending(true);
    setError(undefined);
    editor.pause();
    try {
      const result = await continueReview(
        goal.id,
        goal.revision,
        editor.revision,
        session.csrfToken,
      );
      await editor.discard();
      await cache.invalidateQueries({ refetchType: "none" });
      cacheCycle(cache, result.goal, result.cycle);
      navigate(`/goals/${goal.id}/cycles/${result.cycle.id}`, {
        replace: true,
      });
    } catch {
      editor.resume();
      setError(
        "次のサイクルを開始できませんでした。保存状態を確認してください。",
      );
      setPending(false);
    }
  }
  async function terminate(outcome: "achieved" | "ended") {
    const label = outcome === "achieved" ? "達成として終了" : "終了";
    setPending(true);
    setError(undefined);
    editor.pause();
    try {
      await terminateGoal(
        goal.id,
        outcome,
        goal.revision,
        "goal_review",
        session.csrfToken,
      );
      await editor.discard();
      await cache.invalidateQueries({ refetchType: "none" });
      navigate("/", { replace: true });
    } catch {
      editor.resume();
      setError(`目標を${label}できませんでした。`);
      setPending(false);
    }
  }
  async function remove() {
    setPending(true);
    setError(undefined);
    editor.pause();
    try {
      await deleteGoal(goal.id, goal.revision, session.csrfToken);
      await editor.discard();
      await cache.invalidateQueries({ refetchType: "none" });
      navigate("/", { replace: true });
    } catch {
      editor.resume();
      setError("目標を削除できませんでした。");
      setPending(false);
    }
  }
  const valid = editor.body.trim().length > 0 && count <= 80;
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
          maxLength={80}
          onChange={(event) => editor.setBody(event.target.value)}
        />
        <div className="editor-meta">
          <SaveBadge state={editor.state} retry={editor.retry} />
          <span>{count} / 80</span>
        </div>
        <div className="button-row">
          <button
            className="button button--secondary"
            type="button"
            disabled={
              !valid ||
              editor.state !== "saved" ||
              refinement.state.kind === "running" ||
              pending
            }
            onClick={() => void requestRefine()}
          >
            {refinement.state.kind === "running"
              ? "AIが整理しています…"
              : "AIで目標を整える"}
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={
              !valid ||
              editor.state !== "saved" ||
              refinement.state.kind === "running" ||
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
      <GoalRefinementPanel
        id="review"
        state={refinement.state}
        currentBody={editor.body}
        saveState={editor.state}
        pending={pending}
        failureMessage="AIから提案を取得できませんでした。"
        onDismiss={refinement.dismiss}
        onAdopt={() => void adopt()}
      />
      <section className="terminal-actions">
        <h2>この目標を終える</h2>
        {changed && (
          <p>次のサイクルを開始しない場合、現在の変更案は保存されません。</p>
        )}
        <div className="button-row">
          <button
            type="button"
            disabled={refinement.state.kind === "running" || pending}
            onClick={() =>
              setConfirmation({ kind: "terminate", outcome: "achieved" })
            }
          >
            目標を達成として終了
          </button>
          <button
            type="button"
            disabled={refinement.state.kind === "running" || pending}
            onClick={() =>
              setConfirmation({ kind: "terminate", outcome: "ended" })
            }
          >
            目標を終了
          </button>
          <button
            className="danger-link"
            type="button"
            disabled={pending}
            onClick={() => setConfirmation({ kind: "delete" })}
          >
            目標を削除
          </button>
        </div>
      </section>
      {(refinement.requestError || error) && (
        <p className="inline-error" role="alert">
          {error ?? refinement.requestError}
        </p>
      )}
      {confirmation?.kind === "terminate" && (
        <ConfirmationDialog
          title={`目標を${
            confirmation.outcome === "achieved" ? "達成として終了" : "終了"
          }しますか？`}
          confirmLabel={
            confirmation.outcome === "achieved" ? "目標を達成" : "目標を終了"
          }
          confirmTone="danger"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            const { outcome } = confirmation;
            setConfirmation(undefined);
            void terminate(outcome);
          }}
        >
          {changed ? (
            <>
              <p>この変更案は、次のサイクルを開始しないため保存されません。</p>
              <p>
                現在の目標のまま
                {confirmation.outcome === "achieved"
                  ? "達成として終了"
                  : "終了"}
                します。
              </p>
            </>
          ) : (
            <p>次のサイクルを開始せず、現在の目標を終了します。</p>
          )}
        </ConfirmationDialog>
      )}
      {confirmation?.kind === "delete" && (
        <ConfirmationDialog
          title="目標を削除しますか？"
          confirmLabel="目標を削除"
          confirmTone="danger"
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            setConfirmation(undefined);
            void remove();
          }}
        >
          <p>
            この目標とすべてのCycle履歴を完全に削除します。この操作は取り消せません。
          </p>
        </ConfirmationDialog>
      )}
    </main>
  );
}
