import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import type { AIResponse, GoalDraft, Home } from "../shared/api/schemas";
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
  | { kind: "suggested"; response: AIResponse }
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
  const bodyAtRequest = useRef("");
  const count = Array.from(editor.body).length;
  const valid = editor.body.trim().length > 0 && count <= 500;

  async function requestRefine() {
    setError(undefined);
    setRefine({ kind: "running" });
    bodyAtRequest.current = editor.body;
    try {
      const response = await refineGoalDraft(
        draft.id,
        editor.revision,
        session.csrfToken,
      );
      setRefine({
        kind: "suggested",
        response: {
          ...response,
          contextChanged:
            response.contextChanged || bodyAtRequest.current !== editor.body,
        },
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
    try {
      const result = await startGoal(
        draft.id,
        editor.revision,
        session.csrfToken,
      );
      await cache.invalidateQueries();
      navigate(`/goals/${result.goal.id}/cycles/${result.cycle.id}`, {
        replace: true,
      });
    } catch {
      setError(
        "目標を開始できませんでした。保存状態と進行中の目標を確認してください。",
      );
      setPending(false);
    }
  }
  async function discard() {
    if (!window.confirm("この目標の下書きを破棄しますか？")) return;
    setPending(true);
    try {
      await discardGoalDraft(draft.id, session.csrfToken);
      await cache.invalidateQueries();
      navigate("/", { replace: true });
    } catch {
      setError("下書きを破棄できませんでした。");
      setPending(false);
    }
  }
  const suggestionStale =
    refine.kind === "suggested" &&
    (refine.response.contextChanged ||
      refine.response.sourceDraftRevision !== editor.revision ||
      editor.state !== "saved");
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
          onClick={() => void discard()}
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
    </main>
  );
}
