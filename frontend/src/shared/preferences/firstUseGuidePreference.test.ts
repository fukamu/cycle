import {
  activateFirstUseGuide,
  adoptReconciledFirstUseGuidePreferences,
  bindFirstUseGuidePreferencesToCurrentSession,
  clearFirstUseGuidePreferences,
  firstUseGuideStages,
  markFirstUseGuideStageShown,
  readFirstUseGuidePreferences,
  shouldShowFirstUseGuideStage,
  skipFirstUseGuide,
  type FirstUseGuidePreferenceStorage,
} from "./firstUseGuidePreference";

function createStorage(initial: Readonly<Record<string, string>> = {}): {
  readonly storage: FirstUseGuidePreferenceStorage;
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    },
  };
}

describe("first-use guide preferences", () => {
  it("uses only fixed versioned keys whose stored value is the true boolean literal", () => {
    const { storage, values } = createStorage();

    activateFirstUseGuide(storage);
    for (const stage of firstUseGuideStages) {
      expect(shouldShowFirstUseGuideStage(stage, storage)).toBe(true);
      markFirstUseGuideStageShown(stage, storage);
    }
    skipFirstUseGuide(storage);

    expect([...values]).toEqual([
      ["fukamu-cycle-first-use-guide-v1:eligible", "true"],
      ["fukamu-cycle-first-use-guide-v1:shown-goal", "true"],
      ["fukamu-cycle-first-use-guide-v1:shown-plan", "true"],
      ["fukamu-cycle-first-use-guide-v1:shown-do", "true"],
      ["fukamu-cycle-first-use-guide-v1:shown-check", "true"],
      ["fukamu-cycle-first-use-guide-v1:shown-action", "true"],
      ["fukamu-cycle-first-use-guide-v1:shown-review", "true"],
      ["fukamu-cycle-first-use-guide-v1:skipped", "true"],
    ]);
  });

  it("claims a stage only for an eligible, unskipped, previously unseen guide", () => {
    const { storage } = createStorage();

    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
    activateFirstUseGuide(storage);
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(true);
    markFirstUseGuideStageShown("goal", storage);
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
    expect(shouldShowFirstUseGuideStage("plan", storage)).toBe(true);
    skipFirstUseGuide(storage);
    expect(shouldShowFirstUseGuideStage("do", storage)).toBe(false);
  });

  it("keeps the bound identity's complete boolean snapshot until an authoritative adoption", () => {
    const { storage, values } = createStorage({
      "fukamu-cycle-first-use-guide-v1:eligible": "true",
      "fukamu-cycle-first-use-guide-v1:skipped": "true",
      "fukamu-cycle-first-use-guide-v1:shown-goal": "true",
    });
    bindFirstUseGuidePreferencesToCurrentSession(storage);

    values.delete("fukamu-cycle-first-use-guide-v1:skipped");
    values.delete("fukamu-cycle-first-use-guide-v1:shown-goal");

    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
    expect(shouldShowFirstUseGuideStage("plan", storage)).toBe(false);

    adoptReconciledFirstUseGuidePreferences(storage);

    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(true);
    expect(shouldShowFirstUseGuideStage("plan", storage)).toBe(true);
  });

  it("starts a fresh anonymous guide by resetting prior completion and skip booleans", () => {
    const { storage } = createStorage();
    activateFirstUseGuide(storage);
    markFirstUseGuideStageShown("goal", storage);
    markFirstUseGuideStageShown("plan", storage);
    skipFirstUseGuide(storage);

    activateFirstUseGuide(storage);

    expect(readFirstUseGuidePreferences(storage)).toEqual({
      eligible: true,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
  });

  it("treats absent and malformed values as false", () => {
    const { storage } = createStorage({
      "fukamu-cycle-first-use-guide-v1:eligible": "1",
      "fukamu-cycle-first-use-guide-v1:skipped": "false",
      "fukamu-cycle-first-use-guide-v1:shown-goal": "{",
    });

    expect(readFirstUseGuidePreferences(storage)).toEqual({
      eligible: false,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
  });

  it("fails the whole snapshot closed when a later key read throws after eligible succeeds", () => {
    const { storage, values } = createStorage({
      "fukamu-cycle-first-use-guide-v1:eligible": "true",
    });
    const getItem = storage.getItem as ReturnType<typeof vi.fn>;
    getItem.mockImplementation((key: string) => {
      if (key.endsWith(":skipped")) throw new Error("partial read failure");
      return values.get(key) ?? null;
    });

    expect(readFirstUseGuidePreferences(storage)).toEqual({
      eligible: false,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
    bindFirstUseGuidePreferencesToCurrentSession(storage);
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
  });

  it("fails the whole snapshot closed when a later key is a non-literal boolean", () => {
    const { storage } = createStorage({
      "fukamu-cycle-first-use-guide-v1:eligible": "true",
      "fukamu-cycle-first-use-guide-v1:shown-plan": "false",
    });

    expect(readFirstUseGuidePreferences(storage)).toEqual({
      eligible: false,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
    bindFirstUseGuidePreferencesToCurrentSession(storage);
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
  });

  it("clears only the fixed guide keys", () => {
    const { storage, values } = createStorage({
      unrelated: "keep",
      "fukamu-cycle-first-use-guide-v0:eligible": "true",
      "fukamu-cycle-first-use-guide-v1:unknown": "true",
    });
    activateFirstUseGuide(storage);
    markFirstUseGuideStageShown("review", storage);
    skipFirstUseGuide(storage);

    clearFirstUseGuidePreferences(storage);

    expect(values).toEqual(
      new Map([
        ["unrelated", "keep"],
        ["fukamu-cycle-first-use-guide-v0:eligible", "true"],
        ["fukamu-cycle-first-use-guide-v1:unknown", "true"],
      ]),
    );
  });

  it("never interrupts the caller when browser storage is unavailable", () => {
    const unavailable: FirstUseGuidePreferenceStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    expect(readFirstUseGuidePreferences(unavailable).eligible).toBe(false);
    expect(shouldShowFirstUseGuideStage("goal", unavailable)).toBe(false);
    expect(() => activateFirstUseGuide(unavailable)).not.toThrow();
    expect(() =>
      markFirstUseGuideStageShown("goal", unavailable),
    ).not.toThrow();
    expect(() => skipFirstUseGuide(unavailable)).not.toThrow();
    expect(() => clearFirstUseGuidePreferences(unavailable)).not.toThrow();
  });

  it("continues clearing after an individual removal fails", () => {
    const { storage, values } = createStorage();
    activateFirstUseGuide(storage);
    markFirstUseGuideStageShown("plan", storage);
    markFirstUseGuideStageShown("do", storage);
    const removeItem = storage.removeItem as ReturnType<typeof vi.fn>;
    removeItem.mockImplementation((key: string) => {
      if (key.endsWith("shown-plan")) throw new Error("blocked once");
      values.delete(key);
    });

    expect(() => clearFirstUseGuidePreferences(storage)).not.toThrow();
    expect(values).toEqual(
      new Map([
        ["fukamu-cycle-first-use-guide-v1:shown-plan", "true"],
        ["fukamu-cycle-first-use-guide-v1:skipped", "true"],
      ]),
    );
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
  });

  it("fails closed when the eligible marker cannot be removed", () => {
    const { storage, values } = createStorage();
    activateFirstUseGuide(storage);
    const removeItem = storage.removeItem as ReturnType<typeof vi.fn>;
    removeItem.mockImplementation((key: string) => {
      if (key.endsWith(":eligible")) throw new Error("eligible is locked");
      values.delete(key);
    });

    clearFirstUseGuidePreferences(storage);

    expect(readFirstUseGuidePreferences(storage)).toEqual({
      eligible: true,
      skipped: true,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);

    activateFirstUseGuide(storage);

    expect(values.get("fukamu-cycle-first-use-guide-v1:skipped")).toBe("true");
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
  });

  it("reports document-only safety when neither cleanup nor shared suppression can persist", () => {
    const { storage, values } = createStorage({
      "fukamu-cycle-first-use-guide-v1:eligible": "true",
    });
    const removeItem = storage.removeItem as ReturnType<typeof vi.fn>;
    const setItem = storage.setItem as ReturnType<typeof vi.fn>;
    removeItem.mockImplementation((key: string) => {
      if (key.endsWith(":eligible")) throw new Error("eligible is locked");
      values.delete(key);
    });
    setItem.mockImplementation(() => {
      throw new Error("storage is read-only");
    });

    expect(activateFirstUseGuide(storage)).toEqual({ sharedSafe: false });
    expect(shouldShowFirstUseGuideStage("goal", storage)).toBe(false);
  });
});
