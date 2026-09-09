export const GOAL_TEXT_MAX_CODE_POINTS = 80;
export const FRAME_TEXT_MAX_CODE_POINTS = 200;

const nonUnicodeWhiteSpace = /[^\p{White_Space}]/u;

export function codePointCount(value: string): number {
  return Array.from(value).length;
}

export function isWithinCodePointLimit(
  value: string,
  maximumCodePoints: number,
): boolean {
  return codePointCount(value) <= maximumCodePoints;
}

export function hasNoNUL(value: string): boolean {
  return !value.includes("\0");
}

export function hasNonWhitespace(value: string): boolean {
  return nonUnicodeWhiteSpace.test(value);
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export type BoundedTextInputEvaluation =
  | {
      readonly kind: "accepted";
      readonly value: string;
      readonly requiredCodePoints: number;
      readonly maximumCodePoints: number;
    }
  | {
      readonly kind: "rejected";
      readonly requiredCodePoints: number;
      readonly maximumCodePoints: number;
      readonly excessCodePoints: number;
    };

export function evaluateBoundedTextInput(
  value: string,
  maximumCodePoints: number,
): BoundedTextInputEvaluation {
  const normalized = normalizeLineEndings(value);
  const requiredCodePoints = codePointCount(normalized);
  return requiredCodePoints <= maximumCodePoints
    ? {
        kind: "accepted",
        value: normalized,
        requiredCodePoints,
        maximumCodePoints,
      }
    : {
        kind: "rejected",
        requiredCodePoints,
        maximumCodePoints,
        excessCodePoints: requiredCodePoints - maximumCodePoints,
      };
}

export function normalizeBoundedTextInput(
  value: string,
  maximumCodePoints: number,
): string | null {
  const result = evaluateBoundedTextInput(value, maximumCodePoints);
  return result.kind === "accepted" ? result.value : null;
}

export function textDiffersAfterLineEndingNormalization(
  left: string,
  right: string,
): boolean {
  return normalizeLineEndings(left) !== normalizeLineEndings(right);
}
