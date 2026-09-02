import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAuthenticatedRequestLease, useSession } from "../auth";
import {
  cacheCreationDraft,
  userMutationKeys,
  userQueryKeys,
} from "../goal-collection";
import { APIError } from "../../shared/api/client";
import type { GoalDraft, Home } from "../../shared/api/schemas";
import { createGoalDraft, getHome } from "../../shared/api/workspace";
import {
  type PostCommitRouteOwnershipToken,
  useCapturePostCommitRouteOwnership,
} from "../../shared/cleanup/postCommitCleanupContext";

type CreationDraftResult =
  | {
      readonly kind: "created";
      readonly draft: GoalDraft;
      readonly routeOwnership: PostCommitRouteOwnershipToken;
    }
  | {
      readonly kind: "recovered";
      readonly home: Home;
      readonly homeDataUpdateCount: number | undefined;
      readonly homeQuery: object | undefined;
      readonly routeOwnership: PostCommitRouteOwnershipToken;
    }
  | {
      readonly kind: "stale";
      readonly routeOwnership: PostCommitRouteOwnershipToken;
    };

function isCreationDraftConflict(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.status === 409 &&
    error.code === "GOAL_CREATION_DRAFT_ALREADY_EXISTS"
  );
}

export function useGoalCreationDraftCommand(onDraftReady?: () => void) {
  const session = useSession();
  const sessionLease = useAuthenticatedRequestLease();
  const userId = session.user.id;
  const cache = useQueryClient();
  const captureRouteOwnership = useCapturePostCommitRouteOwnership();
  const mutation = useMutation({
    mutationKey: userMutationKeys.createGoalDraft(userId),
    retry: false,
    mutationFn: async (
      routeOwnership: PostCommitRouteOwnershipToken,
    ): Promise<CreationDraftResult> => {
      try {
        const { draft } = await createGoalDraft(
          sessionLease,
          "",
          session.csrfToken,
        );
        return { kind: "created", draft, routeOwnership };
      } catch (error) {
        if (!isCreationDraftConflict(error)) throw error;

        const recoveryIsCurrent = () =>
          routeOwnership.isCurrent() && sessionLease.isCurrent();
        if (!recoveryIsCurrent()) return { kind: "stale", routeOwnership };

        const homeQueryKey = userQueryKeys.home(userId);
        try {
          await cache.cancelQueries({ queryKey: homeQueryKey, exact: true });
        } catch {
          if (!recoveryIsCurrent()) return { kind: "stale", routeOwnership };
          throw error;
        }
        if (!recoveryIsCurrent()) return { kind: "stale", routeOwnership };
        const homeDataUpdateCount =
          cache.getQueryState(homeQueryKey)?.dataUpdateCount;
        const homeQuery = cache
          .getQueryCache()
          .find({ queryKey: homeQueryKey, exact: true });

        let canonicalHome;
        try {
          // Bypass the Query cache after canceling its old in-flight request.
          // This is always a fresh canonical GET and keeps the response private
          // until the route and identity fences are checked in onSuccess.
          canonicalHome = await getHome(sessionLease);
        } catch {
          if (!recoveryIsCurrent()) return { kind: "stale", routeOwnership };
          throw error;
        }

        if (!recoveryIsCurrent()) return { kind: "stale", routeOwnership };
        if (!canonicalHome.creationDraft) throw error;
        return {
          kind: "recovered",
          home: canonicalHome,
          homeDataUpdateCount,
          homeQuery,
          routeOwnership,
        };
      }
    },
    onSuccess: (result) => {
      if (
        result.kind === "stale" ||
        !result.routeOwnership.isCurrent() ||
        !sessionLease.isCurrent()
      )
        return;
      if (result.kind === "created")
        cacheCreationDraft(cache, userId, result.draft);
      else {
        const homeQueryKey = userQueryKeys.home(userId);
        const currentState = cache.getQueryState(homeQueryKey);
        const currentQuery = cache
          .getQueryCache()
          .find({ queryKey: homeQueryKey, exact: true });
        if (
          currentQuery === result.homeQuery &&
          currentState?.dataUpdateCount === result.homeDataUpdateCount
        ) {
          cache.setQueryData(homeQueryKey, result.home);
        } else if (!cache.getQueryData<Home>(homeQueryKey)?.creationDraft) {
          return;
        }
      }
      onDraftReady?.();
    },
  });
  const create = useCallback(
    () => mutation.mutate(captureRouteOwnership()),
    [captureRouteOwnership, mutation],
  );

  return {
    create,
    isError: mutation.isError,
    isPending: mutation.isPending,
  } as const;
}
