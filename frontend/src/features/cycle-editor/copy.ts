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
    guide: "今回、何を良くしたいですか？そのために何をする予定ですか？",
    placeholder:
      "例：午前中に重要な仕事を終えられるようにしたい。朝一番に最重要タスクを決め、メールを見る前に30分取り組む。",
  },
  do: {
    short: "D",
    name: "Do",
    guide:
      "実際に何をしましたか？予定どおりでなかったことも含めて記録しましょう。",
    placeholder:
      "例：3日間試した。2日間は朝一番に重要タスクへ取り組めたが、1日はメール対応を先に始めてしまった。",
  },
  check: {
    short: "C",
    name: "Check",
    guide:
      "結果はどうでしたか？うまくいったこと・いかなかったことと、その理由を振り返りましょう。",
    placeholder:
      "例：朝一番に取り組めた日は重要タスクが早く終わった。一方、メールを先に開くとそのまま対応に時間を使ってしまった。",
  },
  action: {
    short: "A",
    name: "Action",
    guide:
      "次のサイクルで、具体的に何を変えますか？自分で書くか、AIの支援も利用できます。",
    placeholder: "例：メールを開く前に、最重要タスクへ30分取り組む。",
  },
};
