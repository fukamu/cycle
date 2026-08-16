import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useSession } from "../features/auth/sessionContext";
import { AIProcessingProvider } from "../features/ai/AIProcessingProvider";
import { CycleEditor } from "../features/cycle-editor/components/CycleEditor";
import {
  listCycleDrafts,
  type DraftRecord,
} from "../features/cycle-editor/draft/draftRepository";
import { getActiveCycle } from "../shared/api/cycles";

type LoadedDrafts = {
  readonly cycleId: string;
  readonly items: readonly DraftRecord[];
};

export function HomePage() {
  const session = useSession();
  const query = useQuery({
    queryKey: ["active-cycle"],
    queryFn: ({ signal }) => getActiveCycle(signal),
  });
  const [drafts, setDrafts] = useState<LoadedDrafts | null>(null);

  useEffect(() => {
    if (query.data === undefined) return;
    let active = true;
    void listCycleDrafts(session.user.id, query.data.cycle.id).then((items) => {
      if (active) setDrafts({ cycleId: query.data.cycle.id, items });
    });
    return () => {
      active = false;
    };
  }, [query.data, session.user.id]);

  if (query.isError) {
    return (
      <div className="app-message app-message--error" role="alert">
        <p>現在のサイクルを読み込めませんでした。</p>
        <button type="button" onClick={() => void query.refetch()}>
          再試行
        </button>
      </div>
    );
  }
  if (
    query.isPending ||
    query.data === undefined ||
    drafts?.cycleId !== query.data.cycle.id
  ) {
    return <div className="app-message">サイクルを読み込んでいます…</div>;
  }
  return (
    <AIProcessingProvider
      key={query.data.cycle.id}
      cycleId={query.data.cycle.id}
      csrfToken={session.csrfToken}
    >
      <CycleEditor
        cycle={query.data.cycle}
        userId={session.user.id}
        csrfToken={session.csrfToken}
        drafts={drafts.items}
      />
    </AIProcessingProvider>
  );
}
