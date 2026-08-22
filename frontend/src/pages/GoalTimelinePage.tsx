import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { goalQueryKey } from "../features/goal-collection/goalCache";
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
  const { goalId = "" } = useParams();
  const goal = useQuery({
    queryKey: goalQueryKey(goalId),
    queryFn: () => getGoal(goalId),
  });
  const cycles = useInfiniteQuery({
    queryKey: ["goal", goalId, "cycles"],
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
      <ol className="timeline">
        {groups.map((group) => (
          <li
            className="timeline-segment"
            data-version-kind={group.kind}
            data-version-number={group.version.versionNumber}
            key={group.version.id}
          >
            <span className="timeline-segment__marker" aria-hidden="true" />
            {group.cycles.length > 0 && (
              <span className="timeline-segment__rail" aria-hidden="true" />
            )}
            <div className="timeline-segment__content">
              <div className="timeline-version">
                {group.kind === "revision" && (
                  <p className="version-change">目標を変更しました</p>
                )}
                <p className="eyebrow">GOAL V{group.version.versionNumber}</p>
                <h2>{group.version.body}</h2>
                {group.version.createdAt && (
                  <time dateTime={group.version.createdAt}>
                    {new Date(group.version.createdAt).toLocaleDateString(
                      "ja-JP",
                    )}
                  </time>
                )}
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
        ))}
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
