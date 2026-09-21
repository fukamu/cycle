import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "../pages/HomePage";
import { PageLoading } from "../shared/components/AsyncState";
import { AppLayout } from "./AppLayout";
import {
  loadGoalHistoryPage,
  loadGoalReviewPage,
  loadGoalTimelinePage,
  loadGoalWorkspacePage,
  loadNewGoalPage,
  loadSettingsPage,
} from "./routeModules";

const GoalHistoryPage = lazy(loadGoalHistoryPage);
const GoalReviewPage = lazy(loadGoalReviewPage);
const GoalTimelinePage = lazy(loadGoalTimelinePage);
const GoalWorkspacePage = lazy(loadGoalWorkspacePage);
const NewGoalPage = lazy(loadNewGoalPage);
const SettingsPage = lazy(loadSettingsPage);

function LazyPage({ children }: { readonly children: ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route
          path="/goals/new"
          element={
            <LazyPage>
              <NewGoalPage />
            </LazyPage>
          }
        />
        <Route
          path="/goals/:goalId"
          element={
            <LazyPage>
              <GoalWorkspacePage />
            </LazyPage>
          }
        />
        <Route
          path="/goals/:goalId/cycles/:cycleId"
          element={
            <LazyPage>
              <GoalWorkspacePage />
            </LazyPage>
          }
        />
        <Route
          path="/goals/:goalId/review"
          element={
            <LazyPage>
              <GoalReviewPage />
            </LazyPage>
          }
        />
        <Route
          path="/history"
          element={
            <LazyPage>
              <GoalHistoryPage />
            </LazyPage>
          }
        />
        <Route
          path="/history/goals/:goalId"
          element={
            <LazyPage>
              <GoalTimelinePage />
            </LazyPage>
          }
        />
        <Route
          path="/settings"
          element={
            <LazyPage>
              <SettingsPage />
            </LazyPage>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
