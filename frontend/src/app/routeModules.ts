import { loadRouteModule } from "./routeModuleLoader";

export const loadGoalHistoryPage = () =>
  loadRouteModule(
    () => import("../pages/GoalHistoryPage"),
    (module) => module.GoalHistoryPage,
  );
export const loadGoalReviewPage = () =>
  loadRouteModule(
    () => import("../pages/GoalReviewPage"),
    (module) => module.GoalReviewPage,
  );
export const loadGoalTimelinePage = () =>
  loadRouteModule(
    () => import("../pages/GoalTimelinePage"),
    (module) => module.GoalTimelinePage,
  );
export const loadGoalWorkspacePage = () =>
  loadRouteModule(
    () => import("../pages/GoalWorkspacePage"),
    (module) => module.GoalWorkspacePage,
  );
export const loadNewGoalPage = () =>
  loadRouteModule(
    () => import("../pages/NewGoalPage"),
    (module) => module.NewGoalPage,
  );
export const loadSettingsPage = () =>
  loadRouteModule(
    () => import("../pages/SettingsPage"),
    (module) => module.SettingsPage,
  );

export function preloadCurrentRouteModule(pathname = window.location.pathname) {
  let preload: (() => Promise<unknown>) | undefined;
  if (/^\/goals\/new\/?$/u.test(pathname)) preload = loadNewGoalPage;
  else if (/^\/goals\/[^/]+\/review\/?$/u.test(pathname))
    preload = loadGoalReviewPage;
  else if (/^\/goals\/[^/]+(?:\/cycles\/[^/]+)?\/?$/u.test(pathname))
    preload = loadGoalWorkspacePage;
  else if (/^\/history\/goals\/[^/]+\/?$/u.test(pathname))
    preload = loadGoalTimelinePage;
  else if (pathname === "/history" || pathname === "/history/")
    preload = loadGoalHistoryPage;
  else if (pathname === "/settings" || pathname === "/settings/")
    preload = loadSettingsPage;
  if (preload) void preload().catch(() => undefined);
}
