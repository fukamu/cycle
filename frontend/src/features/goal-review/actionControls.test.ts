import { getGoalReviewActionControls } from "./actionControls";

const saved = { kind: "saved" } as const;

describe("goal review action controls", () => {
  function controls(
    override: Partial<Parameters<typeof getGoalReviewActionControls>[0]> = {},
  ) {
    return getGoalReviewActionControls({
      valid: true,
      saveState: saved,
      aiRunning: false,
      pending: false,
      hydrating: false,
      workspaceMoved: false,
      recovery: null,
      ...override,
    });
  }

  it("enables all actions for a valid saved review draft", () => {
    expect(controls()).toEqual({
      refine: { enabled: true },
      continue: { enabled: true },
      terminal: { enabled: true },
    });
  });

  it.each([
    ["command-pending", { pending: true }],
    ["workspace-moved", { workspaceMoved: true }],
    ["save-dirty", { saveState: { kind: "dirty" } }],
    ["save-saving", { saveState: { kind: "saving" } }],
    [
      "save-failed",
      { saveState: { kind: "failed", errorCode: "SAVE_FAILED" } },
    ],
    ["ai-running", { aiRunning: true }],
    ["invalid-goal", { valid: false }],
  ] as const)("blocks saved-draft actions for %s", (reason, override) => {
    const result = controls(override);

    expect(result.refine).toEqual({ enabled: false, reason });
    expect(result.continue).toEqual({ enabled: false, reason });
  });

  it.each([
    ["save-dirty", { saveState: { kind: "dirty" } }],
    ["save-saving", { saveState: { kind: "saving" } }],
    [
      "save-failed",
      { saveState: { kind: "failed", errorCode: "SAVE_FAILED" } },
    ],
    ["invalid-goal", { valid: false }],
  ] as const)("keeps terminal actions enabled during %s", (_, override) => {
    expect(controls(override).terminal).toEqual({ enabled: true });
  });

  it.each([
    ["hydrating", { hydrating: true }, true],
    ["recovery-resolving", { recovery: "resolving" }, false],
    ["recovery-choice", { recovery: "choice" }, false],
  ] as const)(
    "blocks saved-draft actions for the standalone %s context",
    (reason, override, blocksTerminal) => {
      const result = controls(override);

      expect(result.refine.reason).toBe(reason);
      expect(result.continue.reason).toBe(reason);
      expect(result.terminal.enabled).toBe(!blocksTerminal);
    },
  );

  it("reuses moved and Recovery guidance before generic failure guidance", () => {
    const failed = { kind: "failed", errorCode: "SAVE_FAILED" } as const;
    const moved = controls({
      workspaceMoved: true,
      pending: true,
      saveState: failed,
    });
    const recovery = controls({
      recovery: "choice",
      saveState: failed,
    });

    expect(moved).toEqual({
      refine: { enabled: false, reason: "workspace-moved" },
      continue: { enabled: false, reason: "workspace-moved" },
      terminal: { enabled: false, reason: "workspace-moved" },
    });
    expect(recovery.refine.reason).toBe("recovery-choice");
    expect(recovery.continue.reason).toBe("recovery-choice");
    expect(recovery.terminal).toEqual({ enabled: true });
  });

  it.each([
    ["command-pending", { pending: true }],
    ["workspace-moved", { workspaceMoved: true }],
    ["hydrating", { hydrating: true }],
    ["ai-running", { aiRunning: true }],
  ] as const)(
    "explains why terminal actions are blocked for %s",
    (reason, override) => {
      expect(controls(override).terminal).toEqual({ enabled: false, reason });
    },
  );
});
