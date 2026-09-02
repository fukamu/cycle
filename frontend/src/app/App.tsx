import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "../pages/HomePage";
import { PageLoading } from "../shared/components/AsyncState";
import { AppLayout } from "./AppLayout";
import { loadRouteModule } from "./routeModuleLoader";

const GoalHistoryPage = lazy(() =>
  loadRouteModule(
    () => import("../pages/GoalHistoryPage"),
    (module) => module.GoalHistoryPage,
  ),
);
const GoalReviewPage = lazy(() =>
  loadRouteModule(
    () => import("../pages/GoalReviewPage"),
    (module) => module.GoalReviewPage,
  ),
);
const GoalTimelinePage = lazy(() =>
  loadRouteModule(
    () => import("../pages/GoalTimelinePage"),
    (module) => module.GoalTimelinePage,
  ),
);
const GoalWorkspacePage = lazy(() =>
  loadRouteModule(
    () => import("../pages/GoalWorkspacePage"),
    (module) => module.GoalWorkspacePage,
  ),
);
const NewGoalPage = lazy(() =>
  loadRouteModule(
    () => import("../pages/NewGoalPage"),
    (module) => module.NewGoalPage,
  ),
);
const SettingsPage = lazy(() =>
  loadRouteModule(
    () => import("../pages/SettingsPage"),
    (module) => module.SettingsPage,
  ),
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
