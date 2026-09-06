import { queryOptions } from "@tanstack/react-query";

import { preferGoalReview, userQueryKeys } from "../goal-collection";
import type { AuthenticatedRequestLease } from "../../shared/api/client";
import type { GoalReview } from "../../shared/api/schemas";
import { getReview } from "../../shared/api/workspace";

export function goalReviewQueryOptions(
  userId: string,
  goalId: string,
  sessionLease: AuthenticatedRequestLease,
) {
  return queryOptions({
    queryKey: userQueryKeys.review(userId, goalId),
    queryFn: ({ signal }) => getReview(sessionLease, goalId, signal),
    structuralSharing: (current, incoming) =>
      preferGoalReview(
        current as GoalReview | undefined,
        incoming as GoalReview,
      ),
  });
}
