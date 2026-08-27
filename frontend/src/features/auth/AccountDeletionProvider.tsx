import { useCallback, useRef, type PropsWithChildren } from "react";

import { deleteAccount } from "../../shared/api/account";
import { usePostCommitCleanup } from "../../shared/cleanup/postCommitCleanupContext";
import { clearUserDrafts } from "../../shared/drafts/browserDraftCache";
import {
  AccountDeletionContext,
  usePublishAccountDeletionAdvisory,
  type DeleteCurrentAccount,
} from "./accountDeletionContext";
import { runSessionCookieWriter } from "./sessionCookieWriter";
import { useRunTerminalSessionOperation, useSession } from "./sessionContext";

type AccountDeletionProviderProps = PropsWithChildren<{
  readonly reloadApplication?: () => void;
}>;

export function AccountDeletionProvider({
  children,
  reloadApplication = reloadFromServer,
}: AccountDeletionProviderProps) {
  const session = useSession();
  const runTerminalSessionOperation = useRunTerminalSessionOperation();
  const runPostCommitCleanup = usePostCommitCleanup();
  const publishAccountDeletion = usePublishAccountDeletionAdvisory();
  const deletionAttempt = useRef<Promise<void> | undefined>(undefined);

  const deleteCurrentAccount = useCallback<DeleteCurrentAccount>(() => {
    if (deletionAttempt.current) return deletionAttempt.current;

    const displayedUserId = session.user.id;
    const attempt = runTerminalSessionOperation(
      displayedUserId,
      async (currentSession, lease, sessionOwnership) => {
        if (currentSession.user.id !== displayedUserId) {
          throw new Error("session identity changed");
        }
        const deletionCommitted = await runSessionCookieWriter(
          { isCurrent: () => sessionOwnership.isCurrent() },
          async () => {
            await deleteAccount(lease, currentSession.csrfToken);
            publishAccountDeletion(currentSession.user.id);
            return true as const;
          },
        );
        if (deletionCommitted === null) {
          throw new Error("account deletion interrupted");
        }
        await runPostCommitCleanup({
          expectedUserId: currentSession.user.id,
          sessionOwnership,
          cleanup: async () => {
            await clearUserDrafts(currentSession.user.id);
            publishAccountDeletion(currentSession.user.id);
          },
          onSuccess: reloadApplication,
          pendingMessage: "ブラウザに残る下書きを削除しています…",
          failureMessage:
            "アカウントは削除されましたが、このブラウザに残る下書きを削除できませんでした。再試行してください。",
          retryLabel: "ブラウザデータの削除を再試行",
          retainTerminalOnSuccess: true,
        });
      },
    ).catch((error: unknown) => {
      if (deletionAttempt.current === attempt) {
        deletionAttempt.current = undefined;
      }
      throw error;
    });
    deletionAttempt.current = attempt;
    return attempt;
  }, [
    publishAccountDeletion,
    reloadApplication,
    runPostCommitCleanup,
    runTerminalSessionOperation,
    session.user.id,
  ]);

  return (
    <AccountDeletionContext.Provider value={deleteCurrentAccount}>
      {children}
    </AccountDeletionContext.Provider>
  );
}

function reloadFromServer() {
  window.location.assign("/");
}
