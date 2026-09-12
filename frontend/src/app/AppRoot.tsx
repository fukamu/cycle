import { QueryClientProvider } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { BrowserRouter } from "react-router-dom";

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
import {
  persistFirstUseGuideSkipped,
  persistFirstUseGuideStageShown,
} from "../shared/preferences/firstUseGuidePreference";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { RouteHeadingFocusProvider } from "./AppLayout";
import { queryClient } from "./queryClient";

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
          <SessionProvider reloadApplication={reloadApplication}>
            <BrowserRouter>
              <RouteHeadingFocusProvider>
                <SessionPostCommitCleanupBoundary>
                  <SessionIdentityBoundary>
                    <SessionBoundFirstUseGuideProvider>
                      <AccountDeletionProvider>
                        <AppErrorBoundary
                          onRouteModuleRetry={reloadApplication}
                        >
                          <App />
                        </AppErrorBoundary>
                      </AccountDeletionProvider>
                    </SessionBoundFirstUseGuideProvider>
                  </SessionIdentityBoundary>
                </SessionPostCommitCleanupBoundary>
              </RouteHeadingFocusProvider>
            </BrowserRouter>
          </SessionProvider>
        </SessionTransitionNoticeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
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
