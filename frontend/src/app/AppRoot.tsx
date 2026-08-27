import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import { AccountDeletionProvider } from "../features/auth/AccountDeletionProvider";
import { SessionPostCommitCleanupBoundary } from "../features/auth/SessionPostCommitCleanupBoundary";
import {
  SessionIdentityBoundary,
  SessionProvider,
} from "../features/auth/SessionProvider";
import { SessionTransitionNoticeProvider } from "../features/auth/SessionTransitionNoticeProvider";
import { App } from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
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
              <SessionPostCommitCleanupBoundary>
                <SessionIdentityBoundary>
                  <AccountDeletionProvider>
                    <AppErrorBoundary>
                      <App />
                    </AppErrorBoundary>
                  </AccountDeletionProvider>
                </SessionIdentityBoundary>
              </SessionPostCommitCleanupBoundary>
            </BrowserRouter>
          </SessionProvider>
        </SessionTransitionNoticeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
