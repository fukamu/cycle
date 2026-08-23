import { useEffect } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { useAuthenticatedRequestLease, useSession } from "../auth";
import { cacheGoals, userQueryKeys } from "../goal-collection";
import { listGoals } from "../../shared/api/workspace";
import {
  LoadMoreError,
  PageError,
  PageLoading,
} from "../../shared/components/AsyncState";
import { statusLabel } from "../../shared/copy/ja";
import {
  formatActivePeriod,
  formatCompletedPeriod,
} from "../../shared/date/format";
import { useInfiniteScrollTrigger } from "./useInfiniteScrollTrigger";

export function GoalHistoryFeature() {
  const session = useSession();
  const sessionLease = useAuthenticatedRequestLease();
  const userId = session.user.id;
  const cache = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: userQueryKeys.goals(userId, "all"),
    queryFn: ({ pageParam, signal }) =>
      listGoals(sessionLease, "all", pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const {
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
  } = query;
  useEffect(() => {
    if (query.data) {
      cacheGoals(
        cache,
        userId,
        query.data.pages.flatMap((page) => page.items),
        query.dataUpdatedAt,
      );
    }
  }, [cache, query.data, query.dataUpdatedAt, userId]);
  const { sentinel, requestNextPage } = useInfiniteScrollTrigger({
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
  });
  if (query.isPending) return <PageLoading />;
  if (query.isLoadingError)
    return <PageError retry={() => void query.refetch()} />;
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
        <p className="pagination-status" role="status" aria-live="polite">
          続きを読み込んでいます…
        </p>
      )}
      {query.isFetchNextPageError && <LoadMoreError retry={requestNextPage} />}
    </main>
  );
}
