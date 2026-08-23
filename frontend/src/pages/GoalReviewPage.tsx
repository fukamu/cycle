import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import {
  cacheCycle,
  cacheReviewDraft,
  userQueryKeys,
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
  DraftCacheWarning,
  DraftRecoveryNotice,
  PageError,
  PageLoading,
  SaveBadge,
} from "../shared/components/AsyncState";
import { ConfirmationDialog } from "../shared/components/ConfirmationDialog";
import { frameCopy } from "../shared/copy/ja";
import {
  commandFingerprint,
  useCommandOperation,
} from "../shared/hooks/useCommandOperation";
import { useDraftAutoSave } from "../shared/hooks/useDraftAutoSave";
import {
  codePointCount,
  GOAL_TEXT_MAX_CODE_POINTS,
  hasNonWhitespace,
  normalizeBoundedTextInput,
  textDiffersAfterLineEndingNormalization,
} from "../shared/text/semantics";

export function GoalReviewPage() {
  const session = useSession();
  const userId = session.user.id;
  const { goalId = "" } = useParams();
  const query = useQuery({
    queryKey: userQueryKeys.review(userId, goalId),
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
  const userId = session.user.id;
  const navigate = useNavigate();
  const cache = useQueryClient();
  const refinement = useGoalRefinement();
  const refineOperation = useCommandOperation();
  const continueOperation = useCommandOperation();
  const terminateOperation = useCommandOperation();
  const deleteOperation = useCommandOperation();
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<ReviewConfirmation>();
  const [error, setError] = useState<string>();
  const save = useCallback(
    async (body: string, revision: number) => {
      const saved = (
        await saveReview(
          goal.id,
          reviewDraft.id,
          body,
          revision,
          session.csrfToken,
        )
      ).reviewDraft;
      const current = cache.getQueryData<GoalReview>(
        userQueryKeys.review(userId, goal.id),
      )?.reviewDraft;
      if (current?.id === saved.id && current.revision <= saved.revision)
        cacheReviewDraft(cache, userId, goal.id, saved);
      return saved;
    },
    [cache, goal.id, reviewDraft.id, session.csrfToken, userId],
  );
  const loadLatest = useCallback(async () => {
    return (await getReview(goal.id)).reviewDraft;
  }, [goal.id]);
  const acceptLatest = useCallback(
    (latest: GoalReview["reviewDraft"]): GoalReview["reviewDraft"] | null => {
      if (latest.id !== reviewDraft.id) return null;
      const current = cache.getQueryData<GoalReview>(
        userQueryKeys.review(userId, goal.id),
      )?.reviewDraft;
      if (!current || current.id !== reviewDraft.id) return null;
      if (current.revision > latest.revision) return current;
      cacheReviewDraft(cache, userId, goal.id, latest);
      return latest;
    },
    [cache, goal.id, reviewDraft.id, userId],
  );
  const editor = useDraftAutoSave({
    userId,
    goalId: goal.id,
    subjectKey: `goal-review:${goal.id}:${reviewDraft.id}`,
    initialBody: reviewDraft.body,
    initialRevision: reviewDraft.revision,
    save,
    revisionConflictCode: "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
    loadLatest,
    acceptLatest,
  });
  const count = codePointCount(editor.body);
  const changed = textDiffersAfterLineEndingNormalization(
    editor.body,
    goal.currentVersion.body,
  );

  async function requestRefine() {
    setError(undefined);
    const expectedDraftRevision = editor.revision;
    const expectedGoalRevision = goal.revision;
    await refinement.request(editor.body, () =>
      refineOperation.invoke(
        commandFingerprint("goal_review_refine", {
          goalId: goal.id,
          expectedDraftRevision,
          expectedGoalRevision,
        }),
        (operationId) =>
          refineReview(goal.id, expectedDraftRevision, expectedGoalRevision, {
            operationId,
            csrfToken: session.csrfToken,
          }),
      ),
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
      cacheReviewDraft(cache, userId, goal.id, result.reviewDraft);
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
      const expectedGoalRevision = goal.revision;
      const expectedDraftRevision = editor.revision;
      const result = await continueOperation.invoke(
        commandFingerprint("goal_review_continue", {
          goalId: goal.id,
          expectedDraftRevision,
          expectedGoalRevision,
        }),
        (operationId) =>
          continueReview(goal.id, expectedGoalRevision, expectedDraftRevision, {
            operationId,
            csrfToken: session.csrfToken,
          }),
      );
      await editor.discard();
      await cache.invalidateQueries({
        queryKey: userQueryKeys.root(userId),
        refetchType: "none",
      });
      cacheCycle(cache, userId, result.goal, result.cycle);
      navigate(`/goals/${goal.id}`, {
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
      await terminateOperation.invoke(
        commandFingerprint("goal_terminate", {
          goalId: goal.id,
          outcome,
          expectedGoalRevision: goal.revision,
          expectedState: "goal_review",
        }),
        (operationId) =>
          terminateGoal(goal.id, outcome, goal.revision, "goal_review", {
            operationId,
            csrfToken: session.csrfToken,
          }),
      );
      await editor.discard();
      await cache.invalidateQueries({
        queryKey: userQueryKeys.root(userId),
        refetchType: "none",
      });
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
      await deleteOperation.invoke(
        commandFingerprint("goal_delete", {
          goalId: goal.id,
          expectedGoalRevision: goal.revision,
        }),
        (operationId) =>
          deleteGoal(goal.id, goal.revision, {
            operationId,
            csrfToken: session.csrfToken,
          }),
      );
      await editor.discard();
      await cache.invalidateQueries({
        queryKey: userQueryKeys.root(userId),
        refetchType: "none",
      });
      navigate("/", { replace: true });
    } catch {
      editor.resume();
      setError("目標を削除できませんでした。");
      setPending(false);
    }
  }
  const valid =
    hasNonWhitespace(editor.body) && count <= GOAL_TEXT_MAX_CODE_POINTS;
  const conflictPending = editor.revisionConflictActive;
  const conflictRetryBlocked =
    editor.resolvingConflict || Boolean(editor.recoveryConflict);
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
        {editor.recoveryConflict && (
          <DraftRecoveryNotice
            onRestore={editor.restoreRecovery}
            onDiscard={editor.discardRecovery}
          />
        )}
        {editor.resolvingConflict && (
          <p className="draft-notice" role="status" aria-live="polite">
            別の更新を確認しています…
          </p>
        )}
        {editor.browserCacheFailed && <DraftCacheWarning />}
        <label htmlFor="review-goal">次のサイクルで目指す目標</label>
        <textarea
          id="review-goal"
          value={editor.body}
          readOnly={conflictPending}
          onChange={(event) => {
            const body = normalizeBoundedTextInput(
              event.target.value,
              GOAL_TEXT_MAX_CODE_POINTS,
            );
            if (body !== null) editor.setBody(body);
          }}
          onBlur={editor.flush}
        />
        <div className="editor-meta">
          <SaveBadge
            state={editor.state}
            retry={conflictRetryBlocked ? undefined : editor.retry}
          />
          <span>
            {count} / {GOAL_TEXT_MAX_CODE_POINTS}
          </span>
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
