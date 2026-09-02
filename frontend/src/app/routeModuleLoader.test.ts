import {
  isRouteModuleLoadError,
  loadRouteModule,
  RouteModuleLoadError,
} from "./routeModuleLoader";

describe("loadRouteModule", () => {
  it("selects the route component from a loaded module", async () => {
    const RouteComponent = () => null;

    await expect(
      loadRouteModule(
        async () => ({ RouteComponent }),
        (module) => module.RouteComponent,
      ),
    ).resolves.toEqual({ default: RouteComponent });
  });

  it("replaces a rejected import without retaining its raw details", async () => {
    const rawFailure = Object.assign(
      new Error(
        "https://private-deployment.example/assets/SettingsPage-secret.js",
      ),
      { responseBody: "private upstream body" },
    );

    const failure = await loadRouteModule(
      async () => Promise.reject(rawFailure),
      () => () => null,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RouteModuleLoadError);
    expect(isRouteModuleLoadError(failure)).toBe(true);
    expect(failure).not.toHaveProperty("cause");
    const exposedFailure = `${String(failure)}\n${
      failure instanceof Error ? (failure.stack ?? "") : ""
    }\n${JSON.stringify(failure)}`;
    expect(exposedFailure).not.toContain("private-deployment");
    expect(exposedFailure).not.toContain("SettingsPage-secret");
    expect(exposedFailure).not.toContain("private upstream");
  });

  it("does not classify selector bugs as module load failures", async () => {
    const selectorFailure = new Error("route export is invalid");

    const result = loadRouteModule(
      async () => ({ RouteComponent: () => null }),
      () => {
        throw selectorFailure;
      },
    );

    await expect(result).rejects.toBe(selectorFailure);
  });
});
