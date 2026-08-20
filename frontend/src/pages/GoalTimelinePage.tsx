import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { goalQueryKey } from "../features/goal-collection/goalCache";
import type { CycleSummary, GoalVersion } from "../shared/api/schemas";
import { getGoal, listCycles } from "../shared/api/workspace";
import { PageError, PageLoading } from "../shared/components/AsyncState";
import { statusLabel } from "../shared/copy/ja";
import {
  formatActivePeriod,
  formatCompletedPeriod,
} from "../shared/date/format";

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
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = cycles;
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage)
          void fetchNextPage();
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const groups = useMemo(() => {
    const values = cycles.data?.pages.flatMap((page) => page.items) ?? [];
    const map = new Map<
      string,
      { version: GoalVersion; cycles: CycleSummary[] }
    >();
    for (const cycle of values) {
      const group = map.get(cycle.goalVersion.id) ?? {
        version: cycle.goalVersion,
        cycles: [],
      };
      group.cycles.push(cycle);
      map.set(cycle.goalVersion.id, group);
    }
    return [...map.values()]
      .sort((a, b) => a.version.versionNumber - b.version.versionNumber)
      .map((group) => ({
        ...group,
        cycles: group.cycles.sort(
          (a, b) => a.sequenceNumber - b.sequenceNumber,
        ),
      }));
  }, [cycles.data]);
  if (goal.isPending || cycles.isPending) return <PageLoading />;
  if (goal.isError || cycles.isError)
    return (
      <PageError
        retry={() => {
          void goal.refetch();
          void cycles.refetch();
        }}
      />
    );
  const current = goal.data.goal;
  if (groups.length === 0)
    groups.push({ version: current.currentVersion, cycles: [] });
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
        {groups.map((group, index) => (
          <li className="timeline-version" key={group.version.id}>
            <div
              className="version-marker"
              aria-label={`Goal version ${group.version.versionNumber}`}
            >
              <span aria-hidden="true">●</span>
              <div>
                {index > 0 && (
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
            </div>
            <ol className="timeline-cycles">
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
          </li>
        ))}
      </ol>
      <div ref={sentinel} className="load-sentinel" />
      {cycles.isFetchingNextPage && (
        <p className="app-message">続きを読み込んでいます…</p>
      )}
    </main>
  );
}
