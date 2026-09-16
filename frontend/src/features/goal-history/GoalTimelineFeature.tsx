import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";

import { useAuthenticatedRequestLease, useSession } from "../auth";
import { userQueryKeys } from "../goal-collection";
import {
  GoalDeletionFenceBoundary,
  useGoalDeletionEditorFence,
  useRunGoalDeletionFencedRequest,
} from "../goal-deletion";
import { getGoal, listCycles } from "../../shared/api/workspace";
import { type CycleSummary } from "../../shared/api/schemas";
import {
  LoadMoreError,
  PageError,
  PageLoading,
} from "../../shared/components/AsyncState";
import {
  cycleCancellationReasonCopy,
  cycleTimelineLearningCopy,
  goalSuccessSignalCopy,
  statusLabel,
} from "../../shared/copy/ja";
import {
  formatActivePeriod,
  formatCompletedPeriod,
} from "../../shared/date/format";
import { hasNonWhitespace } from "../../shared/text/semantics";
import { buildTimelineGroups } from "./goalTimelineModel";
import { useInfiniteScrollTrigger } from "./useInfiniteScrollTrigger";

export function GoalTimelineFeature({ goalId }: { readonly goalId: string }) {
  const userId = useSession().user.id;
  return (
    <GoalDeletionFenceBoundary userId={userId} goalId={goalId}>
      <GoalTimelineDeletionFence userId={userId} goalId={goalId} />
    </GoalDeletionFenceBoundary>
  );
}

function GoalTimelineDeletionFence({
  userId,
  goalId,
}: {
  readonly userId: string;
  readonly goalId: string;
}) {
  const cache = useQueryClient();
  const fencedRef = useRef(false);
  const [fenced, setFenced] = useState(false);
  const fenceTimeline = useCallback(() => {
    if (fencedRef.current) return;
    fencedRef.current = true;

    // Cancellation is part of the synchronous visibility fence. It prevents
    // an already-started initial, refetch, or pagination response from
    // publishing deleted content while durable cleanup is still pending.
    void cache.cancelQueries({
      queryKey: userQueryKeys.goal(userId, goalId),
      exact: true,
    });
    void cache.cancelQueries({
      queryKey: userQueryKeys.goalCycles(userId, goalId),
      exact: true,
    });
    flushSync(() => setFenced(true));
  }, [cache, goalId, userId]);
  useGoalDeletionEditorFence(fenceTimeline);

  return fenced ? null : (
    <GoalTimelineQueries userId={userId} goalId={goalId} />
  );
}

function GoalTimelineQueries({
  userId,
  goalId,
}: {
  readonly userId: string;
  readonly goalId: string;
}) {
  const sessionLease = useAuthenticatedRequestLease();
  const runGoalDeletionFencedRequest = useRunGoalDeletionFencedRequest();
  const goal = useQuery({
    queryKey: userQueryKeys.goal(userId, goalId),
    queryFn: async ({ signal }) => {
      const response = await runGoalDeletionFencedRequest(() =>
        getGoal(sessionLease, goalId, signal),
      );
      signal.throwIfAborted();
      return response;
    },
  });
  const cycles = useInfiniteQuery({
    queryKey: userQueryKeys.goalCycles(userId, goalId),
    queryFn: async ({ pageParam, signal }) => {
      const response = await runGoalDeletionFencedRequest(() =>
        listCycles(sessionLease, goalId, pageParam, signal),
      );
      signal.throwIfAborted();
      return response;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const {
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
  } = cycles;
  const { sentinel, requestNextPage } = useInfiniteScrollTrigger({
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
  });
  const groups = useMemo(
    () =>
      goal.data
        ? buildTimelineGroups(
            cycles.data?.pages ?? [],
            goal.data.goal.currentVersion,
          )
        : [],
    [cycles.data?.pages, goal.data],
  );
  if (goal.isPending || cycles.isPending) return <PageLoading />;
  if (goal.isError || cycles.isLoadingError)
    return (
      <PageError
        retry={() => {
          if (goal.isError) void goal.refetch();
          if (cycles.isLoadingError) void cycles.refetch();
        }}
      />
    );
  const current = goal.data.goal;
  return (
    <main className="page timeline-page">
      <header className="page-heading">
        <p className="eyebrow">GOAL TIMELINE</p>
        <h1>{current.currentVersion.body}</h1>
        <p>
          <span className={`status status--${current.status}`}>
            {statusLabel[current.status]}
          </span>{" "}
          · Cycle {current.cycleCount ?? 0}
        </p>
      </header>
      <ol className="timeline" aria-label="目標の履歴（新しい順）">
        {groups.map((group, index) => {
          const boundaryCycle = groups[index + 1]?.cycles[0];
          const isRevision = group.kind === "revision";
          const isCurrent = group.version.id === current.currentVersion.id;
          return (
            <Fragment key={group.version.id}>
              <li
                className="timeline-period"
                data-timeline-entry="period"
                data-version-kind={group.kind}
                data-version-number={group.version.versionNumber}
                data-version-state={isCurrent ? "current" : "past"}
              >
                {group.cycles.length > 0 && (
                  <span className="timeline-period__rail" aria-hidden="true" />
                )}
                <div className="timeline-period__content">
                  <div className="timeline-version">
                    <p className="eyebrow">
                      GOAL V{group.version.versionNumber}
                    </p>
                    <h2>{group.version.body}</h2>
                    <section
                      className="goal-success-signal-readonly"
                      aria-labelledby={`goal-success-signal-${group.version.id}`}
                    >
                      <h3 id={`goal-success-signal-${group.version.id}`}>
                        {goalSuccessSignalCopy.readOnlyHeading}
                      </h3>
                      <p>
                        {group.version.successSignal ??
                          goalSuccessSignalCopy.unset}
                      </p>
                    </section>
                  </div>
                  <ol
                    className="timeline-cycles"
                    aria-label={`Goal V${group.version.versionNumber}のサイクル`}
                  >
                    {group.cycles.map((cycle) => (
                      <TimelineCycleRow
                        key={cycle.id}
                        cycle={cycle}
                        goalId={goalId}
                      />
                    ))}
                  </ol>
                </div>
              </li>
              <li
                className={`timeline-event timeline-event--${isRevision ? "change" : "created"}`}
                data-event-version={group.version.versionNumber}
                data-timeline-entry="event"
                data-timeline-event={isRevision ? "change" : "created"}
                data-version-state={isCurrent ? "current" : "past"}
              >
                <span className="timeline-event__marker" aria-hidden="true" />
                <div>
                  <p className="eyebrow">
                    {isRevision
                      ? `GOAL V${group.version.versionNumber - 1} → V${group.version.versionNumber}`
                      : "GOAL V1"}
                  </p>
                  <p className="timeline-event__label">
                    {isRevision ? "目標を変更しました" : "目標を設定しました"}
                  </p>
                  <p className="timeline-event__meta">
                    {isRevision && boundaryCycle && (
                      <span>Cycle {boundaryCycle.sequenceNumber}の終了後</span>
                    )}
                    {group.version.createdAt && (
                      <time dateTime={group.version.createdAt}>
                        {new Date(group.version.createdAt).toLocaleDateString(
                          "ja-JP",
                        )}
                      </time>
                    )}
                  </p>
                </div>
              </li>
            </Fragment>
          );
        })}
      </ol>
      <div ref={sentinel} className="load-sentinel" aria-hidden="true" />
      {cycles.isFetchingNextPage && (
        <p className="pagination-status" role="status" aria-live="polite">
          続きを読み込んでいます…
        </p>
      )}
      {cycles.isFetchNextPageError && <LoadMoreError retry={requestNextPage} />}
    </main>
  );
}

function TimelineCycleRow({
  cycle,
  goalId,
}: {
  readonly cycle: CycleSummary;
  readonly goalId: string;
}) {
  const end = cycle.completedAt ?? cycle.canceledAt;
  const provenance = cycleTimelineLearningCopy.metadata(
    cycle.sequenceNumber,
    cycle.goalVersion.versionNumber,
  );
  return (
    <li>
      <article className="timeline-cycle">
        <div className="timeline-cycle__meta">
          <strong>Cycle {cycle.sequenceNumber}</strong>
          <span className="timeline-cycles__status">
            <strong>{statusLabel[cycle.status]}</strong>
            {cycle.cancellationReason === "replanned" && (
              <span>{cycleCancellationReasonCopy.replanned}</span>
            )}
          </span>
          <time>
            {end
              ? formatCompletedPeriod(cycle.startedAt, end)
              : formatActivePeriod(cycle.startedAt)}
          </time>
        </div>
        <p className="timeline-cycle__plan">
          {cycle.planPreview || "Pは未入力です"}
        </p>
        {cycle.learningPreview !== null && (
          <details className="timeline-learning-preview">
            <summary
              aria-label={cycleTimelineLearningCopy.toggleLabel(
                cycle.sequenceNumber,
                cycle.goalVersion.versionNumber,
              )}
            >
              {cycleTimelineLearningCopy.toggle}
            </summary>
            <div
              className="timeline-learning-preview__content"
              role="region"
              aria-label={cycleTimelineLearningCopy.regionLabel(
                cycle.sequenceNumber,
                cycle.goalVersion.versionNumber,
              )}
            >
              <p className="timeline-learning-preview__metadata">
                {provenance}
              </p>
              <LearningPreviewFrame
                heading={cycleTimelineLearningCopy.checkHeading}
                preview={cycle.learningPreview.check}
              />
              <LearningPreviewFrame
                heading={cycleTimelineLearningCopy.actionHeading}
                preview={cycle.learningPreview.action}
              />
            </div>
          </details>
        )}
        <Link
          className="timeline-cycle__detail touch-target touch-target--inline"
          to={`/goals/${goalId}/cycles/${cycle.id}`}
          aria-label={cycleTimelineLearningCopy.detailLabel(
            cycle.sequenceNumber,
            cycle.goalVersion.versionNumber,
          )}
        >
          {cycleTimelineLearningCopy.detail}
        </Link>
      </article>
    </li>
  );
}

function LearningPreviewFrame({
  heading,
  preview,
}: {
  readonly heading: string;
  readonly preview: { readonly text: string; readonly truncated: boolean };
}) {
  return (
    <section className="timeline-learning-preview__frame">
      <h3>{heading}</h3>
      <p>
        {hasNonWhitespace(preview.text)
          ? preview.text
          : cycleTimelineLearningCopy.empty}
      </p>
      {preview.truncated && (
        <p className="timeline-learning-preview__truncation">
          {cycleTimelineLearningCopy.truncated}
        </p>
      )}
    </section>
  );
}
