import { queryOptions } from "@tanstack/react-query";

import type { AuthenticatedRequestLease } from "../../shared/api/client";
import { getHome } from "../../shared/api/workspace";
import { userQueryKeys } from "../goal-collection";

export function goalCreationQueryOptions(
  userId: string,
  sessionLease: AuthenticatedRequestLease,
) {
  return queryOptions({
    queryKey: userQueryKeys.home(userId),
    queryFn: ({ signal }) => getHome(sessionLease, signal),
  });
}
