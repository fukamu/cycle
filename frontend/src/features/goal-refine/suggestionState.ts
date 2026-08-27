import type { AutoSaveState } from "../../shared/autosave/autoSaveCoordinator";

export function isGoalSuggestionStale(
  currentBody: string,
  sourceBody: string,
  saveState: AutoSaveState,
): boolean {
  return saveState.kind !== "saved" || currentBody !== sourceBody;
}
