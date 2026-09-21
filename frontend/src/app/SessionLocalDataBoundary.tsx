import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type PropsWithChildren } from "react";
import { useLocation } from "react-router-dom";

import { useSession } from "../features/auth/sessionContext";
import {
  cacheGoals,
  userQueryKeys,
} from "../features/goal-collection/goalCache";
import type { Cycle, Goal, GoalReview, Home } from "../shared/api/schemas";
import {
  deleteCycleServerSnapshot,
  deleteGoalServerSnapshot,
  deleteHomeServerSnapshot,
  deleteReviewServerSnapshot,
  getCycleServerSnapshot,
  getGoalServerSnapshot,
  getHomeServerSnapshot,
  getReviewServerSnapshot,
  putCycleServerSnapshot,
  putGoalServerSnapshot,
  putHomeServerSnapshot,
  putReviewServerSnapshot,
} from "../shared/drafts/browserDraftCache";
import {
  startupSnapshotTarget,
  type StartupSnapshotTarget,
} from "./startupSnapshotTarget";

const hydratedDataUpdatedAt = 1;
const snapshotWriteQueues = new Map<string, Promise<void>>();

export function SessionLocalDataBoundary({ children }: PropsWithChildren) {
  const userId = useSession().user.id;
  const location = useLocation();
  const cache = useQueryClient();
  const persistedUpdatedAt = useRef(new Map<string, number>());

  useEffect(() => {
    let current = true;
    void hydrateStartupSnapshot(
      cache,
      userId,
      startupSnapshotTarget(location.pathname),
      () => current,
    ).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [cache, location.pathname, userId]);

  useEffect(() => {
    persistedUpdatedAt.current.clear();
    return cache.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const persistenceKey = JSON.stringify(event.query.queryKey);
      if (event.action.type === "invalidate") {
        persistedUpdatedAt.current.delete(persistenceKey);
        enqueueSnapshotWrite(persistenceKey, () =>
          deletePersistedServerSnapshot(userId, event.query.queryKey),
        );
        return;
      }
      const { data, dataUpdatedAt, status } = event.query.state;
      if (
        status !== "success" ||
        data === undefined ||
        dataUpdatedAt <= hydratedDataUpdatedAt
      )
        return;
      if (persistedUpdatedAt.current.get(persistenceKey) === dataUpdatedAt)
        return;
      persistedUpdatedAt.current.set(persistenceKey, dataUpdatedAt);
      enqueueSnapshotWrite(persistenceKey, () =>
        persistServerSnapshot(userId, event.query.queryKey, data),
      );
    });
  }, [cache, userId]);

  return children;
}

async function deletePersistedServerSnapshot(
  userId: string,
  queryKey: QueryKey,
): Promise<void> {
  if (queryKey[0] !== "user" || queryKey[1] !== userId) return;
  if (queryKey[2] === "home" && queryKey.length === 3) {
    await deleteHomeServerSnapshot(userId);
    return;
  }
  const goalId = queryKey[3];
  if (typeof goalId !== "string") return;
  if (queryKey[2] === "goal" && queryKey.length === 4) {
    await deleteGoalServerSnapshot(userId, goalId);
    return;
  }
  if (queryKey[2] === "cycle" && queryKey.length === 5) {
    const cycleId = queryKey[4];
    if (typeof cycleId === "string")
      await deleteCycleServerSnapshot(userId, goalId, cycleId);
    return;
  }
  if (queryKey[2] === "goal-review" && queryKey.length === 4) {
    await deleteReviewServerSnapshot(userId, goalId);
  }
}

function enqueueSnapshotWrite(key: string, write: () => Promise<void>): void {
  const previous = snapshotWriteQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(write)
    .finally(() => {
      if (snapshotWriteQueues.get(key) === current) {
        snapshotWriteQueues.delete(key);
      }
    });
  snapshotWriteQueues.set(key, current);
  void current.catch(() => undefined);
}

async function hydrateStartupSnapshot(
  cache: ReturnType<typeof useQueryClient>,
  userId: string,
  target: StartupSnapshotTarget,
  isCurrent: () => boolean,
): Promise<void> {
  const publish = <Data,>(queryKey: QueryKey, data: Data) => {
    if (!isCurrent() || cache.getQueryState(queryKey)?.data !== undefined)
      return false;
    cache.setQueryData(queryKey, data, { updatedAt: hydratedDataUpdatedAt });
    return true;
  };

  switch (target.kind) {
    case "none":
      return;
    case "home": {
      const snapshot = await getHomeServerSnapshot(userId);
      if (!snapshot || !isCurrent()) return;
      if (publish(userQueryKeys.home(userId), snapshot.data))
        cacheGoals(
          cache,
          userId,
          snapshot.data.progressingGoals,
          hydratedDataUpdatedAt,
        );
      return;
    }
    case "goal": {
      const snapshot = await getGoalServerSnapshot(userId, target.goalId);
      if (snapshot)
        publish(userQueryKeys.goal(userId, target.goalId), {
          goal: snapshot.data,
        });
      return;
    }
    case "cycle": {
      const [goal, cycle] = await Promise.all([
        getGoalServerSnapshot(userId, target.goalId),
        getCycleServerSnapshot(userId, target.goalId, target.cycleId),
      ]);
      if (!isCurrent()) return;
      if (goal)
        publish(userQueryKeys.goal(userId, target.goalId), {
          goal: goal.data,
        });
      if (cycle)
        publish(userQueryKeys.cycle(userId, target.goalId, target.cycleId), {
          cycle: cycle.data,
        });
      return;
    }
    case "review": {
      const snapshot = await getReviewServerSnapshot(userId, target.goalId);
      if (!snapshot || !isCurrent()) return;
      const reviewKey = userQueryKeys.review(userId, target.goalId);
      publish(reviewKey, snapshot.data);
      for (const query of cache
        .getQueryCache()
        .findAll({ queryKey: reviewKey })) {
        if (query.queryKey.length > reviewKey.length)
          publish(query.queryKey, snapshot.data);
      }
      publish(userQueryKeys.goal(userId, target.goalId), {
        goal: snapshot.data.goal,
      });
    }
  }
}

async function persistServerSnapshot(
  userId: string,
  queryKey: QueryKey,
  data: unknown,
): Promise<void> {
  if (queryKey[0] !== "user" || queryKey[1] !== userId) return;
  if (queryKey[2] === "home" && queryKey.length === 3) {
    await putHomeServerSnapshot(userId, data as Home);
    return;
  }
  if (queryKey[2] === "goal" && queryKey.length === 4) {
    const goal = (data as { readonly goal?: Goal }).goal;
    if (goal) await putGoalServerSnapshot(userId, goal);
    return;
  }
  if (queryKey[2] === "cycle" && queryKey.length === 5) {
    const goalId = queryKey[3];
    const cycle = (data as { readonly cycle?: Cycle }).cycle;
    if (typeof goalId === "string" && cycle)
      await putCycleServerSnapshot(userId, goalId, cycle);
    return;
  }
  if (queryKey[2] === "goal-review" && queryKey.length === 4) {
    await putReviewServerSnapshot(userId, data as GoalReview);
  }
}
