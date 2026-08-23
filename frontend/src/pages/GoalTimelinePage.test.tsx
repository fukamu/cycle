import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthenticatedSessionTestProvider } from "../test/AuthenticatedSessionTestProvider";
import { createCurrentAuthenticatedRequestLease } from "../test/authenticatedRequestLease";
import type {
  CyclePage,
  CycleSummary,
  Goal,
  GoalVersion,
  Session,
} from "../shared/api/schemas";
import { getGoal, listCycles } from "../shared/api/workspace";
import { GoalTimelinePage } from "./GoalTimelinePage";
import { buildTimelineGroups } from "./goalTimelineModel";

vi.mock("../shared/api/workspace", () => ({
  getGoal: vi.fn(),
  listCycles: vi.fn(),
}));

const goalId = "10000000-0000-7000-8000-000000000001";
const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

const sessionLease = createCurrentAuthenticatedRequestLease(session.user.id);

let notifyIntersection: IntersectionObserverCallback;

describe("GoalTimelinePage", () => {
  beforeEach(() => {
    vi.mocked(getGoal).mockReset();
    vi.mocked(listCycles).mockReset();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        readonly root = null;
        readonly rootMargin = "240px";
        readonly thresholds = [0];

        constructor(callback: IntersectionObserverCallback) {
          notifyIntersection = callback;
        }

        disconnect() {}
        observe() {}
        takeRecords() {
          return [];
        }
        unobserve() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps newest cycles first while grouping V3, V2, and V1 segments", () => {
    const pages: CyclePage[] = [
      {
        items: [
          makeCycle(6, 3),
          makeCycle(5, 3),
          makeCycle(4, 2),
          makeCycle(3, 2),
          makeCycle(2, 1),
          makeCycle(1, 1),
        ],
        nextCursor: null,
      },
    ];

    const groups = buildTimelineGroups(pages, makeVersion(3));

    expect(
      groups.map((group) => ({
        version: group.version.versionNumber,
        kind: group.kind,
        cycles: group.cycles.map((cycle) => cycle.sequenceNumber),
      })),
    ).toEqual([
      { version: 3, kind: "revision", cycles: [6, 5] },
      { version: 2, kind: "revision", cycles: [4, 3] },
      { version: 1, kind: "baseline", cycles: [2, 1] },
    ]);
  });

  it("marks V2 as a revision when it is the first loaded segment", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(2) });
    vi.mocked(listCycles).mockResolvedValue({
      items: [makeCycle(4, 2)],
      nextCursor: null,
    });

    const { container } = renderTimeline();

    await screen.findByText("GOAL V2");
    const version = getVersion(container, 2);
    const event = getEvent(container, 2);
    expect(version).toHaveAttribute("data-version-kind", "revision");
    expect(version).toHaveAttribute("data-version-state", "current");
    expect(
      within(version).queryByText("目標を変更しました"),
    ).not.toBeInTheDocument();
    expect(within(event).getByText("目標を変更しました")).toBeVisible();
    expect(event).toHaveAttribute("data-timeline-event", "change");
    expect(event).toHaveAttribute("data-version-state", "current");
    expect(version.nextElementSibling).toBe(event);
    expect(event.querySelector(".timeline-event__marker")).toBeInTheDocument();
    expect(version.querySelector(".timeline-period__rail")).toBeInTheDocument();
    expect(screen.queryByText("GOAL V1")).not.toBeInTheDocument();
    expect(getGoal).toHaveBeenCalledWith(
      sessionLease,
      goalId,
      expect.any(AbortSignal),
    );
    expect(listCycles).toHaveBeenCalledWith(
      sessionLease,
      goalId,
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("marks the V1 period and creation event as current before any revision", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(1) });
    vi.mocked(listCycles).mockResolvedValue({
      items: [makeCycle(1, 1)],
      nextCursor: null,
    });

    const { container } = renderTimeline();

    await screen.findByRole("heading", {
      level: 2,
      name: "Version 1の目標",
    });
    expect(getVersion(container, 1)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    expect(getEvent(container, 1)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    expect(getEvent(container, 1)).toHaveAttribute(
      "data-timeline-event",
      "created",
    );
  });

  it("keeps V3 marked and merges version groups across older pages", async () => {
    vi.mocked(getGoal).mockResolvedValue({ goal: makeGoal(3) });
    vi.mocked(listCycles)
      .mockResolvedValueOnce({
        items: [makeCycle(6, 3)],
        nextCursor: "older-1",
      })
      .mockResolvedValueOnce({
        items: [makeCycle(5, 3), makeCycle(4, 2)],
        nextCursor: "older-2",
      })
      .mockResolvedValueOnce({
        items: [makeCycle(3, 2), makeCycle(2, 1), makeCycle(1, 1)],
        nextCursor: null,
      });

    const { container } = renderTimeline();

    await screen.findByText("GOAL V3");
    expect(getVersion(container, 3)).toHaveAttribute(
      "data-version-kind",
      "revision",
    );
    expect(
      container.querySelectorAll('[data-version-number="3"]'),
    ).toHaveLength(1);

    triggerIntersection();
    await screen.findByText("GOAL V2");
    await waitFor(() => expect(listCycles).toHaveBeenCalledTimes(2));
    expect(listCycles).toHaveBeenNthCalledWith(
      2,
      sessionLease,
      goalId,
      "older-1",
      expect.any(AbortSignal),
    );
    expect(
      container.querySelectorAll('[data-version-number="3"]'),
    ).toHaveLength(1);
    const v3 = getVersion(container, 3);
    expect(within(v3).getByRole("link", { name: /Cycle 5/ })).toBeVisible();
    expect(within(v3).getByRole("link", { name: /Cycle 6/ })).toBeVisible();

    triggerIntersection();
    await screen.findByRole("heading", { name: "Version 1の目標" });
    await waitFor(() => expect(listCycles).toHaveBeenCalledTimes(3));
    expect(listCycles).toHaveBeenNthCalledWith(
      3,
      sessionLease,
      goalId,
      "older-2",
      expect.any(AbortSignal),
    );

    const versions = [
      ...container.querySelectorAll<HTMLElement>("[data-version-number]"),
    ];
    expect(versions.map((version) => version.dataset.versionNumber)).toEqual([
      "3",
      "2",
      "1",
    ]);
    expect(versions.map((version) => version.dataset.versionKind)).toEqual([
      "revision",
      "revision",
      "baseline",
    ]);
    const entries = [
      ...container.querySelectorAll<HTMLElement>(".timeline > li"),
    ].map((entry) =>
      entry.dataset.timelineEntry === "period"
        ? `period-${entry.dataset.versionNumber}`
        : `${entry.dataset.timelineEvent}-${entry.dataset.eventVersion}`,
    );
    expect(entries).toEqual([
      "period-3",
      "change-3",
      "period-2",
      "change-2",
      "period-1",
      "created-1",
    ]);
    expect(screen.getAllByText("目標を変更しました")).toHaveLength(2);
    expect(
      within(getEvent(container, 3)).getByText("Cycle 4の終了後"),
    ).toBeVisible();
    expect(
      within(getEvent(container, 2)).getByText("Cycle 2の終了後"),
    ).toBeVisible();
    expect(
      within(getEvent(container, 1)).getByText("目標を設定しました"),
    ).toBeVisible();
    expect(getVersion(container, 3)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    expect(getEvent(container, 3)).toHaveAttribute(
      "data-version-state",
      "current",
    );
    for (const versionNumber of [1, 2]) {
      expect(getVersion(container, versionNumber)).toHaveAttribute(
        "data-version-state",
        "past",
      );
      expect(getEvent(container, versionNumber)).toHaveAttribute(
        "data-version-state",
        "past",
      );
    }
    for (const version of versions)
      expect(
        within(version).queryByText("目標を変更しました"),
      ).not.toBeInTheDocument();
    expect(
      within(getVersion(container, 2)).getByRole("link", { name: /Cycle 3/ }),
    ).toBeVisible();
    expect(
      within(getVersion(container, 2)).getByRole("link", { name: /Cycle 4/ }),
    ).toBeVisible();
  });
});

function renderTimeline() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={cache}>
      <AuthenticatedSessionTestProvider lease={sessionLease} session={session}>
        <MemoryRouter initialEntries={[`/history/goals/${goalId}`]}>
          <Routes>
            <Route
              path="/history/goals/:goalId"
              element={<GoalTimelinePage />}
            />
          </Routes>
        </MemoryRouter>
      </AuthenticatedSessionTestProvider>
    </QueryClientProvider>,
  );
}

function triggerIntersection() {
  act(() => {
    notifyIntersection(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function getVersion(container: HTMLElement, versionNumber: number) {
  const version = container.querySelector<HTMLElement>(
    `[data-version-number="${versionNumber}"]`,
  );
  expect(version).not.toBeNull();
  return version!;
}

function getEvent(container: HTMLElement, versionNumber: number) {
  const event = container.querySelector<HTMLElement>(
    `[data-event-version="${versionNumber}"]`,
  );
  expect(event).not.toBeNull();
  return event!;
}

function makeGoal(versionNumber: number): Goal {
  return {
    id: goalId,
    status: "active_cycle",
    revision: versionNumber - 1,
    currentVersion: makeVersion(versionNumber),
    currentWork: {
      kind: "active_cycle",
      cycleId: cycleId(versionNumber * 2),
      cycleSequenceNumber: versionNumber * 2,
    },
    nextCycleSequenceNumber: versionNumber * 2 + 1,
    cycleCount: versionNumber * 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    terminalAt: null,
  };
}

function makeVersion(versionNumber: number): GoalVersion {
  return {
    id: versionId(versionNumber),
    versionNumber,
    body: `Version ${versionNumber}の目標`,
    createdAt: `2026-08-${String(versionNumber).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function makeCycle(
  sequenceNumber: number,
  versionNumber: number,
): CycleSummary {
  return {
    id: cycleId(sequenceNumber),
    sequenceNumber,
    status: "completed",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-02T00:00:00.000Z",
    canceledAt: null,
    goalVersion: makeVersion(versionNumber),
    planPreview: `Cycle ${sequenceNumber}の計画`,
  };
}

function versionId(versionNumber: number) {
  return `20000000-0000-7000-8000-${String(versionNumber).padStart(12, "0")}`;
}

function cycleId(sequenceNumber: number) {
  return `30000000-0000-7000-8000-${String(sequenceNumber).padStart(12, "0")}`;
}
