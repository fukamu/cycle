import { createContext, useContext } from "react";

export type PublishGoalDeletionAdvisory = (
  deletedUserId: string,
  deletedGoalId: string,
) => void;

export type SubscribeGoalDeletionAdvisory = (
  userId: string,
  goalId: string,
  listener: () => void,
) => () => void;

export type GoalDeletionCleanupClaim =
  | {
      readonly kind: "owner";
      readonly completion: Promise<void>;
      readonly complete: () => void;
    }
  | {
      readonly kind: "joined";
      readonly completion: Promise<void>;
    };

export type BeginGoalDeletionCleanup = (
  userId: string,
  goalId: string,
) => GoalDeletionCleanupClaim;

export type GoalDeletionAdvisoryRegistry = {
  readonly publish: PublishGoalDeletionAdvisory;
  readonly subscribe: SubscribeGoalDeletionAdvisory;
  readonly beginCleanup: BeginGoalDeletionCleanup;
};

export const GoalDeletionAdvisoryContext =
  createContext<GoalDeletionAdvisoryRegistry | null>(null);

export function usePublishGoalDeletionAdvisory(): PublishGoalDeletionAdvisory {
  const value = useContext(GoalDeletionAdvisoryContext);
  if (value === null) throw new Error("goal deletion advisory unavailable");
  return value.publish;
}

export function useSubscribeGoalDeletionAdvisory(): SubscribeGoalDeletionAdvisory {
  const value = useContext(GoalDeletionAdvisoryContext);
  if (value === null) throw new Error("goal deletion advisory unavailable");
  return value.subscribe;
}

export function useBeginGoalDeletionCleanup(): BeginGoalDeletionCleanup {
  const value = useContext(GoalDeletionAdvisoryContext);
  if (value === null) throw new Error("goal deletion advisory unavailable");
  return value.beginCleanup;
}
