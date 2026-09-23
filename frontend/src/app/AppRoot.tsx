import { QueryClientProvider } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AccountDeletionProvider } from "../features/auth/AccountDeletionProvider";
import { SessionPostCommitCleanupBoundary } from "../features/auth/SessionPostCommitCleanupBoundary";
import { persistFirstUseGuidePreferenceForCapturedUser } from "../features/auth/firstUseGuideSessionPersistence";
import {
  useAuthenticatedRequestLease,
  useSession,
} from "../features/auth/sessionContext";
import {
  SessionIdentityBoundary,
  SessionProvider,
} from "../features/auth/SessionProvider";
import { SessionTransitionNoticeProvider } from "../features/auth/SessionTransitionNoticeProvider";
import {
  FirstUseGuideProvider,
  type FirstUseGuidePersistence,
  type FirstUseGuidePersistenceOwnership,
} from "../features/first-use-guide";
import { readPublicInformationConfiguration } from "../features/public-information/config";
import { PublicInformationPage } from "../pages/PublicInformationPage";
import {
  persistFirstUseGuideSkipped,
  persistFirstUseGuideStageShown,
} from "../shared/preferences/firstUseGuidePreference";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { RouteHeadingFocusProvider } from "./RouteHeadingFocus";
import { queryClient } from "./queryClient";
import { SessionLocalDataBoundary } from "./SessionLocalDataBoundary";

type AppRootProps = {
  readonly reloadApplication?: () => void;
};

function reloadCurrentApplication(): void {
  window.location.reload();
}

export function AppRoot({
  reloadApplication = reloadCurrentApplication,
}: AppRootProps = {}) {
  return (
    <AppErrorBoundary onRetry={reloadApplication}>
      <QueryClientProvider client={queryClient}>
        <SessionTransitionNoticeProvider>
          <BrowserRouter>
            <RouteHeadingFocusProvider>
              <Routes>
                <Route
                  path="/legal/privacy"
                  element={<PublicInformationPage />}
                />
                <Route
                  path="*"
                  element={
                    <SessionApplication reloadApplication={reloadApplication} />
                  }
                />
              </Routes>
            </RouteHeadingFocusProvider>
          </BrowserRouter>
        </SessionTransitionNoticeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

function SessionApplication({ reloadApplication }: Required<AppRootProps>) {
  if (readPublicInformationConfiguration() === undefined) {
    return <PublicInformationPage />;
  }

  return (
    <SessionProvider reloadApplication={reloadApplication}>
      <SessionPostCommitCleanupBoundary>
        <SessionIdentityBoundary>
          <SessionLocalDataBoundary>
            <SessionBoundFirstUseGuideProvider>
              <AccountDeletionProvider>
                <AppErrorBoundary onRouteModuleRetry={reloadApplication}>
                  <App />
                </AppErrorBoundary>
              </AccountDeletionProvider>
            </SessionBoundFirstUseGuideProvider>
          </SessionLocalDataBoundary>
        </SessionIdentityBoundary>
      </SessionPostCommitCleanupBoundary>
    </SessionProvider>
  );
}

function SessionBoundFirstUseGuideProvider({ children }: PropsWithChildren) {
  const session = useSession();
  const lease = useAuthenticatedRequestLease();
  const providerMountedRef = useRef(true);
  const [lifecycleAbortController] = useState(() => new AbortController());
  useEffect(() => {
    providerMountedRef.current = true;
    return () => {
      providerMountedRef.current = false;
      queueMicrotask(() => {
        if (!providerMountedRef.current) lifecycleAbortController.abort();
      });
    };
  }, [lifecycleAbortController]);
  const lifecycle = useMemo(
    () => ({
      signal: lifecycleAbortController.signal,
      isCurrent: () =>
        providerMountedRef.current && !lifecycleAbortController.signal.aborted,
    }),
    [lifecycleAbortController],
  );
  const persistForCurrentUser = useCallback(
    (registration: FirstUseGuidePersistenceOwnership, persist: () => void) => {
      void persistFirstUseGuidePreferenceForCapturedUser({
        expectedUserId: session.user.id,
        lease,
        lifecycle,
        registration,
        persist,
      });
    },
    [lease, lifecycle, session.user.id],
  );
  const persistence = useMemo<FirstUseGuidePersistence>(
    () => ({
      persistStageShown: (stage, registration) =>
        persistForCurrentUser(registration, () =>
          persistFirstUseGuideStageShown(stage),
        ),
      persistSkipped: (registration) =>
        persistForCurrentUser(registration, persistFirstUseGuideSkipped),
    }),
    [persistForCurrentUser],
  );

  return (
    <FirstUseGuideProvider persistence={persistence}>
      {children}
    </FirstUseGuideProvider>
  );
}
