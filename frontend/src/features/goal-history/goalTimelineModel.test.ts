import type {
  CyclePage,
  CycleSummary,
  GoalVersion,
} from "../../shared/api/schemas";

import { buildTimelineGroups } from "./goalTimelineModel";

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

function makeVersion(versionNumber: number): GoalVersion {
  return {
    id: `20000000-0000-7000-8000-${String(versionNumber).padStart(12, "0")}`,
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
    id: `30000000-0000-7000-8000-${String(sequenceNumber).padStart(12, "0")}`,
    sequenceNumber,
    status: "completed",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-02T00:00:00.000Z",
    canceledAt: null,
    goalVersion: makeVersion(versionNumber),
    planPreview: `Cycle ${sequenceNumber}の計画`,
  };
}
