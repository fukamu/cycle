import { textCounterCopy } from "../copy/ja";

type TextCounterProps = {
  readonly subject: string;
  readonly count: number;
  readonly limit: number;
  readonly invalid?: boolean;
};

export function TextCounter({
  subject,
  count,
  limit,
  invalid = false,
}: TextCounterProps) {
  return (
    <span
      className={invalid ? "counter counter--error" : "counter"}
      role="status"
      aria-live="off"
      aria-label={textCounterCopy.accessible(subject, count, limit)}
    >
      {textCounterCopy.visible(count, limit)}
    </span>
  );
}
