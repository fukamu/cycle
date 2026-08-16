import { retryDelay } from "./useAutoSave";

describe("retryDelay", () => {
  it("uses bounded exponential backoff with jitter", () => {
    expect(retryDelay(1, () => 0.5)).toBe(1000);
    expect(retryDelay(2, () => 0.5)).toBe(2000);
    expect(retryDelay(6, () => 0.5)).toBe(30_000);
    expect(retryDelay(10, () => 0.5)).toBe(30_000);
  });
});
