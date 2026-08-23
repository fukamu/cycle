import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import { AppReferralPromotion } from "../features/app-referral/AppReferralPromotion";
import {
  cacheCreationDraft,
  cacheGoals,
  userMutationKeys,
  userQueryKeys,
} from "../features/goal-collection/goalCache";
import { createGoalDraft, getHome } from "../shared/api/workspace";
import { PageError, PageLoading } from "../shared/components/AsyncState";
import { statusLabel } from "../shared/copy/ja";

export function HomePage() {
  const session = useSession();
  const userId = session.user.id;
  const navigate = useNavigate();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: userQueryKeys.home(userId),
    queryFn: getHome,
  });
  const create = useMutation({
    mutationKey: userMutationKeys.createGoalDraft(userId),
    mutationFn: () => createGoalDraft("", session.csrfToken),
    onSuccess: ({ draft }) => {
      cacheCreationDraft(cache, userId, draft);
      navigate("/goals/new");
    },
  });
  useEffect(() => {
    if (query.data)
      cacheGoals(
        cache,
        userId,
        query.data.progressingGoals,
        query.dataUpdatedAt,
      );
  }, [cache, query.data, query.dataUpdatedAt, userId]);
  if (query.isPending) return <PageLoading />;
  if (query.isError) return <PageError retry={() => void query.refetch()} />;
  const home = query.data;
  return (
    <main className="page home-page">
      <header className="page-heading">
        <p className="eyebrow">G-PDCA WORKSPACE</p>
        <h1>目標から、次の一歩へ。</h1>
        <p>目標ごとに小さなサイクルを回し、学びながら前へ進みます。</p>
      </header>
      <section
        className="goal-collection"
        aria-labelledby="progressing-heading"
      >
        <div className="section-heading">
          <h2 id="progressing-heading">取り組んでいる目標</h2>
          <span>
            {home.progressingGoals.length} / {home.progressingGoalLimit}
          </span>
        </div>
        {home.progressingGoals.length === 0 && (
          <div className="empty-card">
            <p>まだ進行中の目標はありません。</p>
          </div>
        )}
        {home.progressingGoals.map((goal) => {
          const activeWork =
            goal.currentWork?.kind === "active_cycle"
              ? goal.currentWork
              : undefined;
          const target =
            goal.status === "goal_review"
              ? `/goals/${goal.id}/review`
              : activeWork
                ? `/goals/${goal.id}/cycles/${activeWork.cycleId}`
                : `/goals/${goal.id}`;
          return (
            <Link className="goal-card" key={goal.id} to={target}>
              <span className="goal-card__kicker">あなたの目標</span>
              <strong>{goal.currentVersion.body}</strong>
              <div className="goal-card__meta">
                <span>{statusLabel[goal.status]}</span>
                <span>
                  {goal.status === "active_cycle"
                    ? `Cycle ${activeWork?.cycleSequenceNumber ?? ""}`
                    : "前回Cycleを振り返って目標を確認してください"}
                </span>
              </div>
            </Link>
          );
        })}
      </section>
      {home.creationDraft && (
        <section className="draft-card">
          <p className="eyebrow">DRAFT</p>
          <h2>目標の設定を続ける</h2>
          <p>{home.creationDraft.body || "まだ本文はありません。"}</p>
          <Link className="button button--primary" to="/goals/new">
            下書きを開く
          </Link>
        </section>
      )}
      {!home.creationDraft && home.canCreateGoalDraft && (
        <button
          className="button button--primary home-cta"
          type="button"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "準備中…" : "新しい目標を設定"}
        </button>
      )}
      {create.isError && (
        <p className="inline-error" role="alert">
          目標の下書きを作成できませんでした。
        </p>
      )}
      <Link className="history-link" to="/history">
        すべての目標と履歴を見る →
      </Link>
      <AppReferralPromotion />
    </main>
  );
}
