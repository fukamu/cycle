import { isUUIDv7 } from "../../shared/id/uuid";

const CHANNEL_NAME = "fukamu-cycle-goal-deletion-v1";
const MESSAGE_VERSION = 1;

type GoalDeletionAdvisoryMessage = {
  readonly version: typeof MESSAGE_VERSION;
  readonly deletedUserId: string;
  readonly deletedGoalId: string;
};

type MessageEventLike = {
  readonly data: unknown;
};

export type GoalDeletionAdvisoryChannelLike = {
  readonly postMessage: (message: GoalDeletionAdvisoryMessage) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: MessageEventLike) => void,
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: MessageEventLike) => void,
  ) => void;
  readonly close: () => void;
};

export type GoalDeletionAdvisory = {
  readonly publish: (deletedUserId: string, deletedGoalId: string) => void;
  readonly close: () => void;
};

export type GoalDeletionAdvisoryFactory = (
  name: string,
) => GoalDeletionAdvisoryChannelLike;

export function createGoalDeletionAdvisory(
  onDeletedGoal: (deletedUserId: string, deletedGoalId: string) => void,
  factory: GoalDeletionAdvisoryFactory | undefined = defaultFactory(),
): GoalDeletionAdvisory | null {
  if (factory === undefined) return null;

  let channel: GoalDeletionAdvisoryChannelLike;
  try {
    channel = factory(CHANNEL_NAME);
  } catch {
    return null;
  }

  let active = true;
  const receive = (event: MessageEventLike) => {
    if (!active) return;
    let deletion: ParsedGoalDeletion | null;
    try {
      deletion = parseGoalDeletion(event.data);
    } catch {
      return;
    }
    if (deletion === null) return;
    try {
      onDeletedGoal(deletion.deletedUserId, deletion.deletedGoalId);
    } catch {
      // Durable deletion state remains authoritative if advisory handling fails.
    }
  };

  try {
    channel.addEventListener("message", receive);
  } catch {
    try {
      channel.close();
    } catch {
      // Unsupported or broken advisory channels are a safe no-op.
    }
    return null;
  }

  return {
    publish: (deletedUserId, deletedGoalId) => {
      if (!active || !isUUIDv7(deletedUserId) || !isUUIDv7(deletedGoalId))
        return;
      try {
        channel.postMessage({
          version: MESSAGE_VERSION,
          deletedUserId,
          deletedGoalId,
        });
      } catch {
        // The durable tombstone remains authoritative if delivery is unavailable.
      }
    },
    close: () => {
      if (!active) return;
      active = false;
      try {
        channel.removeEventListener("message", receive);
      } catch {
        // Continue to close even if listener removal is unsupported.
      }
      try {
        channel.close();
      } catch {
        // Cleanup failure must not break application unmount.
      }
    },
  };
}

type ParsedGoalDeletion = {
  readonly deletedUserId: string;
  readonly deletedGoalId: string;
};

function parseGoalDeletion(value: unknown): ParsedGoalDeletion | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.version !== MESSAGE_VERSION ||
    typeof candidate.deletedUserId !== "string" ||
    !isUUIDv7(candidate.deletedUserId) ||
    typeof candidate.deletedGoalId !== "string" ||
    !isUUIDv7(candidate.deletedGoalId)
  ) {
    return null;
  }
  return {
    deletedUserId: candidate.deletedUserId,
    deletedGoalId: candidate.deletedGoalId,
  };
}

function defaultFactory(): GoalDeletionAdvisoryFactory | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  return (name) => new BroadcastChannel(name);
}
