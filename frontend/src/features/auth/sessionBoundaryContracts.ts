import type { Session } from "../../shared/api/schemas";
import type { SessionRecoveryEvent } from "../../shared/api/sessionRecoveryEvents";

export type RuntimeRecoveryState = {
  readonly event: SessionRecoveryEvent;
  readonly failed: boolean;
  readonly suspendChildren: boolean;
  readonly scopesQuiesced: boolean;
};

export type PublishSessionOptions = {
  readonly scopesAlreadyQuiesced: boolean;
  readonly remountSameIdentity: boolean;
  readonly isCurrent?: () => boolean;
};

export type PublishSession = (
  nextSession: Session,
  options: PublishSessionOptions,
) => Promise<boolean>;
