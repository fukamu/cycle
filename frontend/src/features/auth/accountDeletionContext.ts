import { createContext, useContext } from "react";

export type DeleteCurrentAccount = () => Promise<void>;

export const AccountDeletionContext =
  createContext<DeleteCurrentAccount | null>(null);

export function useDeleteCurrentAccount(): DeleteCurrentAccount {
  const value = useContext(AccountDeletionContext);
  if (value === null) {
    throw new Error(
      "useDeleteCurrentAccount must be used within AccountDeletionBoundary",
    );
  }
  return value;
}
