import { afterEach, describe, expect, it, vi } from "vitest";

import { generateAction } from "./cycles";

const successPayload = {
  generationId: "00000000-0000-4000-8000-000000000010",
  action: "1. 次の行動",
  contentRevision: 4,
  actionRevision: 1,
  contextChanged: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI API idempotency", () => {
  it("reuses one idempotency key for a network retry", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(successPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateAction("00000000-0000-4000-8000-000000000001", 3, false, "csrf"),
    ).resolves.toEqual(successPayload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secondHeaders.get("Idempotency-Key")).toBe(
      firstHeaders.get("Idempotency-Key"),
    );
  });
});
