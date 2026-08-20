import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { cacheGoals } from "../features/goal-collection/goalCache";
import { listGoals } from "../shared/api/workspace";
import { PageError, PageLoading } from "../shared/components/AsyncState";
import { statusLabel } from "../shared/copy/ja";
import {
  formatActivePeriod,
  formatCompletedPeriod,
} from "../shared/date/format";

export function GoalHistoryPage() {
  const cache = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ["goals", "all"],
    queryFn: ({ pageParam }) => listGoals("all", pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  useEffect(() => {
    if (query.data) {
      cacheGoals(
        cache,
        query.data.pages.flatMap((page) => page.items),
        query.dataUpdatedAt,
      );
    }
  }, [cache, query.data, query.dataUpdatedAt]);
  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage)
          void fetchNextPage();
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  if (query.isPending) return <PageLoading />;
  if (query.isError) return <PageError retry={() => void query.refetch()} />;
  const goals = query.data.pages.flatMap((page) => page.items);
  return (
    <main className="page history-page">
      <header className="page-heading">
        <p className="eyebrow">GOAL HISTORY</p>
        <h1>目標の履歴</h1>
        <p>進行中、見直し中、終了した目標を、目標ごとに振り返れます。</p>
      </header>
      <section className="history-list" aria-label="目標一覧">
        {goals.length === 0 && (
          <div className="empty-card">まだ目標はありません。</div>
        )}
        {goals.map((goal) => (
          <Link
            className="history-row"
            key={goal.id}
            to={`/history/goals/${goal.id}`}
          >
            <div>
              <span className={`status status--${goal.status}`}>
                {statusLabel[goal.status]}
              </span>
              <h2>{goal.currentVersion.body}</h2>
            </div>
            <div className="history-row__meta">
              <span>Cycle {goal.cycleCount ?? 0}</span>
              <span>
                {goal.terminalAt
                  ? formatCompletedPeriod(goal.createdAt, goal.terminalAt)
                  : formatActivePeriod(goal.createdAt)}
              </span>
            </div>
          </Link>
        ))}
      </section>
      <div ref={sentinel} className="load-sentinel" aria-hidden="true" />
      {query.isFetchingNextPage && (
        <p className="app-message">続きを読み込んでいます…</p>
      )}
    </main>
  );
}
