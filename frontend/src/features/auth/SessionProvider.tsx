import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

import { APIError, requestJSON } from "../../shared/api/client";
import { sessionSchema, type Session } from "../../shared/api/schemas";
import {
  clearBootstrapID,
  getOrCreateBootstrapID,
} from "./bootstrapRepository";
import { getAnonymousBootstrapToken } from "./recaptcha";
import { ReplaceSessionContext, SessionContext } from "./sessionContext";

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
  const recaptchaToken = await getAnonymousBootstrapToken();
  const session = await requestJSON(
    "/api/v1/session/anonymous",
    sessionSchema,
    {
      method: "POST",
      body: { bootstrapId, recaptchaToken },
    },
  );
  await clearBootstrapID();
  return session;
}

export function SessionProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["session"],
    queryFn: loadSession,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });

  if (query.isPending) {
    return <div className="app-message">セッションを準備しています…</div>;
  }
  if (query.isError) {
    return (
      <div className="app-message app-message--error" role="alert">
        <p>PDCAIを開始できませんでした。</p>
        <button type="button" onClick={() => void query.refetch()}>
          再試行
        </button>
      </div>
    );
  }
  return (
    <ReplaceSessionContext.Provider
      value={(session) => queryClient.setQueryData(["session"], session)}
    >
      <SessionContext.Provider value={query.data}>
        {children}
      </SessionContext.Provider>
    </ReplaceSessionContext.Provider>
  );
}
