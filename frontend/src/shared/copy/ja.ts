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

export const cycleCheckComparisonCopy = {
  heading: "今回のPとDを比べる",
  guide: "Pの期待とDの事実を見ながら、Cに分かったことを書きましょう。",
  empty: "まだ入力されていません",
  recoveryPending: "要確認",
  recoveryGuide: "このフレームには、この端末に残った確認待ちの入力があります。",
  reviewRecovery: (frameLabel: "P" | "D") => `${frameLabel}の入力を確認`,
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

export const goalCopy = {
  guide:
    "これから良くしたいことや、目指したい状態を書いてみましょう。最初から完璧である必要はありません。",
  placeholder: "例：仕事の優先順位を整理し、平日に余裕を持てるようになりたい。",
  limit: (progressingGoalLimit: number) =>
    `取り組んでいる目標が上限の${progressingGoalLimit}件に達しています。この目標を始めるには、いずれかの目標を達成・終了・削除してください。`,
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
