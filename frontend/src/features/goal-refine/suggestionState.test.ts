import { isGoalSuggestionStale } from "./suggestionState";

describe("isGoalSuggestionStale", () => {
  it("accepts a saved draft restored to the exact source text", () => {
    expect(isGoalSuggestionStale("元の目標", "元の目標", "saved")).toBe(false);
  });

  it("rejects different text and any pending save", () => {
    expect(isGoalSuggestionStale("変更後", "元の目標", "saved")).toBe(true);
    expect(isGoalSuggestionStale("元の目標", "元の目標", "dirty")).toBe(true);
    expect(isGoalSuggestionStale("元の目標", "元の目標", "saving")).toBe(true);
    expect(isGoalSuggestionStale("元の目標", "元の目標", "failed")).toBe(true);
  });
});
