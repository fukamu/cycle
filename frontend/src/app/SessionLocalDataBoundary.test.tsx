import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { SessionContext } from "../features/auth/sessionContext";
import { userQueryKeys } from "../features/goal-collection/goalCache";
import type { Home } from "../shared/api/schemas";
import {
  getHomeServerSnapshot,
  putHomeServerSnapshot,
} from "../shared/drafts/browserDraftCache";
import { SessionLocalDataBoundary } from "./SessionLocalDataBoundary";
import { startupSnapshotTarget } from "./startupSnapshotTarget";

const userId = "00000000-0000-7000-8000-000000000301";

describe("SessionLocalDataBoundary", () => {
  it("shows an authenticated local snapshot while the server revalidation is still pending", async () => {
    const cached = homeFixture(
      "cached goal",
      "00000000-0000-7000-8000-000000000302",
    );
    const fresh = homeFixture(
      "fresh goal",
      "00000000-0000-7000-8000-000000000305",
    );
    await putHomeServerSnapshot(userId, cached);
    const network = deferred<Home>();
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={cache}>
        <SessionContext.Provider
          value={{
            user: { id: userId, googleConnected: false, googleEmail: null },
            csrfToken: "test-csrf",
          }}
        >
          <MemoryRouter initialEntries={["/"]}>
            <SessionLocalDataBoundary>
              <HomeProbe request={() => network.promise} />
            </SessionLocalDataBoundary>
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("cached goal")).toBeInTheDocument();

    network.resolve(fresh);
    expect(await screen.findByText("fresh goal")).toBeInTheDocument();
    await waitFor(async () => {
      expect((await getHomeServerSnapshot(userId))?.data).toEqual(fresh);
    });

    await cache.invalidateQueries({
      queryKey: userQueryKeys.home(userId),
      exact: true,
      refetchType: "none",
    });
    await waitFor(async () => {
      expect(await getHomeServerSnapshot(userId)).toBeNull();
    });
  });

  it.each([
    ["/", { kind: "home" }],
    ["/goals/new", { kind: "home" }],
    ["/goals/goal-a", { kind: "goal", goalId: "goal-a" }],
    [
      "/goals/goal-a/cycles/cycle-a",
      { kind: "cycle", goalId: "goal-a", cycleId: "cycle-a" },
    ],
    ["/goals/goal-a/review", { kind: "review", goalId: "goal-a" }],
    ["/history", { kind: "none" }],
  ])("selects the startup snapshot for %s", (pathname, expected) => {
    expect(startupSnapshotTarget(pathname)).toEqual(expected);
  });
});

function HomeProbe({ request }: { readonly request: () => Promise<Home> }) {
  const query = useQuery({
    queryKey: userQueryKeys.home(userId),
    queryFn: request,
  });
  return (
    <p>{query.data?.progressingGoals[0]?.currentVersion.body ?? "loading"}</p>
  );
}

function homeFixture(body: string, idBase: string): Home {
  const suffix = Number(idBase.slice(-1));
  const id = (offset: number) => `${idBase.slice(0, -1)}${suffix + offset}`;
  return {
    progressingGoals: [
      {
        id: id(0),
        status: "active_cycle",
        revision: 1,
        currentVersion: {
          id: id(1),
          versionNumber: 1,
          body,
          successSignal: "success signal",
          createdAt: "2026-09-21T00:00:00.000Z",
        },
        currentWork: {
          kind: "active_cycle",
          cycleId: id(2),
          cycleSequenceNumber: 1,
          reviewSchedule: {
            reviewDate: null,
            reviewScheduleRevision: 0,
          },
        },
        nextCycleSequenceNumber: 2,
        cycleCount: 1,
        createdAt: "2026-09-21T00:00:00.000Z",
        terminalAt: null,
      },
    ],
    creationDraft: null,
    canCreateGoalDraft: true,
    progressingGoalLimit: 5,
    canStartProgressingGoal: true,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
