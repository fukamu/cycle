import { Fragment, useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import { getGoal, listCycles } from "../shared/api/workspace";
import {
  LoadMoreError,
  PageError,
  PageLoading,
} from "../shared/components/AsyncState";
import { statusLabel } from "../shared/copy/ja";
import {
  formatActivePeriod,
  formatCompletedPeriod,
} from "../shared/date/format";
import { buildTimelineGroups } from "./goalTimelineModel";

export function GoalTimelinePage() {
  const session = useSession();
  const userId = session.user.id;
  const { goalId = "" } = useParams();
  const goal = useQuery({
    queryKey: userQueryKeys.goal(userId, goalId),
    queryFn: () => getGoal(goalId),
  });
  const cycles = useInfiniteQuery({
    queryKey: userQueryKeys.goalCycles(userId, goalId),
    queryFn: ({ pageParam }) => listCycles(goalId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const {
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
  } = cycles;
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry?.isIntersecting &&
          hasNextPage &&
          !isFetchingNextPage &&
          !isFetchNextPageError
        )
          void fetchNextPage();
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchNextPageError, isFetchingNextPage]);
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
          void goal.refetch();
          void cycles.refetch();
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
                  </div>
                  <ol
                    className="timeline-cycles"
                    aria-label={`Goal V${group.version.versionNumber}のサイクル`}
                  >
                    {group.cycles.map((cycle) => {
                      const end = cycle.completedAt ?? cycle.canceledAt;
                      return (
                        <li key={cycle.id}>
                          <Link to={`/goals/${goalId}/cycles/${cycle.id}`}>
                            <span>Cycle {cycle.sequenceNumber}</span>
                            <strong>{statusLabel[cycle.status]}</strong>
                            <time>
                              {end
                                ? formatCompletedPeriod(cycle.startedAt, end)
                                : formatActivePeriod(cycle.startedAt)}
                            </time>
                            <p>{cycle.planPreview || "Pは未入力です"}</p>
                          </Link>
                        </li>
                      );
                    })}
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
      {cycles.isFetchNextPageError && (
        <LoadMoreError retry={() => void cycles.fetchNextPage()} />
      )}
    </main>
  );
}
