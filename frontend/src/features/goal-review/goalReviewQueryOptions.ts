import { queryOptions } from "@tanstack/react-query";

import { publishGoalReview, userQueryKeys } from "../goal-collection";
import {
  SessionIdentityError,
  type AuthenticatedRequestLease,
} from "../../shared/api/client";
import { getReview } from "../../shared/api/workspace";

export function goalReviewQueryOptions(
  userId: string,
  goalId: string,
  entryId: string,
  sessionLease: AuthenticatedRequestLease,
) {
  return queryOptions({
    queryKey: userQueryKeys.reviewTransport(userId, goalId, entryId),
    queryFn: async ({ client, signal }) => {
      const incoming = await getReview(sessionLease, goalId, signal);
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
