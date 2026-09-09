import { goalCopy, textLimitCopy } from "./ja";

describe("goal limit copy", () => {
  it.each([
    [2, "上限の2件"],
    [3, "上限の3件"],
  ])("uses the configured limit %i", (limit, expected) => {
    expect(goalCopy.limit(limit)).toContain(expected);
  });
});

describe("text limit copy", () => {
  it("explains the required, maximum, and excess code-point counts", () => {
    expect(textLimitCopy.rejected(83, 80, 3)).toBe(
      "入力後は83文字になるため反映できませんでした。上限80文字まで、入力内容をあと3文字減らしてください。",
    );
  });
});
