import { useCallback, useRef, type PropsWithChildren } from "react";

import { deleteAccount } from "../../shared/api/account";
import { useAutoSaveScopeRegistry } from "../../shared/autosave/AutoSaveScopeProvider";
import { usePostCommitCleanup } from "../../shared/cleanup/postCommitCleanupContext";
import { clearUserDrafts } from "../../shared/drafts/browserDraftCache";
import {
  AccountDeletionContext,
  type DeleteCurrentAccount,
} from "./accountDeletionContext";
import { useSession } from "./sessionContext";

type AccountDeletionProviderProps = PropsWithChildren<{
  readonly reloadApplication?: () => void;
}>;

export function AccountDeletionProvider({
  children,
  reloadApplication = reloadFromServer,
}: AccountDeletionProviderProps) {
  const session = useSession();
  const autoSaveScopes = useAutoSaveScopeRegistry();
  const runPostCommitCleanup = usePostCommitCleanup();
  const deletionAttempt = useRef<Promise<void> | undefined>(undefined);

  const deleteCurrentAccount = useCallback<DeleteCurrentAccount>(() => {
    if (deletionAttempt.current) return deletionAttempt.current;

    const { csrfToken, user } = session;
    const attempt = (async () => {
      await autoSaveScopes.quiesce({ preserveDrafts: true });
      await deleteAccount(csrfToken);
      runPostCommitCleanup({
        cleanup: () => clearUserDrafts(user.id),
        onSuccess: reloadApplication,
        pendingMessage: "ブラウザに残る下書きを削除しています…",
        failureMessage:
          "アカウントは削除されましたが、このブラウザに残る下書きを削除できませんでした。再試行してください。",
        retryLabel: "ブラウザデータの削除を再試行",
        retainTerminalOnSuccess: true,
      });
    })().catch((error: unknown) => {
      if (deletionAttempt.current === attempt) {
        deletionAttempt.current = undefined;
      }
      throw error;
    });
    deletionAttempt.current = attempt;
    return attempt;
  }, [autoSaveScopes, reloadApplication, runPostCommitCleanup, session]);

  return (
    <AccountDeletionContext.Provider value={deleteCurrentAccount}>
      {children}
    </AccountDeletionContext.Provider>
  );
}

function reloadFromServer() {
  window.location.assign("/");
}
