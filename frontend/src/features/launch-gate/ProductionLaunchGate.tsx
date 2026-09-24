import { useQuery } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

import {
  useAuthenticatedRequestLease,
  useSession,
} from "../auth/sessionContext";
import { getLaunchStatus } from "./api";

export function ProductionLaunchGate({ children }: PropsWithChildren) {
  const session = useSession();
  const lease = useAuthenticatedRequestLease();
  const query = useQuery({
    queryKey: ["production-launch-status", session.user.id],
    queryFn: () => getLaunchStatus(lease),
    retry: false,
    staleTime: 0,
  });

  if (query.isPending) {
    return (
      <main className="app-message" role="status" aria-live="polite">
        <p>アクセス状態を確認しています…</p>
      </main>
    );
  }
  if (query.isError) {
    return (
      <main className="app-message app-message--error" role="alert">
        <p>
          現在、アクセス状態を確認できません。しばらくしてから再度お試しください。
        </p>
        <button type="button" onClick={() => void query.refetch()}>
          再試行
        </button>
      </main>
    );
  }
  if (!query.data.canAccess) {
    return (
      <main className="app-message" role="status" aria-live="polite">
        <p>
          現在、このサービスは限定公開中です。一般公開までしばらくお待ちください。
        </p>
      </main>
    );
  }
  return children;
}
