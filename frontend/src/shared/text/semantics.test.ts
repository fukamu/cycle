import {
  codePointCount,
  FRAME_TEXT_MAX_CODE_POINTS,
  GOAL_TEXT_MAX_CODE_POINTS,
  hasNonWhitespace,
  normalizeBoundedTextInput,
  normalizeLineEndings,
  textDiffersAfterLineEndingNormalization,
} from "./semantics";

describe("text semantics", () => {
  it("counts and limits Unicode code points instead of UTF-16 code units", () => {
    expect(codePointCount("改善😀")).toBe(3);
    expect(
      normalizeBoundedTextInput("😀".repeat(80), GOAL_TEXT_MAX_CODE_POINTS),
    ).not.toBeNull();
    expect(
      normalizeBoundedTextInput("😀".repeat(81), GOAL_TEXT_MAX_CODE_POINTS),
    ).toBeNull();
    expect(
      normalizeBoundedTextInput("😀".repeat(200), FRAME_TEXT_MAX_CODE_POINTS),
    ).not.toBeNull();
    expect(
      normalizeBoundedTextInput("😀".repeat(201), FRAME_TEXT_MAX_CODE_POINTS),
    ).toBeNull();
  });

  it("matches Unicode White_Space instead of ECMAScript trim quirks", () => {
    expect(hasNonWhitespace("")).toBe(false);
    expect(hasNonWhitespace("\u0085")).toBe(false);
    expect(hasNonWhitespace(" \t\n")).toBe(false);
    expect(hasNonWhitespace("\uFEFF")).toBe(true);
  });

  it("normalizes CRLF and lone CR while preserving surrounding whitespace", () => {
    const input = "\t一行目\r\n二行目\r三行目 \t";
    expect(normalizeLineEndings(input)).toBe("\t一行目\n二行目\n三行目 \t");
    expect(normalizeBoundedTextInput(input, 80)).toBe(
      "\t一行目\n二行目\n三行目 \t",
    );
  });

  it("compares normalized line endings exactly without trimming", () => {
    expect(
      textDiffersAfterLineEndingNormalization("a\r\nb\rc", "a\nb\nc"),
    ).toBe(false);
    expect(textDiffersAfterLineEndingNormalization("a\n", "a\n ")).toBe(true);
  });
});
