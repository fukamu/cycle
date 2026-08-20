import type { SimpleSaveState } from "../../shared/hooks/useDraftAutoSave";

export function isGoalSuggestionStale(
  currentBody: string,
  sourceBody: string,
  saveState: SimpleSaveState,
): boolean {
  return saveState !== "saved" || currentBody !== sourceBody;
}
