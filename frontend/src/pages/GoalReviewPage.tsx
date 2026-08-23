import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";

import { useAuthenticatedRequestLease, useSession } from "../features/auth";
import {
  GoalReviewFeature,
  goalReviewQueryOptions,
} from "../features/goal-review";
import { PageError, PageLoading } from "../shared/components/AsyncState";

export function GoalReviewPage() {
  const session = useSession();
  const sessionLease = useAuthenticatedRequestLease();
  const userId = session.user.id;
  const { goalId = "" } = useParams();
  const query = useQuery(goalReviewQueryOptions(userId, goalId, sessionLease));
  if (query.isPending) return <PageLoading />;
  if (query.isError) return <PageError retry={() => void query.refetch()} />;
  return <GoalReviewFeature review={query.data} />;
}
