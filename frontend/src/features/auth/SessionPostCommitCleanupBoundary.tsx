import type { PropsWithChildren } from "react";

import { PostCommitCleanupBoundary } from "../../shared/cleanup/PostCommitCleanupBoundary";
import { useRunPostCommitSessionOperation } from "./sessionContext";

export function SessionPostCommitCleanupBoundary({
  children,
}: PropsWithChildren) {
  const runSessionOperation = useRunPostCommitSessionOperation();

  return (
    <PostCommitCleanupBoundary runSessionOperation={runSessionOperation}>
      {children}
    </PostCommitCleanupBoundary>
  );
}
