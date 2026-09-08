import {
  clearSelectedCycleFrames,
  forgetSelectedCycleFrame,
  forgetSelectedCycleFrameFromWorkspacePath,
  readSelectedCycleFrame,
  reconcileSelectedCycleFrames,
  rememberSelectedCycleFrame,
  type SelectedFramePreferenceStorage,
} from "./selectedFramePreference";

function createStorage(initial: Readonly<Record<string, string>> = {}): {
  readonly storage: SelectedFramePreferenceStorage;
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      get length(): number {
        return values.size;
      },
      key: vi.fn((index: number) => [...values.keys()][index] ?? null),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    },
  };
}

function selectedKey(values: Map<string, string>, cycleId: string): string {
  return [...values.keys()].find((key) => key.endsWith(":" + cycleId)) ?? "";
}

describe("selected Frame preference", () => {
  const firstCycleId = "40000000-0000-7000-8000-000000000001";
  const secondCycleId = "40000000-0000-7000-8000-000000000002";

  it("stores the Cycle ID in the versioned key and only the Frame as its value", () => {
    const { storage, values } = createStorage();

    rememberSelectedCycleFrame(firstCycleId, "check", storage);

    expect(values.size).toBe(1);
    expect(selectedKey(values, firstCycleId)).toContain(
      "fukamu-cycle-selected-frame-v1:",
    );
    expect(values.get(selectedKey(values, firstCycleId))).toBe("check");
  });

  it("restores separate Frames for multiple Active Cycles", () => {
    const { storage } = createStorage();
    rememberSelectedCycleFrame(firstCycleId, "do", storage);
    rememberSelectedCycleFrame(secondCycleId, "action", storage);

    expect(readSelectedCycleFrame(firstCycleId, "active", storage)).toBe("do");
    expect(readSelectedCycleFrame(secondCycleId, "active", storage)).toBe(
      "action",
    );
  });

  it.each(["completed", "canceled"] as const)(
    "falls back to P and removes a %s Cycle preference",
    (status) => {
      const { storage, values } = createStorage();
      rememberSelectedCycleFrame(firstCycleId, "action", storage);

      expect(readSelectedCycleFrame(firstCycleId, status, storage)).toBe(
        "plan",
      );
      expect(values.size).toBe(0);
    },
  );

  it.each(["review", "{", "", "PLAN"])(
    "falls back to P for invalid stored value %s",
    (value) => {
      const { storage, values } = createStorage();
      rememberSelectedCycleFrame(firstCycleId, "do", storage);
      values.set(selectedKey(values, firstCycleId), value);

      expect(readSelectedCycleFrame(firstCycleId, "active", storage)).toBe(
        "plan",
      );
    },
  );

  it("removes only the requested Cycle preference", () => {
    const { storage, values } = createStorage();
    rememberSelectedCycleFrame(firstCycleId, "do", storage);
    rememberSelectedCycleFrame(secondCycleId, "check", storage);

    forgetSelectedCycleFrame(firstCycleId, storage);

    expect(readSelectedCycleFrame(firstCycleId, "active", storage)).toBe(
      "plan",
    );
    expect(readSelectedCycleFrame(secondCycleId, "active", storage)).toBe(
      "check",
    );
    expect(values.size).toBe(1);
  });

  it("removes the current Cycle only for an explicit workspace-to-Home path", () => {
    const { storage } = createStorage();
    rememberSelectedCycleFrame(firstCycleId, "do", storage);
    rememberSelectedCycleFrame(secondCycleId, "check", storage);

    forgetSelectedCycleFrameFromWorkspacePath(
      `/goals/10000000-0000-7000-8000-000000000001/cycles/${firstCycleId}`,
      storage,
    );
    forgetSelectedCycleFrameFromWorkspacePath("/settings", storage);

    expect(readSelectedCycleFrame(firstCycleId, "active", storage)).toBe(
      "plan",
    );
    expect(readSelectedCycleFrame(secondCycleId, "active", storage)).toBe(
      "check",
    );
  });

  it("reconciles stale and malformed keys while retaining current Active Cycles", () => {
    const { storage, values } = createStorage();
    rememberSelectedCycleFrame(firstCycleId, "do", storage);
    rememberSelectedCycleFrame(secondCycleId, "check", storage);
    const prefix = selectedKey(values, firstCycleId).slice(
      0,
      -firstCycleId.length,
    );
    values.set(prefix + "not-a-cycle", "action");
    values.set("unrelated", "keep");

    reconcileSelectedCycleFrames([secondCycleId], storage);

    expect(readSelectedCycleFrame(firstCycleId, "active", storage)).toBe(
      "plan",
    );
    expect(readSelectedCycleFrame(secondCycleId, "active", storage)).toBe(
      "check",
    );
    expect(values.has(prefix + "not-a-cycle")).toBe(false);
    expect(values.get("unrelated")).toBe("keep");
  });

  it("clears every selected Frame preference without touching other storage", () => {
    const { storage, values } = createStorage({ unrelated: "keep" });
    rememberSelectedCycleFrame(firstCycleId, "do", storage);
    rememberSelectedCycleFrame(secondCycleId, "check", storage);

    clearSelectedCycleFrames(storage);

    expect(values).toEqual(new Map([["unrelated", "keep"]]));
  });

  it("fails closed without interrupting navigation when storage is unavailable", () => {
    const unavailable: SelectedFramePreferenceStorage = {
      get length(): number {
        throw new DOMException("blocked", "SecurityError");
      },
      key: () => {
        throw new DOMException("blocked", "SecurityError");
      },
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

    expect(readSelectedCycleFrame(firstCycleId, "active", unavailable)).toBe(
      "plan",
    );
    expect(() =>
      rememberSelectedCycleFrame(firstCycleId, "do", unavailable),
    ).not.toThrow();
    expect(() =>
      forgetSelectedCycleFrame(firstCycleId, unavailable),
    ).not.toThrow();
    expect(() => clearSelectedCycleFrames(unavailable)).not.toThrow();
    expect(() =>
      reconcileSelectedCycleFrames([firstCycleId], unavailable),
    ).not.toThrow();
  });
});
