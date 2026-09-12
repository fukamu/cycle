import {
  cycleFrameTemplateCopy,
  firstUseGuideCopy,
  goalCopy,
  goalReviewDecisionCopy,
  textLimitCopy,
} from "./ja";

describe("first-use guide copy", () => {
  it("matches the canonical Goal to Review guide text", () => {
    expect(firstUseGuideCopy).toEqual({
      heading: "はじめてガイド",
      close: "閉じる",
      skip: "ガイドをスキップ",
      menuLabel: "はじめてガイドを表示",
      pending:
        "目標作成、サイクル、目標の見直し画面を開くと、その場に合うガイドを表示します。",
      cancelReplay: "ガイドの再表示を取り消す",
      stages: {
        goal: {
          location: "現在地：目標を決める",
          guide:
            "これから良くしたいことを、自分の言葉で書きます。短い文でも始められます。AIで整える操作は任意です。保存されたら「この目標で始める」でCycle 1へ進みます。",
        },
        plan: {
          location: "現在地：P — 今回試すことを決める",
          guide:
            "目標に向けて、今回試すことと、できたと考える目安を書きます。書けたらTabまたは「D — Doへ進む」で実行の記録へ進めます。",
        },
        do: {
          location: "現在地：D — 実際にしたことを記録する",
          guide:
            "実際にしたことや起きたことを、予定と違った点も含めて書きます。書けたらTabまたは「C — Checkへ進む」で振り返りへ進めます。",
        },
        check: {
          location: "現在地：C — 試した結果を振り返る",
          guide:
            "Pで考えたこととDで起きたことを比べ、分かったことを書きます。書けたらTabまたは「A — Actionへ進む」で次の動きを決めます。",
        },
        action: {
          location: "現在地：A — 次に続ける・変えることを決める",
          guide:
            "今回の学びから、次に続けること、変えること、やめることを書きます。自分で書いても、任意でAIを使ってもかまいません。P/D/C/Aが保存されたら「サイクルを完了」で目標の見直しへ進みます。",
        },
        review: {
          location: "現在地：目標を見直す",
          guide:
            "Cycle 1で分かったことを確認し、同じ目標で次へ進む、目標を変えて次へ進む、達成または終了を選びます。AIで整える操作は任意です。",
        },
      },
    });
  });
});

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
