import type { Frame } from "../../shared/api/schemas";

export const frameOrder: readonly Frame[] = ["plan", "do", "check", "action"];

export const frameCopy: Readonly<
  Record<
    Frame,
    {
      readonly short: string;
      readonly name: string;
      readonly guide: string;
      readonly placeholder: string;
    }
  >
> = {
  plan: {
    short: "P",
    name: "Plan",
    guide:
      "今回、何を良くしたいですか？どうなれば良くなったと判断でき、そのために何を試すかを決めましょう。",
    placeholder:
      "例：今週5日間、午前中に最重要タスクを終えられる日を増やしたい。メールを開く前に30分取り組み、5日中3日以上で午前中に完了できるか試す。",
  },
  do: {
    short: "D",
    name: "Do",
    guide:
      "計画に対して、実際に何をしましたか？回数・時間・起きたこと・予定との違いなど、確認できる事実を記録しましょう。",
    placeholder:
      "例：5日中4日はメールを開く前に着手した。3日は30分取り組んで午前中に完了し、1日は15分で中断して午後まで残った。残る1日はメールを先に開き、着手は午後になった。",
  },
  check: {
    short: "C",
    name: "Check",
    guide:
      "Pで決めた期待や判断基準と、Dで記録した事実を比べると何が分かりますか？うまくいった点・いかなかった点と、理由として考えられることを根拠とともに振り返りましょう。",
    placeholder:
      "例：目標の「5日中3日以上」は達成した。30分取り組めた3日はすべて午前中に完了した一方、15分で中断した日とメールを先に開いた日は完了しなかった。メールを開く前に、中断なく30分確保することが有効そうだ。",
  },
  action: {
    short: "A",
    name: "Action",
    guide:
      "Cで得た学びを踏まえ、次のサイクルで何を続け、変え、またはやめますか？実行方法と、次回どう確かめるかを具体的に決めましょう。",
    placeholder:
      "例：メールを開く前の30分を継続し、途中で中断しないよう通知を切る。次の5日間、30分確保できた日数と午前中に完了できた日数を記録し、4日以上の完了を目指す。",
  },
};
