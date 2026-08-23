import type { AutoSaveState } from "../../../shared/autosave/autoSaveCoordinator";

import { getCycleEligibility, type FrameValues } from "./eligibility";

const completeValues: FrameValues = {
  plan: "P",
  do: "D",
  check: "C",
  action: "A",
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
});
