import { goalCopy } from "./ja";

describe("goal limit copy", () => {
  it.each([
    [2, "上限の2件"],
    [3, "上限の3件"],
  ])("uses the configured limit %i", (limit, expected) => {
    expect(goalCopy.limit(limit)).toContain(expected);
  });
});
