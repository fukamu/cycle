import { getGoalCreationActionControls } from "./actionControls";

const saved = { kind: "saved" } as const;

describe("goal creation action controls", () => {
  it("enables all actions for a valid saved draft with available capacity", () => {
    expect(
      getGoalCreationActionControls({
        valid: true,
        saveState: saved,
        aiRunning: false,
        pending: false,
        canStartProgressingGoal: true,
        hydrating: false,
        scopeMoved: false,
        recovery: null,
      }),
    ).toEqual({
      refine: { enabled: true },
      start: { enabled: true },
      discard: { enabled: true },
    });
  });

  it.each([
    ["command-pending", { pending: true }],
    ["save-dirty", { saveState: { kind: "dirty" } }],
    ["save-saving", { saveState: { kind: "saving" } }],
    [
      "save-failed",
      { saveState: { kind: "failed", errorCode: "SAVE_FAILED" } },
    ],
    ["ai-running", { aiRunning: true }],
    ["invalid-goal", { valid: false }],
  ] as const)("blocks saved-draft actions for %s", (reason, override) => {
    const controls = getGoalCreationActionControls({
      valid: true,
      saveState: saved,
      aiRunning: false,
      pending: false,
      canStartProgressingGoal: true,
      hydrating: false,
      scopeMoved: false,
      recovery: null,
      ...override,
    });

    expect(controls.refine).toEqual({ enabled: false, reason });
    expect(controls.start).toEqual({ enabled: false, reason });
  });

  it("limits starting without blocking refinement", () => {
    const controls = getGoalCreationActionControls({
      valid: true,
      saveState: saved,
      aiRunning: false,
      pending: false,
      canStartProgressingGoal: false,
      hydrating: false,
      scopeMoved: false,
      recovery: null,
    });

    expect(controls.refine).toEqual({ enabled: true });
    expect(controls.start).toEqual({
      enabled: false,
      reason: "progressing-goal-limit",
    });
  });

  it("uses the Goal limit for Start while keeping invalid guidance for Refine", () => {
    const controls = getGoalCreationActionControls({
      valid: false,
      saveState: saved,
      aiRunning: false,
      pending: false,
      canStartProgressingGoal: false,
      hydrating: false,
      scopeMoved: false,
      recovery: null,
    });

    expect(controls.refine.reason).toBe("invalid-goal");
    expect(controls.start.reason).toBe("progressing-goal-limit");
  });

  it.each([
    ["hydrating", { hydrating: true }],
    ["scope-moved", { scopeMoved: true }],
    ["recovery-resolving", { recovery: "resolving" }],
    ["recovery-choice", { recovery: "choice" }],
  ] as const)(
    "blocks saved-draft actions for the standalone %s context",
    (reason, override) => {
      const controls = getGoalCreationActionControls({
        valid: true,
        saveState: saved,
        aiRunning: false,
        pending: false,
        canStartProgressingGoal: true,
        hydrating: false,
        scopeMoved: false,
        recovery: null,
        ...override,
      });

      expect(controls.refine.reason).toBe(reason);
      expect(controls.start.reason).toBe(reason);
    },
  );

  it("reuses scope and Recovery guidance before generic failure guidance", () => {
    const failed = { kind: "failed", errorCode: "SAVE_FAILED" } as const;
    const moved = getGoalCreationActionControls({
      valid: true,
      saveState: failed,
      aiRunning: false,
      pending: true,
      canStartProgressingGoal: true,
      hydrating: false,
      scopeMoved: true,
      recovery: null,
    });
    const recovery = getGoalCreationActionControls({
      valid: true,
      saveState: failed,
      aiRunning: false,
      pending: false,
      canStartProgressingGoal: true,
      hydrating: false,
      scopeMoved: false,
      recovery: "choice",
    });

    expect(moved.refine.reason).toBe("scope-moved");
    expect(moved.start.reason).toBe("scope-moved");
    expect(moved.discard.reason).toBe("scope-moved");
    expect(recovery.refine.reason).toBe("recovery-choice");
    expect(recovery.start.reason).toBe("recovery-choice");
    expect(recovery.discard).toEqual({ enabled: true });
  });

  it.each([
    ["command-pending", { pending: true }],
    ["hydrating", { hydrating: true }],
    ["scope-moved", { scopeMoved: true }],
  ] as const)("explains why discard is blocked for %s", (reason, override) => {
    const controls = getGoalCreationActionControls({
      valid: true,
      saveState: saved,
      aiRunning: false,
      pending: false,
      canStartProgressingGoal: true,
      hydrating: false,
      scopeMoved: false,
      recovery: null,
      ...override,
    });

    expect(controls.discard).toEqual({ enabled: false, reason });
  });
});
