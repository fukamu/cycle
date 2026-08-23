const mainMocks = vi.hoisted(() => ({
  mountApplication: vi.fn(),
}));

vi.mock("./app/mountApplication", () => ({
  mountApplication: mainMocks.mountApplication,
}));

describe("production main", () => {
  it("mounts through the guarded application root", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();

    await import("./main");

    expect(mainMocks.mountApplication).toHaveBeenCalledOnce();
    expect(mainMocks.mountApplication).toHaveBeenCalledWith(
      document.getElementById("root"),
    );
  });
});
