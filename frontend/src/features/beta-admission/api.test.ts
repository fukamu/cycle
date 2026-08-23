import { redeemBetaInvite } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("beta admission API", () => {
  it("uses the dedicated no-store public transport", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(redeemBetaInvite("invite-token")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, request] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/__beta/admission/redeem");
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(request?.body).toBe(JSON.stringify({ token: "invite-token" }));
  });
});
