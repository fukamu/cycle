import { createDoQuickEntry, formatDoQuickEntryHeader } from "./doQuickEntry";

function localDate({
  year = 2026,
  month = 8,
  day = 8,
  hour = 9,
  minute = 7,
  timezoneOffset = -540,
}: {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly timezoneOffset?: number;
} = {}) {
  return {
    getFullYear: () => year,
    getMonth: () => month - 1,
    getDate: () => day,
    getHours: () => hour,
    getMinutes: () => minute,
    getTimezoneOffset: () => timezoneOffset,
  };
}

describe("Do quick entry", () => {
  it("formats the browser-local date with the offset at that instant", () => {
    expect(formatDoQuickEntryHeader(localDate())).toBe(
      "【2026/08/08 09:07 UTC+09:00】",
    );
    expect(
      formatDoQuickEntryHeader(
        localDate({
          year: 2027,
          month: 1,
          day: 2,
          hour: 3,
          minute: 4,
          timezoneOffset: 330,
        }),
      ),
    ).toBe("【2027/01/02 03:04 UTC-05:30】");
  });

  it("uses each instant's numeric offset so daylight-saving changes are visible", () => {
    const winter = formatDoQuickEntryHeader(localDate({ timezoneOffset: 300 }));
    const summer = formatDoQuickEntryHeader(localDate({ timezoneOffset: 240 }));

    expect(winter.endsWith("UTC-05:00】")).toBe(true);
    expect(summer.endsWith("UTC-04:00】")).toBe(true);
  });

  it("adds a header and trailing newline to an empty D", () => {
    expect(createDoQuickEntry("", localDate())).toEqual({
      kind: "ready",
      header: "【2026/08/08 09:07 UTC+09:00】",
      content: "【2026/08/08 09:07 UTC+09:00】\n",
      codePointCount: 29,
    });
  });

  it("preserves every existing character and adds an exact blank-line separator", () => {
    const current = "  実行したこと\n末尾の空白 \t\n";

    expect(createDoQuickEntry(current, localDate())).toEqual({
      kind: "ready",
      header: "【2026/08/08 09:07 UTC+09:00】",
      content: `${current}\n\n【2026/08/08 09:07 UTC+09:00】\n`,
      codePointCount: Array.from(
        `${current}\n\n【2026/08/08 09:07 UTC+09:00】\n`,
      ).length,
    });
  });

  it("accepts exactly 200 code points including non-BMP content", () => {
    const headerAndSeparators = 31;
    const current = "😀".repeat(200 - headerAndSeparators);

    expect(createDoQuickEntry(current, localDate())).toMatchObject({
      kind: "ready",
      codePointCount: 200,
    });
  });

  it("reports the required and excess code points without returning changed content", () => {
    const headerAndSeparators = 31;
    const current = "😀".repeat(201 - headerAndSeparators);

    expect(createDoQuickEntry(current, localDate())).toEqual({
      kind: "too-long",
      requiredCodePoints: 201,
      excessCodePoints: 1,
    });
  });
});
