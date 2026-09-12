const firstUseGuidePreferencePrefix = "fukamu-cycle-first-use-guide-v1:";

export const firstUseGuideStages = [
  "goal",
  "plan",
  "do",
  "check",
  "action",
  "review",
] as const;

export type FirstUseGuideStage = (typeof firstUseGuideStages)[number];

export type FirstUseGuidePreferenceStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type FirstUseGuidePreferences = {
  readonly eligible: boolean;
  readonly skipped: boolean;
  readonly shown: Readonly<Record<FirstUseGuideStage, boolean>>;
};

export type FirstUseGuideActivationOutcome = {
  readonly sharedSafe: boolean;
};

const eligibleKey = `${firstUseGuidePreferencePrefix}eligible`;
const skippedKey = `${firstUseGuidePreferencePrefix}skipped`;
const shownKeys: Readonly<Record<FirstUseGuideStage, string>> = {
  goal: `${firstUseGuidePreferencePrefix}shown-goal`,
  plan: `${firstUseGuidePreferencePrefix}shown-plan`,
  do: `${firstUseGuidePreferencePrefix}shown-do`,
  check: `${firstUseGuidePreferencePrefix}shown-check`,
  action: `${firstUseGuidePreferencePrefix}shown-action`,
  review: `${firstUseGuidePreferencePrefix}shown-review`,
};
const allPreferenceKeys = [
  eligibleKey,
  skippedKey,
  ...firstUseGuideStages.map((stage) => shownKeys[stage]),
] as const;

// This fence intentionally outlives React Provider remounts while remaining
// limited to the current document. Identity/bootstrap/delete transitions call
// clearFirstUseGuidePreferences, which resets it together with persistent keys.
const documentFirstUseGuideState = {
  skipped: false,
  shown: new Set<FirstUseGuideStage>(),
  preferencesBaseline: undefined as FirstUseGuidePreferences | undefined,
};

function resetDocumentFirstUseGuideState(
  preferencesBaseline: FirstUseGuidePreferences | undefined,
): void {
  documentFirstUseGuideState.skipped = false;
  documentFirstUseGuideState.shown.clear();
  documentFirstUseGuideState.preferencesBaseline = preferencesBaseline;
}

const emptyFirstUseGuidePreferences = (): FirstUseGuidePreferences => ({
  eligible: false,
  skipped: false,
  shown: Object.fromEntries(
    firstUseGuideStages.map((stage) => [stage, false]),
  ) as Record<FirstUseGuideStage, boolean>,
});

function getStorage(
  storage?: FirstUseGuidePreferenceStorage,
): FirstUseGuidePreferenceStorage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

function writeTrue(
  key: string,
  storage?: FirstUseGuidePreferenceStorage,
): boolean {
  try {
    const target = getStorage(storage);
    if (!target) return false;
    target.setItem(key, "true");
    return true;
  } catch {
    return false;
  }
}

export function readFirstUseGuidePreferences(
  storage?: FirstUseGuidePreferenceStorage,
): FirstUseGuidePreferences {
  try {
    const target = getStorage(storage);
    if (!target) return emptyFirstUseGuidePreferences();
    const eligible = target.getItem(eligibleKey);
    const skipped = target.getItem(skippedKey);
    const shown = Object.fromEntries(
      firstUseGuideStages.map((stage) => [
        stage,
        target.getItem(shownKeys[stage]),
      ]),
    ) as Record<FirstUseGuideStage, string | null>;
    const snapshotValues = [eligible, skipped, ...Object.values(shown)];
    if (snapshotValues.some((value) => value !== null && value !== "true")) {
      return emptyFirstUseGuidePreferences();
    }
    return {
      eligible: eligible === "true",
      skipped: skipped === "true",
      shown: Object.fromEntries(
        firstUseGuideStages.map((stage) => [stage, shown[stage] === "true"]),
      ) as Record<FirstUseGuideStage, boolean>,
    };
  } catch {
    return emptyFirstUseGuidePreferences();
  }
}

export function activateFirstUseGuide(
  storage?: FirstUseGuidePreferenceStorage,
): FirstUseGuideActivationOutcome {
  const cleanup = clearPersistentFirstUseGuidePreferences(storage);
  if (!cleanup.cleared) return { sharedSafe: cleanup.sharedSafe };
  writeTrue(eligibleKey, storage);
  resetDocumentFirstUseGuideState(readFirstUseGuidePreferences(storage));
  return { sharedSafe: true };
}

export function bindFirstUseGuidePreferencesToCurrentSession(
  storage?: FirstUseGuidePreferenceStorage,
): void {
  resetDocumentFirstUseGuideState(readFirstUseGuidePreferences(storage));
}

export function adoptReconciledFirstUseGuidePreferences(
  storage?: FirstUseGuidePreferenceStorage,
): void {
  // The authoritative cookie writer has already established the shared
  // persistent state. Drop only this tab's previous identity fence so the new
  // identity reads that state without rewriting it.
  resetDocumentFirstUseGuideState(readFirstUseGuidePreferences(storage));
}

export function suppressFirstUseGuideUntilReconciliation(): void {
  documentFirstUseGuideState.skipped = true;
}

export function shouldShowFirstUseGuideStage(
  stage: FirstUseGuideStage,
  storage?: FirstUseGuidePreferenceStorage,
): boolean {
  const preferences =
    documentFirstUseGuideState.preferencesBaseline ??
    readFirstUseGuidePreferences(storage);
  if (
    !preferences.eligible ||
    preferences.skipped ||
    preferences.shown[stage] ||
    documentFirstUseGuideState.skipped ||
    documentFirstUseGuideState.shown.has(stage)
  ) {
    return false;
  }

  return true;
}

export function markFirstUseGuideStageShown(
  stage: FirstUseGuideStage,
  storage?: FirstUseGuidePreferenceStorage,
): void {
  markFirstUseGuideStageShownInDocument(stage);
  persistFirstUseGuideStageShown(stage, storage);
}

export function markFirstUseGuideStageShownInDocument(
  stage: FirstUseGuideStage,
): void {
  documentFirstUseGuideState.shown.add(stage);
}

export function persistFirstUseGuideStageShown(
  stage: FirstUseGuideStage,
  storage?: FirstUseGuidePreferenceStorage,
): void {
  writeTrue(shownKeys[stage], storage);
}

export function skipFirstUseGuide(
  storage?: FirstUseGuidePreferenceStorage,
): void {
  if (skipFirstUseGuideInDocument()) {
    persistFirstUseGuideSkipped(storage);
  }
}

export function skipFirstUseGuideInDocument(): boolean {
  const firstDocumentSkip = !documentFirstUseGuideState.skipped;
  documentFirstUseGuideState.skipped = true;
  return firstDocumentSkip;
}

export function persistFirstUseGuideSkipped(
  storage?: FirstUseGuidePreferenceStorage,
): void {
  writeTrue(skippedKey, storage);
}

export function clearFirstUseGuidePreferences(
  storage?: FirstUseGuidePreferenceStorage,
): void {
  clearPersistentFirstUseGuidePreferences(storage);
}

function clearPersistentFirstUseGuidePreferences(
  storage?: FirstUseGuidePreferenceStorage,
): { readonly cleared: boolean; readonly sharedSafe: boolean } {
  let target: FirstUseGuidePreferenceStorage | undefined;
  try {
    target = getStorage(storage);
  } catch {
    documentFirstUseGuideState.skipped = true;
    documentFirstUseGuideState.preferencesBaseline =
      emptyFirstUseGuidePreferences();
    return { cleared: false, sharedSafe: false };
  }
  if (!target) {
    documentFirstUseGuideState.skipped = true;
    documentFirstUseGuideState.preferencesBaseline =
      emptyFirstUseGuidePreferences();
    return { cleared: false, sharedSafe: false };
  }

  let clearedAll = true;
  for (const key of allPreferenceKeys) {
    try {
      target.removeItem(key);
    } catch {
      clearedAll = false;
      // Continue clearing fixed guide keys when an individual removal fails.
    }
  }

  if (clearedAll) {
    resetDocumentFirstUseGuideState(emptyFirstUseGuidePreferences());
    return { cleared: true, sharedSafe: true };
  }

  // A surviving eligible marker must never expose the previous identity's
  // guide state to the next user. Keep this document fail-closed and make the
  // same suppression visible to sibling tabs when storage still accepts it.
  documentFirstUseGuideState.skipped = true;
  documentFirstUseGuideState.preferencesBaseline =
    emptyFirstUseGuidePreferences();
  return {
    cleared: false,
    sharedSafe: writeTrue(skippedKey, target),
  };
}
