import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteAccount } from "./account";

afterEach(() => vi.unstubAllGlobals());

describe("account API", () => {
  it("accepts an empty 204 delete response and sends confirmation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteAccount("csrf-token")).resolves.toBeUndefined();

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.method).toBe("DELETE");
    expect(new Headers(request?.headers).get("X-CSRF-Token")).toBe(
      "csrf-token",
    );
    expect(request?.body).toBe(JSON.stringify({ confirmed: true }));
  });
});
