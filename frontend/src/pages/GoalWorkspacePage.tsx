import { useParams } from "react-router-dom";

import { CycleWorkspaceFeature } from "../features/cycle-workspace";

export function GoalWorkspacePage() {
  const { goalId = "", cycleId = "" } = useParams();
  return <CycleWorkspaceFeature goalId={goalId} cycleId={cycleId} />;
}
