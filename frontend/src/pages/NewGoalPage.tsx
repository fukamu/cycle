import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import { isGoalSuggestionStale } from "../features/goal-refine/suggestionState";
import type {
  GoalDraft,
  GoalRefineResponse,
  Home,
} from "../shared/api/schemas";
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
    onSuccess: () => cache.invalidateQueries({ queryKey: ["home"] }),
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
            下書きを作成
          </button>
        </div>
      </main>
    );
  return <GoalDraftEditor draft={query.data.creationDraft} home={query.data} />;
}

type Refine =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "suggested";
      response: GoalRefineResponse;
      sourceBody: string;
    }
  | { kind: "failed" };

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
  const [refine, setRefine] = useState<Refine>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string>();
  const save = useCallback(
    async (body: string, revision: number) =>
      (await saveGoalDraft(draft.id, body, revision, session.csrfToken)).draft,
    [draft.id, session.csrfToken],
  );
  const editor = useDraftAutoSave({
    userId: session.user.id,
    subjectKey: `goal-draft:${draft.id}`,
    initialBody: draft.body,
    initialRevision: draft.revision,
    save,
  });
  const count = Array.from(editor.body).length;
  const valid = editor.body.trim().length > 0 && count <= 500;

  async function requestRefine() {
    setError(undefined);
    setRefine({ kind: "running" });
    const sourceBody = editor.body;
    try {
      const response = await refineGoalDraft(
        draft.id,
        editor.revision,
        session.csrfToken,
      );
      setRefine({
        kind: "suggested",
        response,
        sourceBody,
      });
    } catch {
      setRefine({ kind: "failed" });
    }
  }
  async function adopt() {
    if (refine.kind !== "suggested") return;
    setPending(true);
    setError(undefined);
    try {
      const result = await adoptGoalDraft(
        draft.id,
        refine.response.generationId,
        editor.revision,
        session.csrfToken,
      );
      editor.synchronize(result.draft.body, result.draft.revision);
      setRefine({ kind: "idle" });
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
  const suggestionStale =
    refine.kind === "suggested" &&
    isGoalSuggestionStale(editor.body, refine.sourceBody, editor.state);
  const canStart =
    valid &&
    editor.state === "saved" &&
    refine.kind !== "running" &&
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
        <label htmlFor="goal-body">あなたの目標</label>
        <textarea
          id="goal-body"
          value={editor.body}
          maxLength={500}
          placeholder={goalCopy.placeholder}
          onChange={(event) => editor.setBody(event.target.value)}
        />
        <div className="editor-meta">
          <SaveBadge state={editor.state} retry={editor.retry} />
          <span className={count > 500 ? "counter counter--error" : "counter"}>
            {count} / 500
          </span>
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
            disabled={!canStart}
            onClick={() => void start()}
          >
            この目標で始める
          </button>
        </div>
        {!home.canStartProgressingGoal && (
          <p className="limit-notice">{goalCopy.limit}</p>
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
      {refine.kind === "suggested" && (
        <section className="suggestion-panel" aria-live="polite">
          <p className="eyebrow">AIからの提案</p>
          <p>{refine.response.suggestion}</p>
          {suggestionStale && (
            <p className="inline-error">
              提案後に下書きが変更されたため、この提案は採用できません。
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setRefine({ kind: "idle" })}
            >
              元の目標を維持
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={suggestionStale || pending}
              onClick={() => void adopt()}
            >
              提案を採用
            </button>
          </div>
        </section>
      )}
      {refine.kind === "failed" && (
        <p className="inline-error" role="alert">
          AIから提案を取得できませんでした。下書きは保存されています。
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
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
