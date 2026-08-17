import {
  readFrameSelection,
  writeFrameSelection,
} from "./frameSelectionRepository";

describe("frameSelectionRepository", () => {
  beforeEach(() => window.localStorage.clear());

  it("restores the selected frame for the same active cycle", () => {
    writeFrameSelection("cycle-1", "check");

    expect(readFrameSelection("cycle-1")).toBe("check");
  });

  it("defaults to plan for a different cycle", () => {
    writeFrameSelection("cycle-1", "action");

    expect(readFrameSelection("cycle-2")).toBe("plan");
  });

  it("defaults to plan when stored data is invalid", () => {
    window.localStorage.setItem(
      "pdcai:selected-frame:v1",
      JSON.stringify({ cycleId: "cycle-1", frame: "invalid" }),
    );

    expect(readFrameSelection("cycle-1")).toBe("plan");
  });
});
