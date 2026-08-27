import { createContext, useContext } from "react";

declare const postCommitRouteOwnershipBrand: unique symbol;
declare const postCommitSessionOwnershipBrand: unique symbol;

export type PostCommitRouteOwnershipToken = {
  readonly [postCommitRouteOwnershipBrand]: true;
  readonly isCurrent: () => boolean;
};

export type PostCommitSessionOwnershipToken = {
  readonly [postCommitSessionOwnershipBrand]: true;
  readonly isCurrent: () => boolean;
};

export type CapturePostCommitRouteOwnership =
  () => PostCommitRouteOwnershipToken;

export type PostCommitSessionOperationRunner = <Result>(
  expectedUserId: string,
  operation: (identityIsCurrent: () => boolean) => Promise<Result>,
) => Promise<Result>;

export type PostCommitCleanupTask = {
  readonly expectedUserId: string;
  readonly routeOwnership?: PostCommitRouteOwnershipToken;
  readonly sessionOwnership?: PostCommitSessionOwnershipToken;
  readonly cleanup: () => Promise<void>;
  readonly onSuccess: (
    publicationIsCurrent: () => boolean,
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

export const PostCommitRouteOwnershipContext =
  createContext<CapturePostCommitRouteOwnership | null>(null);

export function usePostCommitCleanup(): RunPostCommitCleanup {
  const value = useContext(PostCommitCleanupContext);
  if (value === null) {
    throw new Error(
      "usePostCommitCleanup must be used within PostCommitCleanupBoundary",
    );
  }
  return value;
}

export function useCapturePostCommitRouteOwnership(): CapturePostCommitRouteOwnership {
  const value = useContext(PostCommitRouteOwnershipContext);
  if (value === null) {
    throw new Error(
      "useCapturePostCommitRouteOwnership must be used within PostCommitCleanupBoundary",
    );
  }
  return value;
}
