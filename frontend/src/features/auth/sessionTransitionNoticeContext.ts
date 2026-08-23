import { createContext, useContext, useEffect, useState } from "react";

export interface SessionTransitionNotice {
  readonly id: number;
  readonly kind: "account-switched";
  readonly targetUserId: string;
}

export interface SessionTransitionNoticeContextValue {
  readonly pendingNotice: SessionTransitionNotice | undefined;
  readonly announceAccountSwitch: (
    previousUserId: string,
    nextUserId: string,
  ) => void;
  readonly consumeNotice: (noticeId: number) => void;
}

export const SessionTransitionNoticeContext =
  createContext<SessionTransitionNoticeContextValue | null>(null);

export function useAnnounceAccountSwitch(): (
  previousUserId: string,
  nextUserId: string,
) => void {
  return useSessionTransitionNoticeContext().announceAccountSwitch;
}

export function useAccountSwitchNotice(userId: string): boolean {
  const { consumeNotice, pendingNotice } = useSessionTransitionNoticeContext();
  const [claimedNotice, setClaimedNotice] = useState<SessionTransitionNotice>();

  useEffect(() => {
    if (pendingNotice === undefined || pendingNotice.targetUserId !== userId) {
      return;
    }
    const claimTimer = window.setTimeout(() => {
      setClaimedNotice(pendingNotice);
      consumeNotice(pendingNotice.id);
    }, 0);
    return () => window.clearTimeout(claimTimer);
  }, [consumeNotice, pendingNotice, userId]);

  return (
    claimedNotice?.kind === "account-switched" &&
    claimedNotice.targetUserId === userId
  );
}

function useSessionTransitionNoticeContext(): SessionTransitionNoticeContextValue {
  const value = useContext(SessionTransitionNoticeContext);
  if (value === null) {
    throw new Error(
      "session transition notices must be used within SessionTransitionNoticeProvider",
    );
  }
  return value;
}
