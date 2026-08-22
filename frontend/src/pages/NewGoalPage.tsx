import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import {
  cacheCreationDraft,
  cacheCycle,
} from "../features/goal-collection/goalCache";
import { GoalRefinementPanel } from "../features/goal-refine/GoalRefinementPanel";
import { useGoalRefinement } from "../features/goal-refine/useGoalRefinement";
import type { GoalDraft, Home } from "../shared/api/schemas";
import {
  adoptGoalDraft,
  createGoalDraft,
  discardGoalDraft,
  getHome,
  refineGoalDraft,
  saveGoalDraft,
  startGoal,
} from "../shared/api/workspace";
import {
  DraftCacheWarning,
  DraftRecoveryNotice,
  PageError,
  PageLoading,
  SaveBadge,
} from "../shared/components/AsyncState";
import { ConfirmationDialog } from "../shared/components/ConfirmationDialog";
import { goalCopy } from "../shared/copy/ja";
import { useDraftAutoSave } from "../shared/hooks/useDraftAutoSave";

export function NewGoalPage() {
  const session = useSession();
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["home"], queryFn: getHome });
  const create = useMutation({
    mutationFn: () => createGoalDraft("", session.csrfToken),
    onSuccess: ({ draft }) => cacheCreationDraft(cache, draft),
  });
  if (query.isPending) return <PageLoading />;
  if (query.isError) return <PageError retry={() => void query.refetch()} />;
  if (!query.data.creationDraft)
    return (
      <main className="page">
        <header className="page-heading">
          <h1>新しい目標</h1>
        </header>
        <div className="empty-card">
          <p>目標の下書きを準備します。</p>
          <button
            className="button button--primary"
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isError ? "もう一度作成" : "下書きを作成"}
          </button>
          {create.isError && (
            <p className="inline-error" role="alert">
              下書きを作成できませんでした。時間をおいて再試行してください。
            </p>
          )}
        </div>
      </main>
    );
  return <GoalDraftEditor draft={query.data.creationDraft} home={query.data} />;
}

function GoalDraftEditor({
  draft,
  home,
}: {
  readonly draft: GoalDraft;
  readonly home: Home;
}) {
  const session = useSession();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const refinement = useGoalRefinement();
  const [pending, setPending] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string>();
  const save = useCallback(
    async (body: string, revision: number) => {
      const saved = (
        await saveGoalDraft(draft.id, body, revision, session.csrfToken)
      ).draft;
      cacheCreationDraft(cache, saved);
      return saved;
    },
    [cache, draft.id, session.csrfToken],
  );
  const editor = useDraftAutoSave({
    userId: session.user.id,
    goalId: null,
    subjectKey: `goal-draft:${draft.id}`,
    initialBody: draft.body,
    initialRevision: draft.revision,
    save,
  });
  const count = Array.from(editor.body).length;
  const valid = editor.body.trim().length > 0 && count <= 80;

  async function requestRefine() {
    setError(undefined);
    await refinement.request(editor.body, () =>
      refineGoalDraft(draft.id, editor.revision, session.csrfToken),
    );
  }
  async function adopt() {
    if (refinement.state.kind !== "suggested") return;
    setPending(true);
    setError(undefined);
    try {
      const result = await adoptGoalDraft(
        draft.id,
        refinement.state.response.generationId,
        editor.revision,
        session.csrfToken,
      );
      editor.synchronize(result.draft.body, result.draft.revision);
      cacheCreationDraft(cache, result.draft);
      refinement.dismiss();
    } catch {
      setError("提案を採用できませんでした。現在の下書きを確認してください。");
    } finally {
      setPending(false);
    }
  }
  async function start() {
    setPending(true);
    setError(undefined);
    editor.pause();
    try {
      const result = await startGoal(
        draft.id,
        editor.revision,
        session.csrfToken,
      );
      await editor.discard();
      await cache.invalidateQueries({ refetchType: "none" });
      cacheCycle(cache, result.goal, result.cycle);
      navigate(`/goals/${result.goal.id}/cycles/${result.cycle.id}`, {
        replace: true,
      });
    } catch {
      editor.resume();
      setError(
        "目標を開始できませんでした。保存状態と進行中の目標を確認してください。",
      );
      setPending(false);
    }
  }
  async function discard() {
    setPending(true);
    setError(undefined);
    editor.pause();
    try {
      await discardGoalDraft(draft.id, session.csrfToken);
      await editor.discard();
      await cache.invalidateQueries({ refetchType: "none" });
      navigate("/", { replace: true });
    } catch {
      editor.resume();
      setError("下書きを破棄できませんでした。");
      setPending(false);
    }
  }
  const canStart =
    valid &&
    editor.state === "saved" &&
    refinement.state.kind !== "running" &&
    home.canStartProgressingGoal &&
    !pending;
  return (
    <main className="page editor-page">
      <header className="page-heading">
        <p className="eyebrow">NEW GOAL</p>
        <h1>新しい目標</h1>
        <p>{goalCopy.guide}</p>
      </header>
      <section className="editor-card">
        {editor.recoveryConflict && (
          <DraftRecoveryNotice
            onRestore={editor.restoreRecovery}
            onDiscard={editor.discardRecovery}
          />
        )}
        {editor.browserCacheFailed && <DraftCacheWarning />}
        <label htmlFor="goal-body">あなたの目標</label>
        <textarea
          id="goal-body"
          value={editor.body}
          maxLength={80}
          placeholder={goalCopy.placeholder}
          readOnly={Boolean(editor.recoveryConflict)}
          onChange={(event) => editor.setBody(event.target.value)}
          onBlur={editor.flush}
        />
        <div className="editor-meta">
          <SaveBadge
            state={editor.state}
            retry={editor.recoveryConflict ? undefined : editor.retry}
          />
          <span className={count > 80 ? "counter counter--error" : "counter"}>
            {count} / 80
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
            disabled={!canStart}
            onClick={() => void start()}
          >
            この目標で始める
          </button>
        </div>
        {!home.canStartProgressingGoal && (
          <p className="limit-notice">
            {goalCopy.limit(home.progressingGoalLimit)}
          </p>
        )}
        <button
          className="text-button danger-link"
          type="button"
          disabled={pending}
          onClick={() => setConfirmDiscard(true)}
        >
          下書きを破棄
        </button>
      </section>
      <GoalRefinementPanel
        id="goal"
        state={refinement.state}
        currentBody={editor.body}
        saveState={editor.state}
        pending={pending}
        failureMessage="AIから提案を取得できませんでした。下書きは保存されています。"
        onDismiss={refinement.dismiss}
        onAdopt={() => void adopt()}
      />
      {(refinement.requestError || error) && (
        <p className="inline-error" role="alert">
          {error ?? refinement.requestError}
        </p>
      )}
      {confirmDiscard && (
        <ConfirmationDialog
          title="下書きを破棄しますか？"
          confirmLabel="下書きを破棄"
          confirmTone="danger"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            void discard();
          }}
        >
          <p>入力した目標の下書きを破棄します。</p>
        </ConfirmationDialog>
      )}
    </main>
  );
}
