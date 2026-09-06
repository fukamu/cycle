import { useParams } from "react-router-dom";

import { GoalReviewFeature } from "../features/goal-review";

export function GoalReviewPage() {
  const { goalId = "" } = useParams();
  return <GoalReviewFeature goalId={goalId} />;
}
