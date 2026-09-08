import type { Frame } from "../../shared/api/schemas";
import { frameCopy } from "../../shared/copy/ja";

type FrameValues = Readonly<Record<Frame, string>>;

export function CycleCompletionSummary({
  goalVersionNumber,
  cycleSequenceNumber,
  goalBody,
  values,
  onEdit,
}: {
  readonly goalVersionNumber: number;
  readonly cycleSequenceNumber: number;
  readonly goalBody: string;
  readonly values: FrameValues;
  readonly onEdit: (frame: Frame) => void;
}) {
  const frames: readonly Frame[] = ["plan", "do", "check", "action"];

  return (
    <div className="cycle-completion-summary">
      <p className="cycle-completion-summary__context">
        Goal v{goalVersionNumber} · Cycle {cycleSequenceNumber}
      </p>
      <section className="cycle-completion-summary__goal">
        <h3>目標</h3>
        <p>{goalBody}</p>
      </section>
      <div className="cycle-completion-summary__frames">
        {frames.map((frame) => (
          <section className="cycle-completion-summary__frame" key={frame}>
            <div className="cycle-completion-summary__frame-heading">
              <h3>
                {frameCopy[frame].label} — {frameCopy[frame].name}
              </h3>
              <button
                className="button button--secondary cycle-completion-summary__edit"
                type="button"
                aria-label={`${frameCopy[frame].label}を編集`}
                onClick={() => onEdit(frame)}
              >
                編集
              </button>
            </div>
            <p>{values[frame]}</p>
          </section>
        ))}
      </div>
      <p className="cycle-completion-summary__warning">
        完了後はP/D/C/Aを編集できません。目標の見直しへ進みます。
      </p>
    </div>
  );
}
