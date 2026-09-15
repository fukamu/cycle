import { describe, expect, it } from "vitest";

import {
  browserLocalDate,
  classifyReviewDate,
  isValidLocalDate,
  nextLocalDateRefreshDelay,
} from "./localDate";

describe("local calendar dates", () => {
  it.each(["0001-01-01", "2000-02-29", "2026-09-15", "9999-12-31"])(
    "accepts the exact Gregorian date %s",
    (value) => {
      expect(isValidLocalDate(value)).toBe(true);
    },
  );

  it.each([
    "0000-01-01",
    "10000-01-01",
    "2026-02-29",
    "2026-04-31",
    "2026-9-15",
    "2026-09-15T00:00:00Z",
    "2026-09-15+09:00",
  ])("rejects a non-canonical or invalid date %s", (value) => {
    expect(isValidLocalDate(value)).toBe(false);
  });

  it("uses local calendar fields without converting the saved value to an instant", () => {
    expect(browserLocalDate(new Date(2026, 8, 15, 23, 59, 59))).toBe(
      "2026-09-15",
    );
    expect(browserLocalDate(new Date(2026, 8, 16, 0, 0, 0))).toBe("2026-09-16");
  });

  it("classifies exact dates by canonical local-date ordering", () => {
    expect(classifyReviewDate("2026-09-14", "2026-09-15")).toBe("overdue");
    expect(classifyReviewDate("2026-09-15", "2026-09-15")).toBe("today");
    expect(classifyReviewDate("2026-09-16", "2026-09-15")).toBe("upcoming");
  });

  it("rechecks at the next local midnight and caps clock/timezone drift detection", () => {
    expect(nextLocalDateRefreshDelay(new Date(2026, 8, 15, 23, 59, 59))).toBe(
      1000,
    );
    expect(nextLocalDateRefreshDelay(new Date(2026, 8, 15, 12, 0, 0))).toBe(
      60 * 60 * 1000,
    );
  });
});
