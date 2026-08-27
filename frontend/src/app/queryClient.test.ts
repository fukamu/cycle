import { APIError, SessionIdentityError } from "../shared/api/client";
import { shouldRetryQuery } from "./queryClient";

const requestId = "00000000-0000-7000-8000-000000000001";

describe("query retry policy", () => {
  it.each([
    "SESSION_IDENTITY_STALE",
    "SESSION_IDENTITY_DRIFT",
    "SESSION_IDENTITY_UNVERIFIED",
  ] as const)("does not retry %s", (reason) => {
    expect(shouldRetryQuery(0, new SessionIdentityError(reason))).toBe(false);
  });

  it.each([
    [401, "SESSION_MISSING"],
    [401, "SESSION_EXPIRED"],
    [403, "CSRF_INVALID"],
  ] as const)(
    "does not retry the exact %i %s boundary error",
    (status, code) => {
      expect(
        shouldRetryQuery(0, new APIError(status, code, "private", requestId)),
      ).toBe(false);
    },
  );

  it("does not branch on a stable code without its exact status", () => {
    expect(
      shouldRetryQuery(
        0,
        new APIError(500, "SESSION_EXPIRED", "private", requestId),
      ),
    ).toBe(true);
    expect(
      shouldRetryQuery(
        0,
        new APIError(401, "CSRF_INVALID", "private", requestId),
      ),
    ).toBe(true);
  });

  it("retains two retries for ordinary failures", () => {
    const error = new Error("ordinary network failure");

    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(true);
    expect(shouldRetryQuery(2, error)).toBe(false);
  });
});
