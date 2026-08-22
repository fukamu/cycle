import { APIError } from "../api/client";
import {
  autoSaveRetryDelay,
  isRetryableAutoSaveError,
  maxAutoSaveRetries,
} from "./autoSavePolicy";

describe("auto save policy", () => {
  it("uses the specified exponential backoff with bounded jitter", () => {
    expect(maxAutoSaveRetries).toBe(5);
    expect(autoSaveRetryDelay(1, () => 0)).toBe(800);
    expect(autoSaveRetryDelay(3, () => 0.5)).toBe(4_000);
    expect(autoSaveRetryDelay(5, () => 1)).toBe(19_200);
  });

  it("retries only network, timeout, generic rate limit, and server errors", () => {
    const apiError = (status: number) =>
      new APIError(status, "TEST", "test", "request-id");
    expect(isRetryableAutoSaveError(new TypeError("network"))).toBe(true);
    expect(isRetryableAutoSaveError(apiError(408))).toBe(true);
    expect(isRetryableAutoSaveError(apiError(429))).toBe(true);
    expect(isRetryableAutoSaveError(apiError(503))).toBe(true);
    expect(isRetryableAutoSaveError(apiError(400))).toBe(false);
    expect(isRetryableAutoSaveError(apiError(409))).toBe(false);
    expect(isRetryableAutoSaveError(new Error("schema"))).toBe(false);
  });
});
