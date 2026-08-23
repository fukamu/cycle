import { useParams } from "react-router-dom";

import { GoalTimelineFeature } from "../features/goal-history";

export function GoalTimelinePage() {
  const { goalId = "" } = useParams();
  return <GoalTimelineFeature goalId={goalId} />;
}
