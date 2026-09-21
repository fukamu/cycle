import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { publishGoalReview, userQueryKeys } from "../goal-collection";
import type { RunGoalDeletionFencedRequest } from "../goal-deletion";
import {
  SessionIdentityError,
  type AuthenticatedRequestLease,
} from "../../shared/api/client";
import type { GoalReview } from "../../shared/api/schemas";
import { getReview } from "../../shared/api/workspace";

export function goalReviewQueryOptions(
  userId: string,
  goalId: string,
  entryId: string,
  sessionLease: AuthenticatedRequestLease,
  runGoalDeletionFencedRequest: RunGoalDeletionFencedRequest,
  cache?: QueryClient,
) {
  const canonicalKey = userQueryKeys.review(userId, goalId);
  return queryOptions({
    queryKey: userQueryKeys.reviewTransport(userId, goalId, entryId),
    initialData: () => {
      const canonical = cache?.getQueryState<GoalReview>(canonicalKey);
      return canonical?.dataUpdatedAt === 1 ? canonical.data : undefined;
    },
    initialDataUpdatedAt: 1,
    refetchOnMount: "always",
    queryFn: async ({ client, signal }) => {
      const incoming = await runGoalDeletionFencedRequest(() =>
        getReview(sessionLease, goalId, signal),
      );
      signal.throwIfAborted();
      if (
        sessionLease.expectedUserId !== userId ||
        sessionLease.signal.aborted ||
        !sessionLease.isCurrent()
      )
        throw new SessionIdentityError("SESSION_IDENTITY_STALE");

      const resolution = publishGoalReview(client, userId, incoming);
      return resolution.kind === "accept" ||
        resolution.kind === "preserve-current"
        ? resolution.snapshot
        : incoming;
    },
  });
}
