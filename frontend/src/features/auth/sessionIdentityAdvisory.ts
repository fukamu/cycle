import { isUUIDv7 } from "../../shared/id/uuid";

const CHANNEL_NAME = "fukamu-cycle-session-identity-v1";
const MESSAGE_VERSION = 1;

type AdvisoryMessage = {
  readonly version: typeof MESSAGE_VERSION;
  readonly targetUserId: string;
};

type MessageEventLike = {
  readonly data: unknown;
};

export type SessionIdentityAdvisoryChannelLike = {
  readonly postMessage: (message: AdvisoryMessage) => void;
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

export type SessionIdentityAdvisory = {
  readonly publish: (targetUserId: string) => void;
  readonly close: () => void;
};

export type SessionIdentityAdvisoryFactory = (
  name: string,
) => SessionIdentityAdvisoryChannelLike;

export function createSessionIdentityAdvisory(
  onTargetUserId: (targetUserId: string) => void,
  factory: SessionIdentityAdvisoryFactory | undefined = defaultFactory(),
): SessionIdentityAdvisory | null {
  if (factory === undefined) return null;

  let channel: SessionIdentityAdvisoryChannelLike;
  try {
    channel = factory(CHANNEL_NAME);
  } catch {
    return null;
  }
  let active = true;
  const receive = (event: MessageEventLike) => {
    if (!active) return;
    let targetUserId: string | null;
    try {
      targetUserId = parseTargetUserId(event.data);
    } catch {
      return;
    }
    if (targetUserId === null) return;
    try {
      onTargetUserId(targetUserId);
    } catch {
      // Advisory delivery cannot own or break the authoritative response path.
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
    publish: (targetUserId) => {
      if (!active || !isUUIDv7(targetUserId)) return;
      try {
        channel.postMessage({ version: MESSAGE_VERSION, targetUserId });
      } catch {
        // Response identity binding remains authoritative.
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

function parseTargetUserId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.version !== MESSAGE_VERSION ||
    typeof candidate.targetUserId !== "string" ||
    !isUUIDv7(candidate.targetUserId)
  ) {
    return null;
  }
  return candidate.targetUserId;
}

function defaultFactory(): SessionIdentityAdvisoryFactory | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  return (name) => new BroadcastChannel(name);
}
