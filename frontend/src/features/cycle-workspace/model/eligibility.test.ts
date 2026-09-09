import type { AutoSaveState } from "../../../shared/autosave/autoSaveCoordinator";

import {
  getCycleActionControls,
  getCycleEligibility,
  getCycleGoalActionGuidance,
  type CycleActionContext,
  type FrameValues,
} from "./eligibility";

const completeValues: FrameValues = {
  plan: "P",
  do: "D",
  check: "C",
  action: "A",
};

const activeContext: CycleActionContext = {
  pendingAction: false,
  recoveryPending: false,
};

describe("cycle workspace eligibility", () => {
  it("enables every command for fully saved input while AI is idle", () => {
    expect(
      getCycleEligibility(completeValues, { kind: "saved" }, "idle"),
    ).toEqual({
      canGenerateAction: true,
      canRefineAction: true,
      canCompleteCycle: true,
      canTerminateActiveGoal: true,
    });
  });

  it("keeps generation and active termination available when A is blank", () => {
    expect(
      getCycleEligibility(
        { ...completeValues, action: "" },
        { kind: "saved" },
        "idle",
      ),
    ).toEqual({
      canGenerateAction: true,
      canRefineAction: false,
      canCompleteCycle: false,
      canTerminateActiveGoal: true,
    });
  });

  it("uses Unicode White_Space for frame requirements without gating termination", () => {
    expect(
      getCycleEligibility(
        { ...completeValues, do: "\u0085" },
        { kind: "saved" },
        "idle",
      ),
    ).toEqual({
      canGenerateAction: false,
      canRefineAction: false,
      canCompleteCycle: false,
      canTerminateActiveGoal: true,
    });
  });

  it.each<AutoSaveState>([
    { kind: "dirty" },
    { kind: "saving" },
    { kind: "failed", errorCode: "NETWORK_ERROR" },
  ])("disables every command while autosave is $kind", (saveState) => {
    expect(getCycleEligibility(completeValues, saveState, "idle")).toEqual({
      canGenerateAction: false,
      canRefineAction: false,
      canCompleteCycle: false,
      canTerminateActiveGoal: false,
    });
  });

  it.each(["generating", "refining"] as const)(
    "disables every command while AI is %s",
    (aiState) => {
      expect(
        getCycleEligibility(completeValues, { kind: "saved" }, aiState),
      ).toEqual({
        canGenerateAction: false,
        canRefineAction: false,
        canCompleteCycle: false,
        canTerminateActiveGoal: false,
      });
    },
  );

  it("treats BOM as content according to the shared text contract", () => {
    expect(
      getCycleEligibility(
        { ...completeValues, plan: "\uFEFF" },
        { kind: "saved" },
        "idle",
      ).canGenerateAction,
    ).toBe(true);
  });

  it("returns no guidance when every action control is enabled", () => {
    expect(
      getCycleActionControls(
        completeValues,
        { kind: "saved" },
        "idle",
        activeContext,
      ),
    ).toEqual({
      generate: { enabled: true },
      refine: { enabled: true },
      complete: { enabled: true },
      guidance: null,
    });
  });

  it("keeps generation enabled and explains that A unlocks refine and complete", () => {
    expect(
      getCycleActionControls(
        { ...completeValues, action: "" },
        { kind: "saved" },
        "idle",
        activeContext,
      ),
    ).toEqual({
      generate: { enabled: true },
      refine: { enabled: false },
      complete: { enabled: false },
      guidance: {
        reason: { kind: "missing-frames", frames: ["action"] },
        commands: ["refine", "complete"],
      },
    });
  });

  it("reports exactly the missing P/D/C frames for every blocked action", () => {
    expect(
      getCycleActionControls(
        { ...completeValues, plan: " ", check: "\u0085" },
        { kind: "saved" },
        "idle",
        activeContext,
      ).guidance,
    ).toEqual({
      reason: { kind: "missing-frames", frames: ["plan", "check"] },
      commands: ["generate", "refine", "complete"],
    });
  });

  it.each([
    [{ ...activeContext, pendingAction: true }, "command-pending"],
    [{ ...activeContext, recoveryPending: true }, "recovery-pending"],
  ] as const)("distinguishes action context as %s", (context, reason) => {
    const controls = getCycleActionControls(
      completeValues,
      { kind: "saved" },
      "idle",
      context,
    );

    expect(controls.generate.enabled).toBe(false);
    expect(controls.refine.enabled).toBe(false);
    expect(controls.complete.enabled).toBe(false);
    expect(controls.guidance?.reason.kind).toBe(reason);
  });

  it.each([
    [{ kind: "dirty" }, "save-dirty"],
    [{ kind: "saving" }, "save-saving"],
    [{ kind: "failed", errorCode: "NETWORK_ERROR" }, "save-failed"],
  ] as const)("distinguishes autosave state as %s", (saveState, reason) => {
    const controls = getCycleActionControls(
      completeValues,
      saveState,
      "idle",
      activeContext,
    );

    expect(controls.generate.enabled).toBe(false);
    expect(controls.guidance?.reason.kind).toBe(reason);
  });

  it.each([
    ["generating", "ai-generating"],
    ["refining", "ai-refining"],
  ] as const)("distinguishes AI state as %s", (aiState, reason) => {
    const controls = getCycleActionControls(
      completeValues,
      { kind: "saved" },
      aiState,
      activeContext,
    );

    expect(controls.generate.enabled).toBe(false);
    expect(controls.guidance?.reason.kind).toBe(reason);
  });

  it("associates a pending command with every Goal action", () => {
    expect(
      getCycleGoalActionGuidance(
        { kind: "failed", errorCode: "NETWORK_ERROR" },
        "generating",
        { ...activeContext, pendingAction: true },
      ),
    ).toEqual({
      reason: { kind: "command-pending" },
      commands: ["achieve", "end", "delete"],
    });
  });

  it.each([
    [{ kind: "dirty" }, "save-dirty"],
    [{ kind: "saving" }, "save-saving"],
    [{ kind: "failed", errorCode: "NETWORK_ERROR" }, "save-failed"],
  ] as const)(
    "associates Goal termination guidance with autosave state %s without gating Delete",
    (saveState, reason) => {
      expect(
        getCycleGoalActionGuidance(saveState, "idle", activeContext),
      ).toEqual({
        reason: { kind: reason },
        commands: ["achieve", "end"],
      });
    },
  );

  it.each([
    ["generating", "ai-generating"],
    ["refining", "ai-refining"],
  ] as const)(
    "associates Goal termination guidance with AI state %s without gating Delete",
    (aiState, reason) => {
      expect(
        getCycleGoalActionGuidance({ kind: "saved" }, aiState, activeContext),
      ).toEqual({
        reason: { kind: reason },
        commands: ["achieve", "end"],
      });
    },
  );

  it("returns no Goal action guidance for saved input while AI is idle", () => {
    expect(
      getCycleGoalActionGuidance({ kind: "saved" }, "idle", activeContext),
    ).toBeNull();
  });

  it("explains a failed save through recovery without treating recovery as a new gate", () => {
    expect(
      getCycleGoalActionGuidance(
        { kind: "failed", errorCode: "REVISION_CONFLICT" },
        "idle",
        { ...activeContext, recoveryPending: true },
      ),
    ).toEqual({
      reason: { kind: "recovery-pending" },
      commands: ["achieve", "end"],
    });
    expect(
      getCycleGoalActionGuidance({ kind: "saved" }, "idle", {
        ...activeContext,
        recoveryPending: true,
      }),
    ).toBeNull();
  });
});
