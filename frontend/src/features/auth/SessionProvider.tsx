import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type PropsWithChildren } from "react";

import { APIError, requestJSON } from "../../shared/api/client";
import { sessionSchema, type Session } from "../../shared/api/schemas";
import {
  AutoSaveScopeProvider,
  useAutoSaveScopeRegistry,
} from "../../shared/autosave/AutoSaveScopeProvider";
import { cleanupExpiredBrowserDrafts } from "../../shared/drafts/browserDraftCache";
import { BetaAdmissionGate } from "../beta-admission/BetaAdmissionGate";
import {
  clearBootstrapID,
  getOrCreateBootstrapID,
} from "./bootstrapRepository";
import { ReplaceSessionContext, SessionContext } from "./sessionContext";
import { getAnonymousBootstrapToken } from "./turnstile";

const sessionQueryKey = ["session"] as const;

async function loadSession(): Promise<Session> {
  try {
    return await requestJSON("/api/v1/session", sessionSchema);
  } catch (error) {
    if (
      !(error instanceof APIError) ||
      (error.code !== "SESSION_MISSING" && error.code !== "SESSION_EXPIRED")
    ) {
      throw error;
    }
  }
  const bootstrapId = await getOrCreateBootstrapID();
  const turnstileToken = await getAnonymousBootstrapToken();
  const session = await requestJSON(
    "/api/v1/session/anonymous",
    sessionSchema,
    {
      method: "POST",
      body: { bootstrapId, turnstileToken },
    },
  );
  await clearBootstrapID();
  return session;
}

export function SessionProvider({ children }: PropsWithChildren) {
  const browserDraftCleanupStarted = useRef(false);

  useEffect(() => {
    if (browserDraftCleanupStarted.current) return;
    browserDraftCleanupStarted.current = true;
    void cleanupExpiredBrowserDrafts().catch(() => undefined);
  }, []);

  return (
    <AutoSaveScopeProvider>
      <SessionBoundary>{children}</SessionBoundary>
    </AutoSaveScopeProvider>
  );
}

function SessionBoundary({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const transitionRef = useRef<Promise<void>>(Promise.resolve());
  const autoSaveScopes = useAutoSaveScopeRegistry();
  const query = useQuery({
    queryKey: sessionQueryKey,
    queryFn: loadSession,
    staleTime: Number.POSITIVE_INFINITY,
    retry: (failureCount, error) =>
      !isBetaAdmissionRequired(error) && failureCount < 2,
  });

  if (query.isPending) {
    return (
      <div className="app-message" role="status" aria-live="polite">
        セッションを準備しています…
      </div>
    );
  }
  if (query.isError) {
    if (isBetaAdmissionRequired(query.error)) {
      return <BetaAdmissionGate onAdmitted={() => query.refetch()} />;
    }
    return (
      <div className="app-message app-message--error" role="alert">
        <p>FUKAMU Cycleを開始できませんでした。</p>
        <button type="button" onClick={() => void query.refetch()}>
          再試行
        </button>
      </div>
    );
  }
  const renderedSession = query.data;

  function replaceSession(session: Session): Promise<void> {
    const transition = transitionRef.current
      .catch(() => undefined)
      .then(async () => {
        const currentSession =
          queryClient.getQueryData<Session>(sessionQueryKey) ?? renderedSession;
        if (currentSession.user.id === session.user.id) {
          queryClient.setQueryData(sessionQueryKey, session);
          return;
        }

        const oldUserQueryRoot = ["user", currentSession.user.id] as const;
        await autoSaveScopes.quiesce({ preserveDrafts: true });
        await queryClient.cancelQueries({ queryKey: oldUserQueryRoot });
        queryClient.removeQueries({ queryKey: oldUserQueryRoot });
        queryClient.getMutationCache().clear();
        queryClient.setQueryData(sessionQueryKey, session);
      });
    transitionRef.current = transition;
    return transition;
  }

  return (
    <ReplaceSessionContext.Provider value={replaceSession}>
      <SessionContext.Provider
        key={renderedSession.user.id}
        value={renderedSession}
      >
        {children}
      </SessionContext.Provider>
    </ReplaceSessionContext.Provider>
  );
}

function isBetaAdmissionRequired(error: unknown): boolean {
  return error instanceof APIError && error.code === "BETA_ADMISSION_REQUIRED";
}
