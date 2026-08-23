import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteAccount, loginGoogle } from "./account";
import type { AuthenticatedRequestLease } from "./client";

const sourceUserId = "00000000-0000-7000-8000-000000000001";
const targetUserId = "00000000-0000-7000-8000-000000000002";
const lease: AuthenticatedRequestLease = {
  expectedUserId: sourceUserId,
  signal: new AbortController().signal,
  isCurrent: () => true,
};

afterEach(() => vi.unstubAllGlobals());

describe("account API", () => {
  it("accepts an empty 204 delete response and sends confirmation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { "X-Fukamu-Authenticated-User-ID": sourceUserId },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteAccount(lease, "csrf-token")).resolves.toBeUndefined();

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.method).toBe("DELETE");
    expect(request?.cache).toBe("no-store");
    expect(new Headers(request?.headers).get("X-CSRF-Token")).toBe(
      "csrf-token",
    );
    expect(request?.body).toBe(JSON.stringify({ confirmed: true }));
  });

  it("binds Google login to the source user while accepting a target user body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          user: {
            id: targetUserId,
            googleConnected: true,
            googleEmail: "person@example.test",
          },
          csrfToken: "next-csrf",
        },
        {
          headers: { "X-Fukamu-Authenticated-User-ID": sourceUserId },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loginGoogle(lease, "google-id-token", "source-csrf"),
    ).resolves.toMatchObject({ user: { id: targetUserId } });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toMatchObject({ method: "POST", cache: "no-store" });
    expect(new Headers(request?.headers).get("X-CSRF-Token")).toBe(
      "source-csrf",
    );
    expect(request?.body).toBe(JSON.stringify({ idToken: "google-id-token" }));
  });
});
