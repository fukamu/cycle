import { useQuery } from "@tanstack/react-query";

import { useAuthenticatedRequestLease, useSession } from "../features/auth";
import {
  GoalCreationFeature,
  goalCreationQueryOptions,
} from "../features/goal-creation";
import { PageError, PageLoading } from "../shared/components/AsyncState";

export function NewGoalPage() {
  const session = useSession();
  const sessionLease = useAuthenticatedRequestLease();
  const query = useQuery(
    goalCreationQueryOptions(session.user.id, sessionLease),
  );
  if (query.isPending) return <PageLoading />;
  if (query.isError) return <PageError retry={() => void query.refetch()} />;
  return <GoalCreationFeature home={query.data} />;
}
