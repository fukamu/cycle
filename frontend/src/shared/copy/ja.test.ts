import { goalCopy, goalReviewDecisionCopy, textLimitCopy } from "./ja";

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

describe("goal review decision copy", () => {
  it("names the exact version and cycle result for unchanged and changed drafts", () => {
    expect(goalReviewDecisionCopy.continue.same(2, 4)).toBe(
      "現在のGoal v2を維持し、新しいGoal Versionは作成せず、Cycle 4を開始します。",
    );
    expect(goalReviewDecisionCopy.continue.changed(3, 4)).toBe(
      "変更案をGoal v3として保存し、Cycle 4を開始します。",
    );
  });

  it("explains the discarded version and cycle that terminal actions do not create", () => {
    expect(goalReviewDecisionCopy.terminal.changedResult(2, 3, 4)).toBe(
      "変更中の目標案は破棄し、Goal v3は作成しません。現在のGoal v2のまま終了し、Cycle 4も開始しません。",
    );
    expect(goalReviewDecisionCopy.terminal.unchangedResult(2, 4)).toBe(
      "Review下書きは破棄されます。現在のGoal v2のまま終了し、新しいGoal Versionは作成せず、Cycle 4も開始しません。",
    );
    expect(goalReviewDecisionCopy.terminal.modalDraftDiscardSame).toBe(
      "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionは作成しません。",
    );
    expect(goalReviewDecisionCopy.terminal.modalDraftDiscardChanged(3)).toBe(
      "このReview下書きは、別のタブで保存された変更も含めて破棄され、Goal v3として保存されません。",
    );
  });
});
