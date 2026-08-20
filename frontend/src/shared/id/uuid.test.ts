import { describe, expect, it } from "vitest";

import { isUUIDv7, newUUIDv7 } from "./uuid";

describe("UUID v7", () => {
  it("encodes the millisecond timestamp with the v7 version and RFC variant", () => {
    const timestamp = Date.UTC(2026, 7, 20, 12, 34, 56, 789);
    const id = newUUIDv7(timestamp);

    expect(isUUIDv7(id)).toBe(true);
    expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(
      timestamp,
    );
  });

  it("rejects other UUID versions and non-canonical strings", () => {
    expect(isUUIDv7("123e4567-e89b-42d3-a456-426614174000")).toBe(false);
    expect(isUUIDv7("0198C20B-7B95-7000-8000-000000000001")).toBe(false);
  });
});
