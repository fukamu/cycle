import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "../pages/HomePage";
import { PageLoading } from "../shared/components/AsyncState";
import { AppLayout } from "./AppLayout";

const GoalHistoryPage = lazy(() =>
  import("../pages/GoalHistoryPage").then((module) => ({
    default: module.GoalHistoryPage,
  })),
);
const GoalReviewPage = lazy(() =>
  import("../pages/GoalReviewPage").then((module) => ({
    default: module.GoalReviewPage,
  })),
);
const GoalTimelinePage = lazy(() =>
  import("../pages/GoalTimelinePage").then((module) => ({
    default: module.GoalTimelinePage,
  })),
);
const GoalWorkspacePage = lazy(() =>
  import("../pages/GoalWorkspacePage").then((module) => ({
    default: module.GoalWorkspacePage,
  })),
);
const NewGoalPage = lazy(() =>
  import("../pages/NewGoalPage").then((module) => ({
    default: module.NewGoalPage,
  })),
);
const SettingsPage = lazy(() =>
  import("../pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);

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
