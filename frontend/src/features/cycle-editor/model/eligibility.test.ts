import {
  canComplete,
  canGenerate,
  canRefine,
  codePointCount,
  isNonBlank,
  type FrameValues,
  type SaveState,
} from "./eligibility";

const completeValues: FrameValues = {
  plan: "P",
  do: "D",
  check: "C",
  action: "A",
};
const saved: SaveState = { kind: "saved" };

describe("cycle eligibility", () => {
  it("counts Unicode code points", () => {
    expect(codePointCount("改善😀")).toBe(3);
  });

  it("uses Unicode White_Space for blank checks", () => {
    expect(isNonBlank("\u0085")).toBe(false);
    expect(isNonBlank("\uFEFF")).toBe(true);
  });

  it("requires saved P/D/C for generate", () => {
    expect(canGenerate(completeValues, saved, { kind: "idle" })).toBe(true);
    expect(
      canGenerate({ ...completeValues, do: "　" }, saved, { kind: "idle" }),
    ).toBe(false);
    expect(
      canGenerate(
        completeValues,
        { kind: "dirty", dirtyFrames: ["plan"] },
        { kind: "idle" },
      ),
    ).toBe(false);
  });

  it("requires A and idle AI for refine and complete", () => {
    expect(canRefine(completeValues, saved, { kind: "idle" })).toBe(true);
    expect(
      canComplete({ ...completeValues, action: "" }, saved, { kind: "idle" }),
    ).toBe(false);
    expect(canComplete(completeValues, saved, { kind: "generating" })).toBe(
      false,
    );
  });
});
