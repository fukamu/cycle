import { isUUIDv7 } from "../../shared/id/uuid";

const CHANNEL_NAME = "fukamu-cycle-session-identity-v2";
const MESSAGE_VERSION = 2;

type AdvisoryWireMessage = {
  readonly version: typeof MESSAGE_VERSION;
  readonly targetUserId: string;
  readonly guidePreferencesReconciled: boolean;
};

export type SessionIdentityAdvisoryMessage = {
  readonly targetUserId: string;
  readonly guidePreferencesReconciled: boolean;
};

export type SessionIdentityAdvisoryPublishOptions = {
  readonly guidePreferencesReconciled?: boolean;
};

type MessageEventLike = {
  readonly data: unknown;
};

export type SessionIdentityAdvisoryChannelLike = {
  readonly postMessage: (message: AdvisoryWireMessage) => void;
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
  readonly publish: (
    targetUserId: string,
    options?: SessionIdentityAdvisoryPublishOptions,
  ) => void;
  readonly close: () => void;
};

export type PublishSessionIdentityAdvisory = SessionIdentityAdvisory["publish"];

export type SessionIdentityAdvisoryFactory = (
  name: string,
) => SessionIdentityAdvisoryChannelLike;

export function createSessionIdentityAdvisory(
  onAdvisory: (advisory: SessionIdentityAdvisoryMessage) => void,
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
    let advisory: SessionIdentityAdvisoryMessage | null;
    try {
      advisory = parseAdvisory(event.data);
    } catch {
      return;
    }
    if (advisory === null) return;
    try {
      onAdvisory(advisory);
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
    publish: (targetUserId, options = {}) => {
      if (!active || !isUUIDv7(targetUserId)) return;
      try {
        channel.postMessage({
          version: MESSAGE_VERSION,
          targetUserId,
          guidePreferencesReconciled:
            options.guidePreferencesReconciled === true,
        });
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

function parseAdvisory(value: unknown): SessionIdentityAdvisoryMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.version !== MESSAGE_VERSION ||
    typeof candidate.targetUserId !== "string" ||
    !isUUIDv7(candidate.targetUserId) ||
    typeof candidate.guidePreferencesReconciled !== "boolean"
  ) {
    return null;
  }
  return {
    targetUserId: candidate.targetUserId,
    guidePreferencesReconciled: candidate.guidePreferencesReconciled,
  };
}

function defaultFactory(): SessionIdentityAdvisoryFactory | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  return (name) => new BroadcastChannel(name);
}
