import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import type { Cycle, Frame, Goal } from "../shared/api/schemas";
import {
  completeCycle,
  deleteGoal,
  generateAction,
  getCycle,
  getGoal,
  refineAction,
  saveCycleFrame,
  terminateGoal,
} from "../shared/api/workspace";
import {
  PageError,
  PageLoading,
  SaveBadge,
} from "../shared/components/AsyncState";
import { frameCopy } from "../shared/copy/ja";
import {
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../shared/drafts/browserDraftCache";
import {
  formatActivePeriod,
  formatCompletedPeriod,
} from "../shared/date/format";

const frames: readonly Frame[] = ["plan", "do", "check", "action"];
type Values = Record<Frame, string>;
type SaveState = "dirty" | "saving" | "saved" | "failed";

export function GoalWorkspacePage() {
  const { goalId, cycleId } = useParams();
  const goalQuery = useQuery({
    queryKey: ["goal", goalId],
    queryFn: () => getGoal(goalId ?? ""),
    enabled: Boolean(goalId),
  });
  const cycleQuery = useQuery({
    queryKey: ["goal", goalId, "cycle", cycleId],
    queryFn: () => getCycle(goalId ?? "", cycleId ?? ""),
    enabled: Boolean(goalId && cycleId),
  });
  if (goalQuery.isPending || (cycleId && cycleQuery.isPending))
    return <PageLoading />;
  if (goalQuery.isError)
    return <PageError retry={() => void goalQuery.refetch()} />;
  const goal = goalQuery.data.goal;
  if (!cycleId) {
    if (goal.status === "goal_review")
      return <Navigate to={`/goals/${goal.id}/review`} replace />;
    if (goal.status === "active_cycle" && goal.currentWork?.cycleId)
      return (
        <Navigate
          to={`/goals/${goal.id}/cycles/${goal.currentWork.cycleId}`}
          replace
        />
      );
    return <Navigate to={`/history/goals/${goal.id}`} replace />;
  }
  if (cycleQuery.isError)
    return <PageError retry={() => void cycleQuery.refetch()} />;
  if (!cycleQuery.data) return <PageLoading />;
  return (
    <CycleWorkspace
      key={cycleQuery.data.cycle.id}
      goal={goal}
      initial={cycleQuery.data.cycle}
    />
  );
}

function CycleWorkspace({
  goal,
  initial,
}: {
  readonly goal: Goal;
  readonly initial: Cycle;
}) {
  const session = useSession();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [cycle, setCycle] = useState(initial);
  const [values, setValues] = useState<Values>({
    plan: initial.plan,
    do: initial.do,
    check: initial.check,
    action: initial.action,
  });
  const [selected, setSelected] = useState<Frame>("plan");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveQueueNonce, setSaveQueueNonce] = useState(0);
  const [aiState, setAIState] = useState<"idle" | "generating" | "refining">(
    "idle",
  );
  const [pendingAction, setPendingAction] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(new Map<Frame, string>());
  const saveInFlight = useRef(false);
  const valuesRef = useRef(values);
  const revisions = useRef({ ...initial.frameRevisions });
  const contentRevision = useRef(initial.contentRevision);
  const editable = cycle.status === "active";

  useEffect(() => {
    if (!editable) return;
    void Promise.all(
      frames.map(async (frame) => {
        const draft = await getBrowserDraft(
          session.user.id,
          `cycle:${cycle.id}:${frame}`,
        );
        if (draft && draft.baseRevision === revisions.current[frame]) {
          pending.current.set(frame, draft.body);
          valuesRef.current = { ...valuesRef.current, [frame]: draft.body };
          setValues(valuesRef.current);
          setSaveState("dirty");
        }
      }),
    );
  }, [cycle.id, editable, session.user.id]);

  const pump = useCallback(async () => {
    if (saveInFlight.current) return;
    if (!editable || pending.current.size === 0) {
      setSaveState("saved");
      return;
    }
    const entry = pending.current.entries().next().value as
      | [Frame, string]
      | undefined;
    if (!entry) return;
    const [frame, body] = entry;
    pending.current.delete(frame);
    saveInFlight.current = true;
    setSaveState("saving");
    let failed = false;
    try {
      const result = await saveCycleFrame(
        goal.id,
        cycle.id,
        frame,
        body,
        revisions.current[frame],
        session.csrfToken,
      );
      revisions.current[frame] = result.frameRevision;
      contentRevision.current = result.contentRevision;
      setCycle((current) => ({
        ...current,
        [frame]: result.content,
        contentRevision: result.contentRevision,
        frameRevisions: {
          ...current.frameRevisions,
          [frame]: result.frameRevision,
        },
      }));
      if (!pending.current.has(frame))
        await deleteBrowserDraft(session.user.id, `cycle:${cycle.id}:${frame}`);
      else
        await putBrowserDraft({
          userId: session.user.id,
          subjectKey: `cycle:${cycle.id}:${frame}`,
          body: pending.current.get(frame) ?? "",
          baseRevision: result.frameRevision,
          updatedAt: new Date().toISOString(),
        });
    } catch {
      if (!pending.current.has(frame)) pending.current.set(frame, body);
      failed = true;
    } finally {
      saveInFlight.current = false;
      if (failed) {
        setSaveState("failed");
      } else if (pending.current.size) {
        setSaveState("dirty");
        setSaveQueueNonce((value) => value + 1);
      } else {
        setSaveState("saved");
      }
    }
  }, [cycle.id, editable, goal.id, session.csrfToken, session.user.id]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const timer = window.setTimeout(() => void pump(), 800);
    return () => window.clearTimeout(timer);
  }, [pump, saveQueueNonce, saveState]);

  function change(frame: Frame, value: string) {
    if (Array.from(value).length > 2000) return;
    valuesRef.current = { ...valuesRef.current, [frame]: value };
    setValues(valuesRef.current);
    pending.current.set(frame, value);
    setSaveState("dirty");
    void putBrowserDraft({
      userId: session.user.id,
      subjectKey: `cycle:${cycle.id}:${frame}`,
      body: value,
      baseRevision: revisions.current[frame],
      updatedAt: new Date().toISOString(),
    });
  }
  function applyAI(
    action: string,
    actionRevision: number,
    nextContentRevision: number,
  ) {
    valuesRef.current = { ...valuesRef.current, action };
    setValues(valuesRef.current);
    revisions.current.action = actionRevision;
    contentRevision.current = nextContentRevision;
    setCycle((current) => ({
      ...current,
      action,
      contentRevision: nextContentRevision,
      frameRevisions: { ...current.frameRevisions, action: actionRevision },
    }));
    pending.current.delete("action");
    void deleteBrowserDraft(session.user.id, `cycle:${cycle.id}:action`);
    setSaveState(pending.current.size ? "dirty" : "saved");
  }
  const allPDC = [values.plan, values.do, values.check].every((value) =>
    value.trim(),
  );
  const allFrames = allPDC && values.action.trim();
  const aiReady = saveState === "saved" && aiState === "idle";
  async function runAI(kind: "generating" | "refining") {
    const replacing = kind === "generating" && Boolean(values.action.trim());
    if (replacing && !window.confirm("現在のAをAI生成結果で置き換えますか？"))
      return;
    const sourcePDC = JSON.stringify([
      valuesRef.current.plan,
      valuesRef.current.do,
      valuesRef.current.check,
    ]);
    setAIState(kind);
    setError(undefined);
    try {
      const result =
        kind === "generating"
          ? await generateAction(
              goal.id,
              cycle.id,
              contentRevision.current,
              replacing,
              session.csrfToken,
            )
          : await refineAction(
              goal.id,
              cycle.id,
              contentRevision.current,
              session.csrfToken,
            );
      if (
        result.action === undefined ||
        result.actionRevision === undefined ||
        result.contentRevision === undefined
      )
        throw new Error("invalid AI response");
      applyAI(result.action, result.actionRevision, result.contentRevision);
      if (
        result.contextChanged ||
        sourcePDC !==
          JSON.stringify([
            valuesRef.current.plan,
            valuesRef.current.do,
            valuesRef.current.check,
          ])
      )
        setError(
          "AI処理中にP/D/Cが変更されています。必要に応じて再生成してください。",
        );
    } catch {
      setError("AI処理を完了できませんでした。現在のAは保持されています。");
    } finally {
      setAIState("idle");
    }
  }
  async function finish() {
    if (!window.confirm("このサイクルを完了し、目標の見直しへ進みますか？"))
      return;
    setPendingAction(true);
    setError(undefined);
    try {
      await completeCycle(
        goal.id,
        cycle.id,
        goal.revision,
        contentRevision.current,
        session.csrfToken,
      );
      await cache.invalidateQueries({ refetchType: "none" });
      navigate(`/goals/${goal.id}/review`, { replace: true });
    } catch {
      setError("サイクルを完了できませんでした。入力内容を確認してください。");
      setPendingAction(false);
    }
  }
  async function terminate(outcome: "achieved" | "ended") {
    const wording = outcome === "achieved" ? "達成として終了" : "終了";
    if (
      !window.confirm(
        `目標を${wording}しますか？現在のCycleはCanceledの読み取り専用履歴として残ります。`,
      )
    )
      return;
    setPendingAction(true);
    try {
      await terminateGoal(
        goal.id,
        outcome,
        goal.revision,
        "active_cycle",
        session.csrfToken,
        { id: cycle.id, revision: contentRevision.current },
      );
      await cache.invalidateQueries({ refetchType: "none" });
      navigate("/", { replace: true });
    } catch {
      setError(`目標を${wording}できませんでした。`);
      setPendingAction(false);
    }
  }
  async function remove() {
    if (
      !window.confirm(
        "この目標とすべてのCycle履歴を完全に削除します。この操作は取り消せません。",
      )
    )
      return;
    setPendingAction(true);
    try {
      await deleteGoal(goal.id, goal.revision, session.csrfToken);
      await cache.invalidateQueries({ refetchType: "none" });
      navigate("/", { replace: true });
    } catch {
      setError("目標を削除できませんでした。");
      setPendingAction(false);
    }
  }
  const copy = frameCopy[selected];
  const end = cycle.completedAt ?? cycle.canceledAt;
  return (
    <main className="page editor-page">
      <header className="goal-context">
        <span className="eyebrow">目標</span>
        <h1>{cycle.goalVersion.body}</h1>
        <p>
          Goal v{cycle.goalVersion.versionNumber} · Cycle {cycle.sequenceNumber}
        </p>
        <p>
          {end
            ? formatCompletedPeriod(cycle.startedAt, end)
            : formatActivePeriod(cycle.startedAt)}
        </p>
      </header>
      <div className="frame-tabs" role="tablist" aria-label="PDCAフレーム">
        {frames.map((frame) => (
          <button
            key={frame}
            id={`tab-${frame}`}
            role="tab"
            aria-selected={selected === frame}
            tabIndex={selected === frame ? 0 : -1}
            onClick={() => setSelected(frame)}
          >
            <span>{frameCopy[frame].label}</span>
            <small>{frameCopy[frame].name}</small>
          </button>
        ))}
      </div>
      <section
        className="editor-card"
        role="tabpanel"
        aria-labelledby={`tab-${selected}`}
      >
        <div className="frame-title">
          <span>{copy.label}</span>
          <h2>{copy.name}</h2>
        </div>
        <p className="frame-guide">{copy.guide}</p>
        <textarea
          aria-label={`${copy.label} — ${copy.name}`}
          value={values[selected]}
          placeholder={copy.placeholder}
          readOnly={!editable || (selected === "action" && aiState !== "idle")}
          onChange={(event) => change(selected, event.target.value)}
        />
        <div className="editor-meta">
          {editable ? (
            <SaveBadge
              state={saveState}
              retry={() => {
                setSaveState("dirty");
                void pump();
              }}
            />
          ) : (
            <span className="read-only-badge">読み取り専用</span>
          )}
          <span>{Array.from(values[selected]).length} / 2,000</span>
        </div>
        {editable && selected === "action" && (
          <div className="action-controls">
            <button
              className="button button--secondary"
              type="button"
              disabled={!allPDC || !aiReady}
              onClick={() => void runAI("generating")}
            >
              {aiState === "generating"
                ? "生成しています…"
                : "アクションを生成"}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={!allFrames || !aiReady}
              onClick={() => void runAI("refining")}
            >
              {aiState === "refining" ? "推敲しています…" : "AIで推敲"}
            </button>
            <button
              className="button button--primary"
              type="button"
              disabled={!allFrames || !aiReady || pendingAction}
              onClick={() => void finish()}
            >
              サイクルを完了
            </button>
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </section>
      {editable && (
        <details className="goal-actions">
          <summary>目標の操作</summary>
          <div className="button-row">
            <button
              type="button"
              disabled={
                saveState !== "saved" || aiState !== "idle" || pendingAction
              }
              onClick={() => void terminate("achieved")}
            >
              目標を達成として終了
            </button>
            <button
              type="button"
              disabled={
                saveState !== "saved" || aiState !== "idle" || pendingAction
              }
              onClick={() => void terminate("ended")}
            >
              目標を終了
            </button>
            <button
              className="danger-link"
              type="button"
              disabled={pendingAction}
              onClick={() => void remove()}
            >
              目標を削除
            </button>
          </div>
        </details>
      )}
    </main>
  );
}
