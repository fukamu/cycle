import { queryOptions } from "@tanstack/react-query";

import { userQueryKeys } from "../goal-collection";
import type { AuthenticatedRequestLease } from "../../shared/api/client";
import { getReview } from "../../shared/api/workspace";

export function goalReviewQueryOptions(
  userId: string,
  goalId: string,
  sessionLease: AuthenticatedRequestLease,
) {
  return queryOptions({
    queryKey: userQueryKeys.review(userId, goalId),
    queryFn: ({ signal }) => getReview(sessionLease, goalId, signal),
  });
}
