import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import type { Session } from "../../shared/api/schemas";
import type { AutoSaveScopeRegistry } from "../../shared/autosave/AutoSaveScopeProvider";
import { clearUserDrafts } from "../../shared/drafts/browserDraftCache";
import {
  createAccountDeletionAdvisory,
  type AccountDeletionAdvisory,
  type AccountDeletionAdvisoryFactory,
} from "./accountDeletionAdvisory";
import type { PublishAccountDeletionAdvisory } from "./accountDeletionContext";

type AccountDeletionAdvisoryOptions = {
  readonly queryClient: QueryClient;
  readonly sessionQueryKey: QueryKey;
  readonly autoSaveScopes: AutoSaveScopeRegistry;
  readonly suspendInteractionAndInvalidateLease: () => void;
  readonly onUnboundAccountDeletionAdvisory: () => void;
  readonly reloadApplication: () => void;
  readonly factory: AccountDeletionAdvisoryFactory | undefined;
};

export function useAccountDeletionAdvisory({
  queryClient,
  sessionQueryKey,
  autoSaveScopes,
  suspendInteractionAndInvalidateLease,
  onUnboundAccountDeletionAdvisory,
  reloadApplication,
  factory,
}: AccountDeletionAdvisoryOptions): PublishAccountDeletionAdvisory {
  const advisoryRef = useRef<AccountDeletionAdvisory | null>(null);
  const cleanupAttemptRef = useRef<Promise<void> | undefined>(undefined);
  const cleanupRetryRequestedRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    function startCleanup(deletedUserId: string): void {
      const attempt = (async () => {
        await autoSaveScopes.quiesce({ preserveDrafts: false });
        await clearUserDrafts(deletedUserId);
      })();
      cleanupAttemptRef.current = attempt;
      void attempt.then(
        () => {
          cleanupRetryRequestedRef.current = false;
          if (!mountedRef.current) return;
          try {
            reloadApplication();
          } catch {
            // A fixed suspended-session screen remains if reload is unavailable.
          }
        },
        () => {
          if (cleanupAttemptRef.current !== attempt) return;
          cleanupAttemptRef.current = undefined;
          if (!cleanupRetryRequestedRef.current) return;
          cleanupRetryRequestedRef.current = false;
          startCleanup(deletedUserId);
        },
      );
    }

    const advisory = createAccountDeletionAdvisory((deletedUserId) => {
      const currentSession = queryClient.getQueryData<Session>(sessionQueryKey);
      if (currentSession === undefined) {
        onUnboundAccountDeletionAdvisory();
        return;
      }
      if (currentSession.user.id !== deletedUserId) return;

      suspendInteractionAndInvalidateLease();
      if (cleanupAttemptRef.current !== undefined) {
        cleanupRetryRequestedRef.current = true;
        return;
      }
      startCleanup(deletedUserId);
    }, factory);
    advisoryRef.current = advisory;
    return () => {
      mountedRef.current = false;
      advisory?.close();
      if (advisoryRef.current === advisory) advisoryRef.current = null;
    };
  }, [
    autoSaveScopes,
    factory,
    onUnboundAccountDeletionAdvisory,
    queryClient,
    reloadApplication,
    sessionQueryKey,
    suspendInteractionAndInvalidateLease,
  ]);

  return useCallback((deletedUserId: string) => {
    advisoryRef.current?.publish(deletedUserId);
  }, []);
}
