import { describe, expect, it } from "vitest";

import { isValidLocalDate } from "./localDate";

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
});
