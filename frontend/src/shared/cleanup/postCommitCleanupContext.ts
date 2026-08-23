import { createContext, useContext } from "react";

export type PostCommitCleanupTask = {
  readonly cleanup: () => Promise<void>;
  readonly onSuccess: () => void | Promise<void>;
  readonly pendingMessage: string;
  readonly failureMessage: string;
  readonly retryLabel?: string;
  readonly retainTerminalOnSuccess?: boolean;
};

export type RunPostCommitCleanup = (task: PostCommitCleanupTask) => void;

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
