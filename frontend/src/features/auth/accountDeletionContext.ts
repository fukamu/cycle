import { createContext, useContext } from "react";

export type DeleteCurrentAccount = () => Promise<void>;
export type PublishAccountDeletionAdvisory = (deletedUserId: string) => void;

export const AccountDeletionContext =
  createContext<DeleteCurrentAccount | null>(null);
export const AccountDeletionAdvisoryPublishContext =
  createContext<PublishAccountDeletionAdvisory | null>(null);

export function usePublishAccountDeletionAdvisory(): PublishAccountDeletionAdvisory {
  const value = useContext(AccountDeletionAdvisoryPublishContext);
  if (value === null) throw new Error("account deletion advisory unavailable");
  return value;
}

export function useDeleteCurrentAccount(): DeleteCurrentAccount {
  const value = useContext(AccountDeletionContext);
  if (value === null) {
    throw new Error(
      "useDeleteCurrentAccount must be used within AccountDeletionBoundary",
    );
  }
  return value;
}
