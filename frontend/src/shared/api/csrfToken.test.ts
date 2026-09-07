import { describe, expect, it } from "vitest";

import {
  CSRF_TOKEN_BYTES,
  CSRF_TOKEN_LENGTH,
  isValidCSRFToken,
} from "./csrfToken";

describe("CSRF token format", () => {
  it("accepts canonical paddingless base64url encodings of exactly 32 bytes", () => {
    expect(CSRF_TOKEN_BYTES).toBe(32);
    expect(CSRF_TOKEN_LENGTH).toBe(43);
    expect(isValidCSRFToken("A".repeat(43))).toBe(true);
    expect(isValidCSRFToken("Q".repeat(43))).toBe(true);
    expect(isValidCSRFToken(`${"-_".repeat(21)}w`)).toBe(true);
    expect(isValidCSRFToken(`${"a0".repeat(21)}8`)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["too short", "A".repeat(42)],
    ["too long", "A".repeat(44)],
    ["padding", `${"A".repeat(43)}=`],
    ["standard base64 plus", `${"A".repeat(42)}+`],
    ["standard base64 slash", `${"A".repeat(42)}/`],
    ["whitespace", `${"A".repeat(42)} `],
    ["noncanonical final quantum", `${"A".repeat(42)}B`],
  ])("rejects %s", (_name, token) => {
    expect(isValidCSRFToken(token)).toBe(false);
  });
});
