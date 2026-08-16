import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { frameCopy, frameOrder } from "../features/cycle-editor/copy";
import { getCompletedCycle } from "../shared/api/cycles";
import { formatCompletedPeriod } from "../shared/date/format";

export function PastCycleDetailPage() {
  const { cycleId = "" } = useParams();
  const query = useQuery({
    queryKey: ["completed-cycle", cycleId],
    queryFn: ({ signal }) => getCompletedCycle(cycleId, signal),
    enabled: cycleId !== "",
  });

  if (query.isPending)
    return <div className="app-message">サイクルを読み込んでいます…</div>;
  if (query.isError) {
    return (
      <div className="app-message app-message--error" role="alert">
        <p>サイクルを読み込めませんでした。</p>
        <Link to="/cycles">一覧へ戻る</Link>
      </div>
    );
  }
  const cycle = query.data.cycle;
  return (
    <main className="page detail-page">
      <Link className="back-link" to="/cycles">
        ← 過去のサイクル
      </Link>
      <header className="page-heading">
        <p className="eyebrow">COMPLETED</p>
        <h1>Cycle {cycle.sequenceNumber}</h1>
        <p>{formatCompletedPeriod(cycle.startedAt, cycle.completedAt)}</p>
      </header>
      <div className="detail-frames">
        {frameOrder.map((frame) => (
          <section className="detail-frame" key={frame}>
            <header>
              <span>{frameCopy[frame].short}</span>
              <h2>{frameCopy[frame].name}</h2>
            </header>
            <p>{cycle[frame] || "（記録なし）"}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
