import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import {
  SessionTransitionNoticeContext,
  type SessionTransitionNotice,
} from "./sessionTransitionNoticeContext";

export function SessionTransitionNoticeProvider({
  children,
}: PropsWithChildren) {
  const nextNoticeId = useRef(1);
  const [pendingNotice, setPendingNotice] = useState<SessionTransitionNotice>();

  const announceAccountSwitch = useCallback(
    (previousUserId: string, nextUserId: string) => {
      if (previousUserId === nextUserId) return;
      setPendingNotice({
        id: nextNoticeId.current,
        kind: "account-switched",
        targetUserId: nextUserId,
      });
      nextNoticeId.current += 1;
    },
    [],
  );
  const consumeNotice = useCallback((noticeId: number) => {
    setPendingNotice((current) =>
      current?.id === noticeId ? undefined : current,
    );
  }, []);
  const value = useMemo(
    () => ({ pendingNotice, announceAccountSwitch, consumeNotice }),
    [announceAccountSwitch, consumeNotice, pendingNotice],
  );

  return (
    <SessionTransitionNoticeContext.Provider value={value}>
      {children}
    </SessionTransitionNoticeContext.Provider>
  );
}
