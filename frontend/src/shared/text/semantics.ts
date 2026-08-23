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

export function normalizeBoundedTextInput(
  value: string,
  maximumCodePoints: number,
): string | null {
  const normalized = normalizeLineEndings(value);
  return isWithinCodePointLimit(normalized, maximumCodePoints)
    ? normalized
    : null;
}

export function textDiffersAfterLineEndingNormalization(
  left: string,
  right: string,
): boolean {
  return normalizeLineEndings(left) !== normalizeLineEndings(right);
}
