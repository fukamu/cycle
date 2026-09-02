import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { useAuthenticatedRequestLease, useSession } from "../auth";
import {
  cacheCycle,
  cacheGoal,
  cacheReviewDraft,
  removeGoalFromCache,
  userQueryKeys,
} from "../goal-collection";
import { GoalRefinementPanel, useGoalRefinement } from "../goal-refine";
import { APIError } from "../../shared/api/client";
import type { GoalReview } from "../../shared/api/schemas";
import {
  adoptReview,
  continueReview,
  deleteGoal,
  getGoal,
  getReview,
  refineReview,
  saveReview,
  terminateGoal,
} from "../../shared/api/workspace";
import {
  DraftCacheWarning,
  DraftRecoveryNotice,
  SaveBadge,
} from "../../shared/components/AsyncState";
import { ConfirmationDialog } from "../../shared/components/ConfirmationDialog";
import { frameCopy } from "../../shared/copy/ja";
import {
  type PostCommitRouteOwnershipToken,
  useCapturePostCommitRouteOwnership,
  usePostCommitCleanup,
} from "../../shared/cleanup/postCommitCleanupContext";
import {
  clearGoalDrafts,
  deleteBrowserDraft,
} from "../../shared/drafts/browserDraftCache";
import {
  commandFingerprint,
  useCommandOperation,
} from "../../shared/hooks/useCommandOperation";
import {
  type DraftLatestResolution,
  useDraftAutoSave,
} from "../../shared/hooks/useDraftAutoSave";
import {
  codePointCount,
  GOAL_TEXT_MAX_CODE_POINTS,
  hasNonWhitespace,
  normalizeBoundedTextInput,
  textDiffersAfterLineEndingNormalization,
} from "../../shared/text/semantics";

type ReviewConfirmation =
  | { readonly kind: "terminate"; readonly outcome: "achieved" | "ended" }
  | { readonly kind: "delete" };

type ReviewTerminalCommand = "continue" | "terminate" | "delete";
type ReviewCommandRecovery =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed" }
  | { readonly kind: "deleted" };

function isGoalNotFound(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.status === 404 &&
    error.code === "GOAL_NOT_FOUND"
  );
}

function isReviewCommandWorkspaceConflict(
  command: ReviewTerminalCommand,
  error: unknown,
): error is APIError {
  if (isGoalNotFound(error)) return true;
  if (!(error instanceof APIError) || error.status !== 409) return false;
  if (command === "continue")
    return (
      error.code === "GOAL_REVIEW_NOT_ACTIVE" ||
      error.code === "GOAL_VERSION_CONFLICT"
    );
  if (command === "terminate")
    return (
      error.code === "GOAL_STATE_CONFLICT" ||
      error.code === "GOAL_ALREADY_TERMINAL"
    );
  return error.code === "GOAL_DELETE_CONFLICT";
}

export function GoalReviewFeature({ review }: { readonly review: GoalReview }) {
  return <ReviewEditor key={review.reviewDraft.id} review={review} />;
}

function ReviewEditor({ review }: { readonly review: GoalReview }) {
  const { goal, reviewDraft, triggerCycle } = review;
  const session = useSession();
  const userId = session.user.id;
  const sessionLease = useAuthenticatedRequestLease();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const runPostCommitCleanup = usePostCommitCleanup();
  const captureRouteOwnership = useCapturePostCommitRouteOwnership();
  const mountedGenerationRef = useRef(true);
  useLayoutEffect(() => {
    mountedGenerationRef.current = true;
    return () => {
      mountedGenerationRef.current = false;
    };
  }, []);
  const refinement = useGoalRefinement();
  const refineOperation = useCommandOperation();
  const continueOperation = useCommandOperation();
  const terminateOperation = useCommandOperation();
  const deleteOperation = useCommandOperation();
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<ReviewConfirmation>();
  const [error, setError] = useState<string>();
  const [commandRecovery, setCommandRecovery] =
    useState<ReviewCommandRecovery>();
  const commandRecoveryEpochRef = useRef(0);
  const save = useCallback(
    async (body: string, revision: number, signal: AbortSignal) => {
      const saved = (
        await saveReview(
          sessionLease,
          goal.id,
          reviewDraft.id,
          body,
          revision,
          session.csrfToken,
          signal,
        )
      ).reviewDraft;
      const current = cache.getQueryData<GoalReview>(
        userQueryKeys.review(userId, goal.id),
      )?.reviewDraft;
      if (current?.id === saved.id && current.revision <= saved.revision)
        cacheReviewDraft(cache, userId, goal.id, saved);
      return saved;
    },
    [cache, goal.id, reviewDraft.id, session.csrfToken, sessionLease, userId],
  );
  const loadLatest = useCallback(
    async (signal: AbortSignal) => {
      return (await getReview(sessionLease, goal.id, signal)).reviewDraft;
    },
    [goal.id, sessionLease],
  );
  const acceptLatest = useCallback(
    (
      latest: GoalReview["reviewDraft"],
    ): DraftLatestResolution<GoalReview["reviewDraft"]> => {
      if (latest.id !== reviewDraft.id)
        return { kind: "scope-moved", href: "/goals/" + goal.id };
      const current = cache.getQueryData<GoalReview>(
        userQueryKeys.review(userId, goal.id),
      )?.reviewDraft;
      if (!current || current.id !== reviewDraft.id)
        return { kind: "scope-moved", href: "/goals/" + goal.id };
      if (current.revision > latest.revision)
        return { kind: "accepted", snapshot: current };
      cacheReviewDraft(cache, userId, goal.id, latest);
      return { kind: "accepted", snapshot: latest };
    },
    [cache, goal.id, reviewDraft.id, userId],
  );
  const scopeMovedOnError = useCallback(
    (error: unknown) => {
      return error instanceof APIError &&
        error.status === 409 &&
        error.code === "GOAL_REVIEW_NOT_ACTIVE"
        ? "/goals/" + goal.id
        : null;
    },
    [goal.id],
  );
  const subjectKey = `goal-review:${goal.id}:${reviewDraft.id}`;
  const editor = useDraftAutoSave({
    userId,
    goalId: goal.id,
    subjectKey,
    initialBody: reviewDraft.body,
    initialRevision: reviewDraft.revision,
    save,
    revisionConflictCode: "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
    loadLatest,
    acceptLatest,
    scopeMovedOnError,
  });
  const count = codePointCount(editor.body);
  const changed = textDiffersAfterLineEndingNormalization(
    editor.body,
    goal.currentVersion.body,
  );

  const markDeletedGoal = useCallback(
    (routeOwnership: PostCommitRouteOwnershipToken) => {
      commandRecoveryEpochRef.current += 1;
      if (mountedGenerationRef.current) {
        setCommandRecovery({ kind: "deleted" });
        setPending(false);
        setError(undefined);
      }
      void editor.markScopeMoved("/", { preserveUnsaved: false });
      void runPostCommitCleanup({
        expectedUserId: userId,
        routeOwnership,
        // Quiescence drains the Review scope's browser-operation queue before
        // this Goal-wide delete. Retry never re-enters the failed API command.
        cleanup: async () => {
          await clearGoalDrafts(userId, goal.id);
          removeGoalFromCache(cache, userId, goal.id);
        },
        onSuccess: async (publicationIsCurrent) => {
          if (!publicationIsCurrent()) return;
          navigate("/", { replace: true, flushSync: true });
        },
        pendingMessage: "削除済みGoalのブラウザ下書きを削除しています…",
        failureMessage: "削除済みGoalのブラウザ下書きを削除できませんでした。",
        retryLabel: "ブラウザデータの削除を再試行",
      });
    },
    [cache, editor, goal.id, navigate, runPostCommitCleanup, userId],
  );

  const refreshCanonicalGoal = useCallback(
    async (
      routeOwnership: PostCommitRouteOwnershipToken = captureRouteOwnership(),
    ) => {
      const epoch = ++commandRecoveryEpochRef.current;
      setCommandRecovery({ kind: "loading" });
      setError(undefined);
      try {
        const response = await getGoal(
          sessionLease,
          goal.id,
          sessionLease.signal,
        );
        if (
          !mountedGenerationRef.current ||
          commandRecoveryEpochRef.current !== epoch
        )
          return null;
        cacheGoal(cache, userId, response.goal);
        await cache.invalidateQueries({
          queryKey: userQueryKeys.root(userId),
          refetchType: "none",
        });
        if (
          !mountedGenerationRef.current ||
          commandRecoveryEpochRef.current !== epoch
        )
          return null;
        setCommandRecovery({ kind: "ready" });
        setPending(false);
        return response.goal;
      } catch (cause) {
        if (isGoalNotFound(cause)) {
          markDeletedGoal(routeOwnership);
          return null;
        }
        if (
          !mountedGenerationRef.current ||
          commandRecoveryEpochRef.current !== epoch
        )
          return null;
        setCommandRecovery({ kind: "failed" });
        setPending(false);
        setError(
          "現在のGoalを取得できませんでした。入力は読み取り専用で保持されています。",
        );
        return null;
      }
    },
    [
      cache,
      captureRouteOwnership,
      goal.id,
      markDeletedGoal,
      sessionLease,
      userId,
    ],
  );

  async function recoverCommandWorkspace(
    command: ReviewTerminalCommand,
    cause: unknown,
    routeOwnership: PostCommitRouteOwnershipToken,
  ): Promise<boolean> {
    if (!isReviewCommandWorkspaceConflict(command, cause)) return false;
    if (command === "continue") continueOperation.abandon();
    else if (command === "terminate") terminateOperation.abandon();
    else deleteOperation.abandon();
    if (mountedGenerationRef.current) setPending(false);
    if (isGoalNotFound(cause)) {
      markDeletedGoal(routeOwnership);
      return true;
    }
    setCommandRecovery({ kind: "loading" });
    void editor.markScopeMoved(`/goals/${goal.id}`);
    await refreshCanonicalGoal(routeOwnership);
    return true;
  }

  async function requestRefine() {
    setError(undefined);
    const expectedDraftRevision = editor.revision;
    const expectedGoalRevision = goal.revision;
    await refinement.request(
      editor.body,
      () =>
        refineOperation.invoke(
          commandFingerprint("goal_review_refine", {
            goalId: goal.id,
            expectedDraftRevision,
            expectedGoalRevision,
          }),
          (operationId) =>
            refineReview(
              sessionLease,
              goal.id,
              expectedDraftRevision,
              expectedGoalRevision,
              {
                operationId,
                csrfToken: session.csrfToken,
              },
            ),
        ),
      editor.isActiveScope,
    );
  }
  async function adopt() {
    if (refinement.state.kind !== "suggested") return;
    const completionIsCurrent = () =>
      mountedGenerationRef.current &&
      editor.isActiveScope() &&
      cache.getQueryData<GoalReview>(userQueryKeys.review(userId, goal.id))
        ?.reviewDraft.id === reviewDraft.id;
    setError(undefined);
    setPending(true);
    try {
      const result = await adoptReview(
        sessionLease,
        goal.id,
        refinement.state.response.generationId,
        editor.revision,
        goal.revision,
        session.csrfToken,
      );
      if (!completionIsCurrent() || result.reviewDraft.id !== reviewDraft.id)
        return;
      editor.synchronize(result.reviewDraft.body, result.reviewDraft.revision);
      cacheReviewDraft(cache, userId, goal.id, result.reviewDraft);
      refinement.dismiss();
    } catch {
      if (!completionIsCurrent()) return;
      setError("提案を採用できませんでした。現在の下書きを確認してください。");
    } finally {
      if (completionIsCurrent()) setPending(false);
    }
  }
  async function openCanonicalGoal(event: ReactMouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const canonical = await refreshCanonicalGoal();
    if (!canonical) return;
    cache.removeQueries({
      queryKey: userQueryKeys.review(userId, goal.id),
      exact: true,
    });
    navigate(`/goals/${goal.id}`, { replace: true });
  }
  async function nextCycle() {
    const routeOwnership = captureRouteOwnership();
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
          continueReview(
            sessionLease,
            goal.id,
            expectedGoalRevision,
            expectedDraftRevision,
            {
              operationId,
              csrfToken: session.csrfToken,
            },
          ),
      );
      if (!mountedGenerationRef.current || !editor.isActiveScope()) return;
      void runPostCommitCleanup({
        expectedUserId: userId,
        routeOwnership: captureRouteOwnership(),
        cleanup: () => deleteBrowserDraft(userId, subjectKey),
        onSuccess: async (identityIsCurrent) => {
          await cache.invalidateQueries({
            queryKey: userQueryKeys.root(userId),
            refetchType: "none",
          });
          if (!identityIsCurrent()) return;
          cacheCycle(cache, userId, result.goal, result.cycle);
          navigate(`/goals/${goal.id}`, { replace: true });
        },
        pendingMessage: "ブラウザに残るReview下書きを削除しています…",
        failureMessage:
          "次のサイクルは開始されましたが、このブラウザのReview下書きを削除できませんでした。",
        retryLabel: "ブラウザデータの削除を再試行",
      });
    } catch (cause) {
      if (isGoalNotFound(cause)) {
        await recoverCommandWorkspace("continue", cause, routeOwnership);
        return;
      }
      if (!mountedGenerationRef.current || !editor.isActiveScope()) return;
      if (await recoverCommandWorkspace("continue", cause, routeOwnership))
        return;
      editor.resume();
      setError(
        "次のサイクルを開始できませんでした。保存状態を確認してください。",
      );
      setPending(false);
    }
  }
  async function terminate(outcome: "achieved" | "ended") {
    if (editor.hydrating || editor.scopeMovedHref) return;
    const routeOwnership = captureRouteOwnership();
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
          terminateGoal(
            sessionLease,
            goal.id,
            outcome,
            goal.revision,
            "goal_review",
            {
              operationId,
              csrfToken: session.csrfToken,
            },
          ),
      );
      if (!mountedGenerationRef.current || !editor.isActiveScope()) return;
      void runPostCommitCleanup({
        expectedUserId: userId,
        routeOwnership: captureRouteOwnership(),
        cleanup: () => deleteBrowserDraft(userId, subjectKey),
        onSuccess: async (identityIsCurrent) => {
          await cache.invalidateQueries({
            queryKey: userQueryKeys.root(userId),
            refetchType: "none",
          });
          if (!identityIsCurrent()) return;
          navigate("/", { replace: true });
        },
        pendingMessage: "ブラウザに残るReview下書きを削除しています…",
        failureMessage: `目標は${label}しましたが、このブラウザのReview下書きを削除できませんでした。`,
        retryLabel: "ブラウザデータの削除を再試行",
      });
    } catch (cause) {
      if (isGoalNotFound(cause)) {
        await recoverCommandWorkspace("terminate", cause, routeOwnership);
        return;
      }
      if (!mountedGenerationRef.current || !editor.isActiveScope()) return;
      if (await recoverCommandWorkspace("terminate", cause, routeOwnership))
        return;
      editor.resume();
      setError(`目標を${label}できませんでした。`);
      setPending(false);
    }
  }
  async function remove() {
    if (editor.hydrating || editor.scopeMovedHref) return;
    const routeOwnership = captureRouteOwnership();
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
          deleteGoal(sessionLease, goal.id, goal.revision, {
            operationId,
            csrfToken: session.csrfToken,
          }),
      );
      markDeletedGoal(routeOwnership);
    } catch (cause) {
      if (isGoalNotFound(cause)) {
        await recoverCommandWorkspace("delete", cause, routeOwnership);
        return;
      }
      if (!mountedGenerationRef.current || !editor.isActiveScope()) return;
      if (await recoverCommandWorkspace("delete", cause, routeOwnership))
        return;
      editor.resume();
      setError("目標を削除できませんでした。");
      setPending(false);
    }
  }
  const valid =
    hasNonWhitespace(editor.body) && count <= GOAL_TEXT_MAX_CODE_POINTS;
  const conflictPending = editor.revisionConflictActive;
  const conflictRetryBlocked =
    editor.resolvingConflict ||
    Boolean(editor.recoveryConflict) ||
    Boolean(editor.scopeMovedHref);
  const terminalActionsBlocked =
    editor.hydrating ||
    Boolean(editor.scopeMovedHref) ||
    refinement.state.kind === "running" ||
    pending;
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
        {commandRecovery?.kind === "deleted" && (
          <div className="draft-notice draft-notice--conflict" role="alert">
            <p>このGoalはすでに削除されています。</p>
            <Link className="button button--primary" to="/">
              ホームへ戻る
            </Link>
          </div>
        )}
        {editor.scopeMovedHref && commandRecovery?.kind !== "deleted" && (
          <div className="draft-notice" role="alert">
            Reviewの作業場所は変わりました。入力内容はこの端末に保持されています。
            {commandRecovery?.kind === "loading" ? (
              <>現在のGoalを確認しています。</>
            ) : commandRecovery?.kind === "failed" ? (
              <button
                className="button button--primary"
                type="button"
                onClick={() => void refreshCanonicalGoal()}
              >
                現在のGoalを再取得
              </button>
            ) : (
              <>
                必要なら本文をコピーしてから、
                <Link
                  to={editor.scopeMovedHref}
                  onClick={(event) => void openCanonicalGoal(event)}
                >
                  現在のGoalを開いてください
                </Link>
                。
              </>
            )}
          </div>
        )}
        {editor.browserCacheFailed && <DraftCacheWarning />}
        <label htmlFor="review-goal">次のサイクルで目指す目標</label>
        <textarea
          id="review-goal"
          value={editor.body}
          readOnly={
            conflictPending || Boolean(editor.scopeMovedHref) || pending
          }
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
          {editor.scopeMovedHref && commandRecovery ? (
            <span className="read-only-badge">読み取り専用</span>
          ) : (
            <SaveBadge
              state={editor.state}
              retry={conflictRetryBlocked ? undefined : editor.retry}
            />
          )}
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
              editor.state.kind !== "saved" ||
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
              editor.state.kind !== "saved" ||
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
            disabled={terminalActionsBlocked}
            onClick={() =>
              setConfirmation({ kind: "terminate", outcome: "achieved" })
            }
          >
            目標を達成として終了
          </button>
          <button
            type="button"
            disabled={terminalActionsBlocked}
            onClick={() =>
              setConfirmation({ kind: "terminate", outcome: "ended" })
            }
          >
            目標を終了
          </button>
          <button
            className="danger-link"
            type="button"
            disabled={terminalActionsBlocked}
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
          <p>
            このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal
            Versionとして保存されません。
          </p>
          <p>
            現在の目標のまま
            {confirmation.outcome === "achieved" ? "達成として終了" : "終了"}
            します。
          </p>
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
