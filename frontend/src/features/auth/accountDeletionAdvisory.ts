import { isUUIDv7 } from "../../shared/id/uuid";

const CHANNEL_NAME = "fukamu-cycle-account-deletion-v1";
const MESSAGE_VERSION = 1;

type AccountDeletionAdvisoryMessage = {
  readonly version: typeof MESSAGE_VERSION;
  readonly deletedUserId: string;
};

type MessageEventLike = {
  readonly data: unknown;
};

export type AccountDeletionAdvisoryChannelLike = {
  readonly postMessage: (message: AccountDeletionAdvisoryMessage) => void;
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

export type AccountDeletionAdvisory = {
  readonly publish: (deletedUserId: string) => void;
  readonly close: () => void;
};

export type AccountDeletionAdvisoryFactory = (
  name: string,
) => AccountDeletionAdvisoryChannelLike;

export function createAccountDeletionAdvisory(
  onDeletedUserId: (deletedUserId: string) => void,
  factory: AccountDeletionAdvisoryFactory | undefined = defaultFactory(),
): AccountDeletionAdvisory | null {
  if (factory === undefined) return null;

  let channel: AccountDeletionAdvisoryChannelLike;
  try {
    channel = factory(CHANNEL_NAME);
  } catch {
    return null;
  }
  let active = true;
  const receive = (event: MessageEventLike) => {
    if (!active) return;
    let deletedUserId: string | null;
    try {
      deletedUserId = parseDeletedUserId(event.data);
    } catch {
      return;
    }
    if (deletedUserId === null) return;
    try {
      onDeletedUserId(deletedUserId);
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
    publish: (deletedUserId) => {
      if (!active || !isUUIDv7(deletedUserId)) return;
      try {
        channel.postMessage({ version: MESSAGE_VERSION, deletedUserId });
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

function parseDeletedUserId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.version !== MESSAGE_VERSION ||
    typeof candidate.deletedUserId !== "string" ||
    !isUUIDv7(candidate.deletedUserId)
  ) {
    return null;
  }
  return candidate.deletedUserId;
}

function defaultFactory(): AccountDeletionAdvisoryFactory | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  return (name) => new BroadcastChannel(name);
}
