import {
  cycleFrameTemplateCopy,
  goalCopy,
  goalReviewDecisionCopy,
  textLimitCopy,
} from "./ja";

describe("cycle frame template copy", () => {
  it("keeps the approved Plan and Do names and exact inserted previews", () => {
    expect(
      cycleFrameTemplateCopy.templates.plan.map(({ name, content }) => ({
        name,
        content,
      })),
    ).toEqual([
      {
        name: "小さく試す",
        content: "今回試すこと：\nいつ・どこで：\nできたと判断する目安：",
      },
      {
        name: "時間を決める",
        content: "取り組む時間：\nその時間にやること：\n終わりの条件：",
      },
      {
        name: "手順を決める",
        content: "最初の一歩：\n次にやること：\n行き詰まったとき：",
      },
    ]);
    expect(
      cycleFrameTemplateCopy.templates.do.map(({ name, content }) => ({
        name,
        content,
      })),
    ).toEqual([
      {
        name: "実行メモ",
        content: "やったこと：\n起きたこと：\n予定との違い：",
      },
      {
        name: "時間ごとの記録",
        content: "時刻：\nやったこと：\n結果：",
      },
      {
        name: "中断・再開メモ",
        content: "止まったところ：\n止まった理由：\n再開時の最初の一歩：",
      },
    ]);
  });
});

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
