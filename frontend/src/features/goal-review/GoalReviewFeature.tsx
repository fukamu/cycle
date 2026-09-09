import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { useAuthenticatedRequestLease, useSession } from "../auth";
import {
  cacheCycle,
  cacheGoal,
  cacheReviewDraft,
  resolveGoalReviewPublication,
  userQueryKeys,
} from "../goal-collection";
import {
  GoalDeletionFenceBoundary,
  useGoalDeletionEditorFence,
  useRunGoalDeletionFencedRequest,
  useStartGoalDeletionFence,
} from "../goal-deletion";
import { GoalRefinementPanel, useGoalRefinement } from "../goal-refine";
import { APIError } from "../../shared/api/client";
import type { Goal, GoalReview } from "../../shared/api/schemas";
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
  PageError,
  PageLoading,
  SaveBadge,
} from "../../shared/components/AsyncState";
import { ConfirmationDialog } from "../../shared/components/ConfirmationDialog";
import { frameCopy, goalActionCopy } from "../../shared/copy/ja";
import {
  type PostCommitRouteOwnershipToken,
  useCapturePostCommitRouteOwnership,
  usePostCommitCleanup,
} from "../../shared/cleanup/postCommitCleanupContext";
import { deleteBrowserDraft } from "../../shared/drafts/browserDraftCache";
import { forgetSelectedCycleFrame } from "../../shared/preferences/selectedFramePreference";
import {
  commandFingerprint,
  useCommandOperation,
} from "../../shared/hooks/useCommandOperation";
import { useBoundedTextInput } from "../../shared/hooks/useBoundedTextInput";
import {
  type DraftLatestResolution,
  useDraftAutoSave,
} from "../../shared/hooks/useDraftAutoSave";
import {
  codePointCount,
  GOAL_TEXT_MAX_CODE_POINTS,
  hasNonWhitespace,
  textDiffersAfterLineEndingNormalization,
} from "../../shared/text/semantics";
import { goalReviewQueryOptions } from "./goalReviewQueryOptions";
import {
  getGoalReviewActionControls,
  type GoalReviewActionDisabledReason,
} from "./actionControls";

type ReviewConfirmation =
  | { readonly kind: "terminate"; readonly outcome: "achieved" | "ended" }
  | { readonly kind: "delete" };

type ReviewTerminalCommand = "continue" | "terminate" | "delete";
type ReviewCommandRecovery =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed" }
  | { readonly kind: "deleted" };

function goalReviewActionGuidanceText(
  reason: GoalReviewActionDisabledReason,
): string | undefined {
  switch (reason) {
    case "command-pending":
      return goalActionCopy.disabled.commandPending;
    case "hydrating":
      return goalActionCopy.disabled.hydrating;
    case "save-dirty":
      return goalActionCopy.disabled.saveDirty;
    case "save-saving":
      return goalActionCopy.disabled.saveSaving;
    case "save-failed":
      return goalActionCopy.disabled.saveFailed;
    case "ai-running":
      return goalActionCopy.disabled.aiRunning;
    case "invalid-goal":
      return goalActionCopy.disabled.reviewInvalid;
    case "workspace-moved":
    case "recovery-resolving":
    case "recovery-choice":
      return undefined;
  }
}

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

export function GoalReviewFeature({ goalId }: { readonly goalId: string }) {
  const session = useSession();
  const userId = session.user.id;
  return (
    <GoalDeletionFenceBoundary userId={userId} goalId={goalId}>
      <GoalReviewRoute goalId={goalId} />
    </GoalDeletionFenceBoundary>
  );
}

function GoalReviewRoute({ goalId }: { readonly goalId: string }) {
  const session = useSession();
  const sessionLease = useAuthenticatedRequestLease();
  const runGoalDeletionFencedRequest = useRunGoalDeletionFencedRequest();
  const userId = session.user.id;
  const entryId = useId();
  const query = useQuery(
    goalReviewQueryOptions(
      userId,
      goalId,
      entryId,
      sessionLease,
      runGoalDeletionFencedRequest,
    ),
  );
  if (query.isPending) return <PageLoading />;
  if (query.isError) return <PageError retry={() => void query.refetch()} />;
  return (
    <GoalReviewEntry
      key={`${userId}:${query.data.goal.id}`}
      review={query.data}
      userId={userId}
    />
  );
}

function isSameReviewWorkspace(left: GoalReview, right: GoalReview): boolean {
  return (
    left.goal.id === right.goal.id &&
    left.goal.revision === right.goal.revision &&
    left.reviewDraft.id === right.reviewDraft.id &&
    left.triggerCycle.id === right.triggerCycle.id &&
    left.triggerCycle.sequenceNumber === right.triggerCycle.sequenceNumber
  );
}

function GoalReviewEntry({
  review,
  userId,
}: {
  readonly review: GoalReview;
  readonly userId: string;
}) {
  const goalId = review.goal.id;
  const canonicalGoal = useQuery<{ readonly goal: Goal }>({
    queryKey: userQueryKeys.goal(userId, goalId),
    queryFn: skipToken,
  }).data?.goal;
  const currentReview = useQuery<GoalReview>({
    queryKey: userQueryKeys.review(userId, goalId),
    queryFn: skipToken,
  }).data;
  const resolution = resolveGoalReviewPublication({
    canonicalGoal,
    currentReview,
    incoming: review,
  });
  const resolvedReview =
    resolution.kind === "accept" || resolution.kind === "preserve-current"
      ? resolution.snapshot
      : undefined;
  const [committedReview, setCommittedReview] = useState<
    GoalReview | undefined
  >(undefined);
  const recordCommittedReview = useCallback((candidate: GoalReview) => {
    setCommittedReview((current) => current ?? candidate);
  }, []);
  const admittedReview = committedReview ?? resolvedReview;
  const workspaceMoved =
    committedReview !== undefined &&
    (!resolvedReview ||
      !isSameReviewWorkspace(committedReview, resolvedReview));

  if (!admittedReview)
    return <ReviewWorkspaceMoved goalId={canonicalGoal?.id ?? goalId} />;
  return (
    <ReviewEditor
      key={admittedReview.reviewDraft.id}
      review={admittedReview}
      workspaceMoved={workspaceMoved}
      onCommitted={recordCommittedReview}
    />
  );
}

function ReviewWorkspaceMoved({ goalId }: { readonly goalId: string }) {
  return (
    <main className="page review-page">
      <section className="editor-card">
        <div className="draft-notice" role="alert">
          Reviewの作業場所は変わりました。
          <Link to={`/goals/${goalId}`}>現在のGoalを開いてください</Link>。
        </div>
      </section>
    </main>
  );
}

function ReviewEditor({
  review,
  workspaceMoved,
  onCommitted,
}: {
  readonly review: GoalReview;
  readonly workspaceMoved: boolean;
  readonly onCommitted: (review: GoalReview) => void;
}) {
  const { goal, reviewDraft, triggerCycle } = review;
  const session = useSession();
  const userId = session.user.id;
  const sessionLease = useAuthenticatedRequestLease();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const runPostCommitCleanup = usePostCommitCleanup();
  const captureRouteOwnership = useCapturePostCommitRouteOwnership();
  const actionGuidanceBaseId = useId();
  const textLimitFeedbackId = useId();
  const markDeletedGoal = useStartGoalDeletionFence();
  const mountedGenerationRef = useRef(true);
  const deletedFenceStartedRef = useRef(false);
  useLayoutEffect(() => {
    mountedGenerationRef.current = true;
    return () => {
      mountedGenerationRef.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    forgetSelectedCycleFrame(triggerCycle.id);
  }, [triggerCycle.id]);
  useLayoutEffect(() => onCommitted(review), [onCommitted, review]);
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
  const fenceStrictGoalNotFound = useCallback(
    (
      cause: unknown,
      routeOwnership: PostCommitRouteOwnershipToken,
    ): boolean => {
      if (!isGoalNotFound(cause)) return false;
      markDeletedGoal(routeOwnership);
      return true;
    },
    [markDeletedGoal],
  );
  const save = useCallback(
    async (body: string, revision: number, signal: AbortSignal) => {
      const routeOwnership = captureRouteOwnership();
      try {
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
        signal.throwIfAborted();
        const current = cache.getQueryData<GoalReview>(
          userQueryKeys.review(userId, goal.id),
        )?.reviewDraft;
        if (current?.id === saved.id && current.revision <= saved.revision)
          cacheReviewDraft(cache, userId, goal.id, saved);
        return saved;
      } catch (cause) {
        fenceStrictGoalNotFound(cause, routeOwnership);
        throw cause;
      }
    },
    [
      cache,
      captureRouteOwnership,
      fenceStrictGoalNotFound,
      goal.id,
      reviewDraft.id,
      session.csrfToken,
      sessionLease,
      userId,
    ],
  );
  const loadLatest = useCallback(
    async (signal: AbortSignal) => {
      const routeOwnership = captureRouteOwnership();
      try {
        return (await getReview(sessionLease, goal.id, signal)).reviewDraft;
      } catch (cause) {
        fenceStrictGoalNotFound(cause, routeOwnership);
        throw cause;
      }
    },
    [captureRouteOwnership, fenceStrictGoalNotFound, goal.id, sessionLease],
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
  const editorHydrating = editor.hydrating;
  const editorScopeMovedHref = editor.scopeMovedHref;
  const markEditorScopeMoved = editor.markScopeMoved;
  const workspaceMovedHref =
    editorScopeMovedHref ?? (workspaceMoved ? `/goals/${goal.id}` : null);
  const workspaceIsMoved = workspaceMovedHref !== null;
  const editorReadOnly =
    editor.revisionConflictActive || workspaceIsMoved || pending;
  const boundedInput = useBoundedTextInput({
    value: editor.body,
    maximumCodePoints: GOAL_TEXT_MAX_CODE_POINTS,
    scopeKey: subjectKey,
    readOnly: editorReadOnly,
    onAccept: editor.setBody,
  });
  useLayoutEffect(() => {
    if (!workspaceMoved || editorHydrating || editorScopeMovedHref) return;
    setConfirmation(undefined);
    setCommandRecovery({ kind: "ready" });
    void markEditorScopeMoved(`/goals/${goal.id}`);
  }, [
    editorHydrating,
    editorScopeMovedHref,
    goal.id,
    markEditorScopeMoved,
    workspaceMoved,
  ]);
  const count = codePointCount(editor.body);
  const changed = textDiffersAfterLineEndingNormalization(
    editor.body,
    goal.currentVersion.body,
  );

  const fenceDeletedGoalEditor = useCallback(() => {
    if (deletedFenceStartedRef.current) return;
    deletedFenceStartedRef.current = true;
    void markEditorScopeMoved("/", { preserveUnsaved: false });
    commandRecoveryEpochRef.current += 1;
    if (mountedGenerationRef.current) {
      setCommandRecovery({ kind: "deleted" });
      setPending(false);
      setError(undefined);
    }
  }, [markEditorScopeMoved]);
  useGoalDeletionEditorFence(fenceDeletedGoalEditor);

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
    if (workspaceIsMoved) return;
    const routeOwnership = captureRouteOwnership();
    setError(undefined);
    const expectedDraftRevision = editor.revision;
    const expectedGoalRevision = goal.revision;
    await refinement.request(
      editor.body,
      async () => {
        try {
          return await refineOperation.invoke(
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
          );
        } catch (cause) {
          fenceStrictGoalNotFound(cause, routeOwnership);
          throw cause;
        }
      },
      editor.isActiveScope,
    );
  }
  async function adopt() {
    if (workspaceIsMoved || refinement.state.kind !== "suggested") return;
    const routeOwnership = captureRouteOwnership();
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
    } catch (cause) {
      if (fenceStrictGoalNotFound(cause, routeOwnership)) return;
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
    if (editor.hydrating || workspaceIsMoved) return;
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
    if (editor.hydrating || workspaceIsMoved) return;
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
    if (editor.hydrating || workspaceIsMoved) return;
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
  const conflictRetryBlocked =
    editor.resolvingConflict ||
    Boolean(editor.recoveryConflict) ||
    workspaceIsMoved;
  const actionControls = getGoalReviewActionControls({
    valid,
    saveState: editor.state,
    aiRunning: refinement.state.kind === "running",
    pending,
    hydrating: editor.hydrating,
    workspaceMoved: workspaceIsMoved,
    recovery: editor.resolvingConflict
      ? "resolving"
      : editor.recoveryConflict
        ? "choice"
        : null,
  });
  const actionGuidanceId = (reason: GoalReviewActionDisabledReason): string => {
    if (reason === "workspace-moved") return "goal-review-workspace-moved";
    if (reason === "recovery-resolving")
      return "goal-review-recovery-resolving";
    if (reason === "recovery-choice") return "goal-review-recovery-choice";
    return `${actionGuidanceBaseId}-${reason}`;
  };
  const actionDescribedBy = (
    reason: GoalReviewActionDisabledReason | undefined,
  ) => (reason ? actionGuidanceId(reason) : undefined);
  const localActionGuidance = Array.from(
    new Set(
      Object.values(actionControls)
        .map((control) => control.reason)
        .filter(
          (reason): reason is GoalReviewActionDisabledReason =>
            reason !== undefined &&
            reason !== "workspace-moved" &&
            reason !== "recovery-resolving" &&
            reason !== "recovery-choice",
        ),
    ),
  );
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
            focusTargetId="goal-review-recovery-choice"
            onRestore={editor.restoreRecovery}
            onDiscard={editor.discardRecovery}
          />
        )}
        {editor.resolvingConflict && (
          <p
            className="draft-notice"
            id="goal-review-recovery-resolving"
            role="status"
            aria-live="polite"
          >
            別の更新を確認しています…
          </p>
        )}
        {commandRecovery?.kind === "deleted" && (
          <div
            className="draft-notice draft-notice--conflict"
            id="goal-review-workspace-moved"
            role="alert"
          >
            <p>このGoalはすでに削除されています。</p>
            <Link className="button button--primary" to="/">
              ホームへ戻る
            </Link>
          </div>
        )}
        {workspaceMovedHref && commandRecovery?.kind !== "deleted" && (
          <div
            className="draft-notice"
            id="goal-review-workspace-moved"
            role="alert"
          >
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
                  to={workspaceMovedHref}
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
          aria-describedby={
            boundedInput.feedback ? textLimitFeedbackId : undefined
          }
          value={boundedInput.value}
          readOnly={editorReadOnly}
          onChange={boundedInput.onChange}
          onCompositionStart={boundedInput.onCompositionStart}
          onCompositionEnd={boundedInput.onCompositionEnd}
          onBlur={editor.flush}
        />
        {boundedInput.feedback && (
          <p
            className="text-limit-feedback"
            id={textLimitFeedbackId}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {boundedInput.feedback}
          </p>
        )}
        <div className="editor-meta">
          {workspaceMovedHref && commandRecovery ? (
            <span className="read-only-badge">読み取り専用</span>
          ) : (
            <SaveBadge
              state={editor.state}
              retry={conflictRetryBlocked ? undefined : editor.retry}
            />
          )}
          <span>
            {boundedInput.count} / {GOAL_TEXT_MAX_CODE_POINTS}
          </span>
        </div>
        <div className="button-row">
          <button
            className="button button--secondary"
            type="button"
            aria-describedby={actionDescribedBy(actionControls.refine.reason)}
            disabled={!actionControls.refine.enabled}
            onClick={() => void requestRefine()}
          >
            {refinement.state.kind === "running"
              ? "AIが整理しています…"
              : "AIで目標を整える"}
          </button>
        </div>
        {localActionGuidance.map((reason) => (
          <p
            className="action-controls__guidance"
            id={actionGuidanceId(reason)}
            key={reason}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {goalReviewActionGuidanceText(reason)}
          </p>
        ))}
        <GoalRefinementPanel
          id="review"
          state={refinement.state}
          currentBody={editor.body}
          saveState={editor.state}
          pending={pending || workspaceIsMoved}
          failureMessage="AIから提案を取得できませんでした。"
          onDismiss={refinement.dismiss}
          onAdopt={() => void adopt()}
        />
        <p className="next-cycle-note">
          {changed
            ? `変更した目標をGoal v${goal.currentVersion.versionNumber + 1}として保存し、Cycle ${goal.nextCycleSequenceNumber}を開始します`
            : `目標を維持してCycle ${goal.nextCycleSequenceNumber}を開始します`}
        </p>
        <div className="button-row">
          <button
            className="button button--primary"
            type="button"
            aria-describedby={actionDescribedBy(actionControls.continue.reason)}
            disabled={!actionControls.continue.enabled}
            onClick={() => void nextCycle()}
          >
            この目標で次のサイクルへ
          </button>
        </div>
      </section>
      <section className="terminal-actions">
        <h2>この目標を終える</h2>
        {changed && (
          <p>次のサイクルを開始しない場合、現在の変更案は保存されません。</p>
        )}
        <div className="button-row">
          <button
            type="button"
            aria-describedby={actionDescribedBy(actionControls.terminal.reason)}
            disabled={!actionControls.terminal.enabled}
            onClick={() =>
              setConfirmation({ kind: "terminate", outcome: "achieved" })
            }
          >
            目標を達成として終了
          </button>
          <button
            type="button"
            aria-describedby={actionDescribedBy(actionControls.terminal.reason)}
            disabled={!actionControls.terminal.enabled}
            onClick={() =>
              setConfirmation({ kind: "terminate", outcome: "ended" })
            }
          >
            目標を終了
          </button>
          <button
            className="danger-link"
            type="button"
            aria-describedby={actionDescribedBy(actionControls.terminal.reason)}
            disabled={!actionControls.terminal.enabled}
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
