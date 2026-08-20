describe("Closed Beta invite fragment", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.resetModules();
  });

  it("captures the token in memory and removes it from the address", async () => {
    window.history.replaceState(
      null,
      "",
      `/?source=invite#beta-invite=${encodeURIComponent("pdcai_beta_token")}&campaign=closed`,
    );
    vi.resetModules();

    const fragment = await import("./inviteFragment");

    expect(fragment.getInitialBetaInviteToken()).toBe("pdcai_beta_token");
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe("/?source=invite#campaign=closed");
    fragment.clearInitialBetaInviteToken();
    expect(fragment.getInitialBetaInviteToken()).toBe("");
  });
});
