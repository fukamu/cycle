import { describe, expect, it } from "vitest";

import type { Cycle, Goal } from "../../shared/api/schemas";
import {
  reconcileActiveCycleSchedule,
  resolvePreferredCycle,
} from "./cycleSnapshot";

const cycle: Cycle = {
  id: "40000000-0000-7000-8000-000000000001",
  goalId: "20000000-0000-7000-8000-000000000001",
  sequenceNumber: 1,
  status: "active",
  goalVersion: {
    id: "30000000-0000-7000-8000-000000000001",
    versionNumber: 1,
    body: "目標",
    successSignal: null,
  },
  previousCompletedCycleAction: null,
  reviewDate: null,
  reviewScheduleRevision: 0,
  startedAt: "2026-09-15T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  plan: "",
  do: "",
  check: "",
  action: "",
  contentRevision: 0,
  frameRevisions: { plan: 0, do: 0, check: 0, action: 0 },
};

const goal: Goal = {
  id: cycle.goalId ?? "",
  status: "active_cycle",
  revision: 0,
  currentVersion: { ...cycle.goalVersion, createdAt: cycle.startedAt },
  currentWork: {
    kind: "active_cycle",
    cycleId: cycle.id,
    cycleSequenceNumber: cycle.sequenceNumber,
    reviewSchedule: {
      reviewDate: cycle.reviewDate,
      reviewScheduleRevision: cycle.reviewScheduleRevision,
    },
  },
  nextCycleSequenceNumber: 2,
  cycleCount: 1,
  createdAt: cycle.startedAt,
  terminalAt: null,
};

describe("resolvePreferredCycle", () => {
  it.each([
    {
      label: "current content and incoming schedule",
      current: {
        ...cycle,
        plan: "newer current content",
        contentRevision: 2,
        reviewDate: "2026-09-20",
        reviewScheduleRevision: 1,
      },
      incoming: {
        ...cycle,
        plan: "older incoming content",
        contentRevision: 1,
        reviewDate: "2026-09-25",
        reviewScheduleRevision: 2,
      },
      expectedPlan: "newer current content",
      expectedDate: "2026-09-25",
    },
    {
      label: "incoming content and current schedule",
      current: {
        ...cycle,
        plan: "older current content",
        contentRevision: 1,
        reviewDate: "2026-09-25",
        reviewScheduleRevision: 2,
      },
      incoming: {
        ...cycle,
        plan: "newer incoming content",
        contentRevision: 2,
        reviewDate: "2026-09-20",
        reviewScheduleRevision: 1,
      },
      expectedPlan: "newer incoming content",
      expectedDate: "2026-09-25",
    },
  ])(
    "composes $label without regressing either independent revision",
    ({ current, incoming, expectedPlan, expectedDate }) => {
      expect(resolvePreferredCycle(current, incoming)).toMatchObject({
        kind: "accept",
        cycle: {
          plan: expectedPlan,
          contentRevision: 2,
          reviewDate: expectedDate,
          reviewScheduleRevision: 2,
        },
      });
    },
  );

  it("fails closed on an equal schedule revision disagreement", () => {
    expect(
      resolvePreferredCycle(
        {
          ...cycle,
          reviewDate: "2026-09-25",
          reviewScheduleRevision: 2,
        },
        {
          ...cycle,
          plan: "newer incoming content",
          contentRevision: 1,
          reviewDate: "2026-09-26",
          reviewScheduleRevision: 2,
        },
      ),
    ).toEqual({ kind: "invariant" });
  });

  it.each([
    {
      label: "Cycle id",
      current: {
        ...cycle,
        id: "40000000-0000-7000-8000-000000000099",
      },
    },
    {
      label: "Goal ownership",
      current: {
        ...cycle,
        goalId: "20000000-0000-7000-8000-000000000099",
      },
    },
  ])("fails closed on a mismatched cached $label", ({ current }) => {
    expect(resolvePreferredCycle(current, cycle)).toEqual({
      kind: "invariant",
    });
  });

  it.each([
    {
      label: "current terminal snapshot from a late active response",
      current: {
        ...cycle,
        status: "completed" as const,
        completedAt: "2026-09-16T00:00:00.000Z",
        reviewDate: "2026-09-20",
        reviewScheduleRevision: 1,
      },
      incoming: {
        ...cycle,
        reviewDate: "2026-09-25",
        reviewScheduleRevision: 2,
      },
      expected: "current",
    },
    {
      label: "incoming terminal snapshot from a cached active response",
      current: {
        ...cycle,
        reviewDate: "2026-09-25",
        reviewScheduleRevision: 2,
      },
      incoming: {
        ...cycle,
        status: "completed" as const,
        completedAt: "2026-09-16T00:00:00.000Z",
        reviewDate: "2026-09-20",
        reviewScheduleRevision: 1,
      },
      expected: "incoming",
    },
  ])("keeps the $label whole", ({ current, incoming, expected }) => {
    expect(resolvePreferredCycle(current, incoming)).toEqual({
      kind: "accept",
      cycle: expected === "current" ? current : incoming,
    });
  });

  it.each([
    {
      label: "date",
      incoming: {
        reviewDate: "2026-09-21",
        reviewScheduleRevision: 1,
      },
    },
    {
      label: "revision",
      incoming: {
        reviewDate: "2026-09-20",
        reviewScheduleRevision: 2,
      },
    },
  ])(
    "fails closed when same-status terminal snapshots disagree on schedule $label",
    ({ incoming }) => {
      const terminal: Cycle = {
        ...cycle,
        status: "completed",
        completedAt: "2026-09-16T00:00:00.000Z",
        reviewDate: "2026-09-20",
        reviewScheduleRevision: 1,
        contentRevision: 2,
      };

      expect(
        resolvePreferredCycle(terminal, {
          ...terminal,
          ...incoming,
          contentRevision: 1,
        }),
      ).toEqual({ kind: "invariant" });
    },
  );
});

describe("reconcileActiveCycleSchedule", () => {
  it("rejects a late active Cycle after the Goal becomes terminal", () => {
    expect(
      reconcileActiveCycleSchedule(
        {
          ...goal,
          status: "ended",
          currentWork: null,
          terminalAt: "2026-09-16T00:00:00.000Z",
        },
        cycle,
      ),
    ).toEqual({ kind: "invariant" });
  });

  it("rejects a late old active Cycle after the Goal moves to another Cycle", () => {
    expect(
      reconcileActiveCycleSchedule(
        {
          ...goal,
          currentWork: {
            kind: "active_cycle",
            cycleId: "40000000-0000-7000-8000-000000000002",
            cycleSequenceNumber: 2,
            reviewSchedule: {
              reviewDate: null,
              reviewScheduleRevision: 0,
            },
          },
          nextCycleSequenceNumber: 3,
          cycleCount: 2,
        },
        cycle,
      ),
    ).toEqual({ kind: "invariant" });
  });
});
