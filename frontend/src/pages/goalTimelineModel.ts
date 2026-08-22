import type {
  CyclePage,
  CycleSummary,
  GoalVersion,
} from "../shared/api/schemas";

export type TimelineVersionKind = "baseline" | "revision";

export type TimelineVersionGroup = {
  readonly version: GoalVersion;
  readonly kind: TimelineVersionKind;
  readonly cycles: readonly CycleSummary[];
};

type MutableTimelineVersionGroup = {
  readonly version: GoalVersion;
  readonly cycles: Map<string, CycleSummary>;
};

export function buildTimelineGroups(
  pages: readonly CyclePage[],
  currentVersion: GoalVersion,
): TimelineVersionGroup[] {
  const byVersion = new Map<string, MutableTimelineVersionGroup>();
  for (const page of pages) {
    for (const cycle of page.items) {
      let group = byVersion.get(cycle.goalVersion.id);
      if (!group) {
        group = {
          version: cycle.goalVersion,
          cycles: new Map<string, CycleSummary>(),
        };
        byVersion.set(cycle.goalVersion.id, group);
      }
      group.cycles.set(cycle.id, cycle);
    }
  }

  if (byVersion.size === 0) {
    return [
      {
        version: currentVersion,
        kind: versionKind(currentVersion),
        cycles: [],
      },
    ];
  }

  return [...byVersion.values()]
    .sort((a, b) => b.version.versionNumber - a.version.versionNumber)
    .map((group) => ({
      version: group.version,
      kind: versionKind(group.version),
      cycles: [...group.cycles.values()].sort(
        (a, b) => b.sequenceNumber - a.sequenceNumber,
      ),
    }));
}

function versionKind(version: GoalVersion): TimelineVersionKind {
  return version.versionNumber === 1 ? "baseline" : "revision";
}
