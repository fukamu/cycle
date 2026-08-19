import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { GoalHistoryPage } from "../pages/GoalHistoryPage";
import { GoalReviewPage } from "../pages/GoalReviewPage";
import { GoalTimelinePage } from "../pages/GoalTimelinePage";
import { GoalWorkspacePage } from "../pages/GoalWorkspacePage";
import { HomePage } from "../pages/HomePage";
import { NewGoalPage } from "../pages/NewGoalPage";
import { SettingsPage } from "../pages/SettingsPage";
import { AppLayout } from "./AppLayout";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/goals/new" element={<NewGoalPage />} />
          <Route path="/goals/:goalId" element={<GoalWorkspacePage />} />
          <Route
            path="/goals/:goalId/cycles/:cycleId"
            element={<GoalWorkspacePage />}
          />
          <Route path="/goals/:goalId/review" element={<GoalReviewPage />} />
          <Route path="/history" element={<GoalHistoryPage />} />
          <Route path="/history/goals/:goalId" element={<GoalTimelinePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
