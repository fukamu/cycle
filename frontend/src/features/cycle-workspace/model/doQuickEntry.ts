import {
  codePointCount,
  FRAME_TEXT_MAX_CODE_POINTS,
} from "../../../shared/text/semantics";

type BrowserLocalDateSource = Pick<
  Date,
  | "getFullYear"
  | "getMonth"
  | "getDate"
  | "getHours"
  | "getMinutes"
  | "getTimezoneOffset"
>;

export type DoQuickEntryResult =
  | {
      readonly kind: "ready";
      readonly header: string;
      readonly content: string;
      readonly codePointCount: number;
    }
  | {
      readonly kind: "too-long";
      readonly requiredCodePoints: number;
      readonly excessCodePoints: number;
    };

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function formatDoQuickEntryHeader(
  localDate: BrowserLocalDateSource,
): string {
  const offsetMinutes = -localDate.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainingMinutes = absoluteOffsetMinutes % 60;

  return `【${pad(localDate.getFullYear(), 4)}/${pad(localDate.getMonth() + 1, 2)}/${pad(localDate.getDate(), 2)} ${pad(localDate.getHours(), 2)}:${pad(localDate.getMinutes(), 2)} UTC${offsetSign}${pad(offsetHours, 2)}:${pad(offsetRemainingMinutes, 2)}】`;
}

export function createDoQuickEntry(
  currentContent: string,
  localDate: BrowserLocalDateSource,
): DoQuickEntryResult {
  const header = formatDoQuickEntryHeader(localDate);
  const content =
    currentContent.length === 0
      ? `${header}\n`
      : `${currentContent}\n\n${header}\n`;
  const nextCodePointCount = codePointCount(content);
  if (nextCodePointCount > FRAME_TEXT_MAX_CODE_POINTS) {
    return {
      kind: "too-long",
      requiredCodePoints: nextCodePointCount,
      excessCodePoints: nextCodePointCount - FRAME_TEXT_MAX_CODE_POINTS,
    };
  }
  return {
    kind: "ready",
    header,
    content,
    codePointCount: nextCodePointCount,
  };
}
