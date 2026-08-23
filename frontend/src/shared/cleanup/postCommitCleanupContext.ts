import { createContext, useContext } from "react";

declare const postCommitSessionOwnershipBrand: unique symbol;

export type PostCommitSessionOwnershipToken = {
  readonly [postCommitSessionOwnershipBrand]: true;
  readonly isCurrent: () => boolean;
};

export type PostCommitSessionOperationRunner = <Result>(
  expectedUserId: string,
  operation: (identityIsCurrent: () => boolean) => Promise<Result>,
) => Promise<Result>;

export type PostCommitCleanupTask = {
  readonly expectedUserId: string;
  readonly sessionOwnership?: PostCommitSessionOwnershipToken;
  readonly cleanup: () => Promise<void>;
  readonly onSuccess: (
    identityIsCurrent: () => boolean,
  ) => void | Promise<void>;
  readonly pendingMessage: string;
  readonly failureMessage: string;
  readonly retryLabel?: string;
  readonly retainTerminalOnSuccess?: boolean;
};

export type RunPostCommitCleanup = (
  task: PostCommitCleanupTask,
) => Promise<void>;

export const PostCommitCleanupContext =
  createContext<RunPostCommitCleanup | null>(null);

export function usePostCommitCleanup(): RunPostCommitCleanup {
  const value = useContext(PostCommitCleanupContext);
  if (value === null) {
    throw new Error(
      "usePostCommitCleanup must be used within PostCommitCleanupBoundary",
    );
  }
  return value;
}
