import type { Frame } from "../api/schemas";

export const firstUseGuideCopy = {
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
} as const;

export const frameCopy: Record<
  Frame,
  { label: string; name: string; guide: string; placeholder: string }
> = {
  plan: {
    label: "P",
    name: "Plan",
    guide:
      "この目標に向けて、今回どのような変化を試しますか？何を行い、どうなれば前進したと考えられるかを書きましょう。",
    placeholder:
      "例：今週は毎朝、最重要タスクを1つ決め、メールを開く前に30分取り組む。5日中3日以上、午前中に主要業務を終えられるか試す。",
  },
  do: {
    label: "D",
    name: "Do",
    guide:
      "実際に何をしましたか？回数・時間・起きたこと・予定との違いなど、確認できる事実を記録しましょう。",
    placeholder:
      "例：5日中4日はメールを開く前に着手した。3日は30分取り組めたが、1日は15分で中断した。残る1日はメール対応を先に始めた。",
  },
  check: {
    label: "C",
    name: "Check",
    guide:
      "Pで考えた期待とDの事実を比べると、何が分かりますか？うまくいった点・いかなかった点と、その理由として考えられることを振り返りましょう。",
    placeholder:
      "例：30分確保できた3日は午前中に主要業務を終えられた。中断した日とメールを先に開いた日は終わらなかったため、最初の30分を守ることが有効そうだ。",
  },
  action: {
    label: "A",
    name: "Action",
    guide:
      "今回の学びを踏まえ、次に何を続け、変え、またはやめますか？実行方法と、次回どう確かめるかを具体的にしましょう。",
    placeholder:
      "例：メールを開く前の30分を継続し、その間は通知を切る。次のサイクルでは、30分確保できた日数と午前中に完了できた日数を記録する。",
  },
};

export const cycleFrameCopy = {
  terminalEmpty: "未入力",
} as const;

export type CycleFrameTemplate = {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly content: string;
};

export const cycleFrameTemplateCopy = {
  heading: "書き始めのテンプレート（任意）",
  guide: "内容を確認してから選んでください。挿入後は自由に編集できます。",
  previewLabel: "挿入される内容",
  insert: (name: string) => `${name}を挿入`,
  undo: "テンプレートの挿入を取り消す",
  disabled: {
    hasContent: (frameLabel: string) =>
      `現在の${frameLabel}に入力があるため、テンプレートを挿入できません。既存の内容は上書きしません。`,
    composition: "文字の変換を確定してからテンプレートを挿入してください。",
    recovery: "確認待ちの入力を解決してからテンプレートを挿入してください。",
    workspaceMoved: "現在の作業を確認してからテンプレートを挿入してください。",
    commandPending:
      "サイクルの操作が完了してからテンプレートを挿入してください。",
  },
  templates: {
    plan: [
      {
        id: "small-experiment",
        name: "小さく試す",
        purpose: "試すことと、できたと判断する目安を短く整理します。",
        content: "今回試すこと：\nいつ・どこで：\nできたと判断する目安：",
      },
      {
        id: "time-box",
        name: "時間を決める",
        purpose: "取り組む時間と、時間内に終える範囲を決めます。",
        content: "取り組む時間：\nその時間にやること：\n終わりの条件：",
      },
      {
        id: "steps",
        name: "手順を決める",
        purpose: "始め方と次の手順、行き詰まったときの動きを決めます。",
        content: "最初の一歩：\n次にやること：\n行き詰まったとき：",
      },
    ] as const satisfies readonly CycleFrameTemplate[],
    do: [
      {
        id: "execution-note",
        name: "実行メモ",
        purpose: "実際にやったことと、予定との違いを残します。",
        content: "やったこと：\n起きたこと：\n予定との違い：",
      },
      {
        id: "time-log",
        name: "時間ごとの記録",
        purpose: "時刻ごとに行動と結果を並べて記録します。",
        content: "時刻：\nやったこと：\n結果：",
      },
      {
        id: "resume-note",
        name: "中断・再開メモ",
        purpose: "中断した場所と理由、再開の一歩を残します。",
        content: "止まったところ：\n止まった理由：\n再開時の最初の一歩：",
      },
    ] as const satisfies readonly CycleFrameTemplate[],
  } satisfies Record<"plan" | "do", readonly CycleFrameTemplate[]>,
} as const;

export const cycleNextFrameCopy = {
  plan: { frame: "do", label: "D — Doへ進む" },
  do: { frame: "check", label: "C — Checkへ進む" },
  check: { frame: "action", label: "A — Actionへ進む" },
} as const satisfies Record<
  Exclude<Frame, "action">,
  { readonly frame: Frame; readonly label: string }
>;

export const cycleCheckComparisonCopy = {
  heading: "今回のPとDを比べる",
  guide: "Pの期待とDの事実を見ながら、Cに分かったことを書きましょう。",
  empty: "まだ入力されていません",
  recoveryPending: "要確認",
  recoveryGuide: "このフレームには、この端末に残った確認待ちの入力があります。",
  reviewRecovery: (frameLabel: "P" | "D") => `${frameLabel}の入力を確認`,
} as const;

export const cycleDoQuickEntryCopy = {
  action: "今の実行を記録",
  description:
    "この端末の現在時刻をDに追加します。サーバーの基準時刻ではありません。",
  undo: "日時の追加を取り消す",
  duplicate: "同じ日時の見出しはすでに追加されています。",
  disabled: {
    composition: "文字の変換を確定してから追加してください。",
    recovery: "確認待ちの入力を解決してから追加してください。",
    workspaceMoved: "現在の作業を確認してから追加してください。",
    commandPending: "サイクルの操作が完了してから追加してください。",
  },
  tooLong: (
    requiredCodePoints: number,
    excessCodePoints: number,
    maximumCodePoints: number,
  ) =>
    `追加後は${requiredCodePoints}文字になるため、Dをあと${excessCodePoints}文字減らしてください（上限${maximumCodePoints}文字）。`,
} as const;

export const textLimitCopy = {
  rejected: (
    requiredCodePoints: number,
    maximumCodePoints: number,
    excessCodePoints: number,
  ) =>
    `入力後は${requiredCodePoints}文字になるため反映できませんでした。上限${maximumCodePoints}文字まで、入力内容をあと${excessCodePoints}文字減らしてください。`,
} as const;

export const cycleActionCopy = {
  disabled: {
    commandPending:
      "サイクルの操作を処理しています。完了するまでお待ちください。",
    recoveryPending:
      "確認待ちの入力があります。「要確認」のフレームを開き、使用する内容を選んでください。",
    saveDirty: "未保存の入力があります。保存済みになるまでお待ちください。",
    saveSaving: "入力を保存しています。保存済みになるまでお待ちください。",
    saveFailed:
      "入力を保存できていません。「再試行」で保存してから操作してください。",
    aiGenerating: "アクションを生成しています。完了するまでお待ちください。",
    aiRefining: "アクションを推敲しています。完了するまでお待ちください。",
    missingPlanDoCheck: (frames: readonly string[]) =>
      `${frames.join("・")}を入力して保存すると、Aの操作へ進めます。`,
    missingAction:
      "Aを入力するか「アクションを生成」を使うと、AIで推敲してサイクルを完了できます。",
  },
} as const;

export const cycleGoalActionCopy = {
  disabled: {
    commandPending: "現在の操作を処理しています。完了するまでお待ちください。",
    recoveryPending:
      "目標を達成・終了するには、「要確認」のフレームを開き、使用する内容を選んでください。",
    saveDirty:
      "目標を達成・終了するには、入力が保存済みになるまでお待ちください。",
    saveSaving: "目標を達成・終了するには、入力の保存完了をお待ちください。",
    saveFailed:
      "目標を達成・終了するには、「再試行」で入力を保存してください。",
    aiGenerating:
      "目標を達成・終了するには、アクションの生成完了をお待ちください。",
    aiRefining:
      "目標を達成・終了するには、アクションの推敲完了をお待ちください。",
  },
} as const;

export const goalCopy = {
  guide:
    "これから良くしたいことや、目指したい状態を書いてみましょう。最初から完璧である必要はありません。",
  placeholder: "例：仕事の優先順位を整理し、平日に余裕を持てるようになりたい。",
  limit: (progressingGoalLimit: number) =>
    `取り組んでいる目標が上限の${progressingGoalLimit}件に達しています。この目標を始めるには、いずれかの目標を達成・終了・削除してください。`,
} as const;

export const goalActionCopy = {
  disabled: {
    commandPending: "目標の操作を処理しています。完了するまでお待ちください。",
    hydrating:
      "この端末に残る入力を確認しています。完了するまでお待ちください。",
    saveDirty: "未保存の入力があります。保存済みになるまでお待ちください。",
    saveSaving: "入力を保存しています。保存済みになるまでお待ちください。",
    saveFailed:
      "入力を保存できていません。「再試行」で保存してから操作してください。",
    aiRunning: "目標を整理しています。完了するまでお待ちください。",
    creationInvalid: "空白以外の文字を含む80文字以内の目標を入力してください。",
    reviewInvalid:
      "空白以外の文字を含む80文字以内で、次のサイクルの目標を入力してください。",
  },
} as const;

export const goalReviewDecisionCopy = {
  context: {
    heading: "判断の材料",
    guide:
      "現在の目標と直前の振り返りを確認して、次のサイクルへ進むか、この目標を終えるかを選びます。",
    currentGoal: (versionNumber: number) =>
      `現在の目標 · Goal v${versionNumber}`,
    checkHeading: "直前のC — 分かったこと",
    actionHeading: "直前のA — 次に続ける・変えること",
    planAndDoSummary: "直前のCycleのP/Dも確認",
  },
  draft: {
    same: (versionNumber: number) =>
      `現在のGoal v${versionNumber}と同じ内容です。`,
    changed: (nextVersionNumber: number) =>
      `変更案です。次のサイクルへ進む場合だけGoal v${nextVersionNumber}として保存します。`,
  },
  continue: {
    same: (versionNumber: number, nextCycleSequenceNumber: number) =>
      `現在のGoal v${versionNumber}を維持し、新しいGoal Versionは作成せず、Cycle ${nextCycleSequenceNumber}を開始します。`,
    changed: (nextVersionNumber: number, nextCycleSequenceNumber: number) =>
      `変更案をGoal v${nextVersionNumber}として保存し、Cycle ${nextCycleSequenceNumber}を開始します。`,
  },
  terminal: {
    unchangedResult: (versionNumber: number, nextCycleSequenceNumber: number) =>
      `Review下書きは破棄されます。現在のGoal v${versionNumber}のまま終了し、新しいGoal Versionは作成せず、Cycle ${nextCycleSequenceNumber}も開始しません。`,
    changedResult: (
      versionNumber: number,
      nextVersionNumber: number,
      nextCycleSequenceNumber: number,
    ) =>
      `変更中の目標案は破棄し、Goal v${nextVersionNumber}は作成しません。現在のGoal v${versionNumber}のまま終了し、Cycle ${nextCycleSequenceNumber}も開始しません。`,
    irreversible:
      "どちらの操作も取り消せず、この目標はあとから再開できません。",
    achieved: {
      heading: "達成として終える",
      description:
        "目標を達成した状態として記録して、ここで取り組みを終えます。",
      action: "目標を達成として終了",
    },
    ended: {
      heading: "達成とはせずに終える",
      description: "目標を達成したとはせず、ここで取り組みを終えます。",
      action: "目標を終了",
    },
    deleteHeading: "目標と履歴を削除する",
    deleteDescription:
      "目標自体とすべてのCycle履歴を完全に削除する場合はこちらを選びます。",
    modalDraftDiscardSame:
      "このReview下書きは、別のタブで保存された変更も含めて破棄され、新しいGoal Versionは作成しません。",
    modalDraftDiscardChanged: (nextVersionNumber: number) =>
      `このReview下書きは、別のタブで保存された変更も含めて破棄され、Goal v${nextVersionNumber}として保存されません。`,
    modalCurrentGoal: (
      versionNumber: number,
      nextCycleSequenceNumber: number,
    ) =>
      `現在のGoal v${versionNumber}のまま終了し、Cycle ${nextCycleSequenceNumber}は開始されません。`,
  },
} as const;

export const statusLabel = {
  active_cycle: "進行中",
  goal_review: "目標の見直し中",
  achieved: "達成",
  ended: "終了",
  active: "編集中",
  completed: "Completed",
  canceled: "Canceled",
} as const;

export const goalHistoryPaginationCopy = {
  loadMore: "続きを読み込む",
  error: "続きを読み込めませんでした。",
  retry: "もう一度読み込む",
  loading: "続きを読み込んでいます…",
  complete: "すべての目標を読み込みました。",
} as const;
