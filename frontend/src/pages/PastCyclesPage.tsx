import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { useInfiniteScroll } from "../features/past-cycles/useInfiniteScroll";
import { listCompletedCycles } from "../shared/api/cycles";
import { formatCompletedPeriod } from "../shared/date/format";

export function PastCyclesPage() {
  const query = useInfiniteQuery({
    queryKey: ["completed-cycles"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listCompletedCycles(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const sentinel = useInfiniteScroll(() => {
    if (query.hasNextPage && !query.isFetchingNextPage)
      void query.fetchNextPage();
  }, query.hasNextPage && !query.isFetchingNextPage);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="page list-page">
      <header className="page-heading">
        <p className="eyebrow">ARCHIVE</p>
        <h1>過去のサイクル</h1>
        <p>完了した改善の積み重ねです。</p>
      </header>
      {query.isPending && (
        <p className="app-message">履歴を読み込んでいます…</p>
      )}
      {query.isError && (
        <div className="inline-error" role="alert">
          <p>履歴を読み込めませんでした。</p>
          <button type="button" onClick={() => void query.refetch()}>
            再試行
          </button>
        </div>
      )}
      {!query.isPending && items.length === 0 && (
        <p className="empty-state">完了したサイクルはまだありません。</p>
      )}
      <div className="cycle-list">
        {items.map((item) => (
          <Link className="cycle-card" to={`/cycles/${item.id}`} key={item.id}>
            <div className="cycle-card__number">
              {String(item.sequenceNumber).padStart(2, "0")}
            </div>
            <div>
              <h2>Cycle {item.sequenceNumber}</h2>
              <p className="cycle-card__date">
                {formatCompletedPeriod(item.startedAt, item.completedAt)}
              </p>
              <p>{item.planPreview || "（Pの記録なし）"}</p>
            </div>
            <span aria-hidden="true">→</span>
          </Link>
        ))}
      </div>
      <div ref={sentinel} className="scroll-sentinel" aria-hidden="true" />
      {query.isFetchingNextPage && (
        <p className="loading-more">続きを読み込んでいます…</p>
      )}
    </main>
  );
}
