import { Link } from "react-router-dom";

import type { ProgressingGoalCardViewModel } from "./progressingGoalCardModel";

export function ProgressingGoalCard({
  view,
}: {
  readonly view: ProgressingGoalCardViewModel;
}) {
  const headingId = `progressing-goal-${view.goalId}`;
  return (
    <article className="goal-card" aria-labelledby={headingId}>
      <span className="goal-card__kicker">あなたの目標</span>
      <h3 id={headingId} className="goal-card__goal">
        {view.goalBody}
      </h3>
      <div className="goal-card__progress">
        <p className="goal-card__status">{view.currentPlace}</p>
        <p className="goal-card__helper">{view.helper}</p>
      </div>
      <Link className="button button--primary goal-card__cta" to={view.target}>
        {view.cta}
      </Link>
    </article>
  );
}
