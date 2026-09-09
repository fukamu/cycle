import type { Frame } from "../api/schemas";

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

export const statusLabel = {
  active_cycle: "進行中",
  goal_review: "目標の見直し中",
  achieved: "達成",
  ended: "終了",
  active: "編集中",
  completed: "Completed",
  canceled: "Canceled",
} as const;
