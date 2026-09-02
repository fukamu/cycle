const safeRouteModuleLoadMessage = "Route module loading failed.";

/**
 * A safe application-owned replacement for a rejected dynamic import.
 *
 * The original rejection is intentionally not retained as a cause or field:
 * browser import errors can contain deployment URLs and raw transport details.
 */
export class RouteModuleLoadError extends Error {
  constructor() {
    super(safeRouteModuleLoadMessage);
    this.name = "RouteModuleLoadError";
  }
}

export function isRouteModuleLoadError(
  error: unknown,
): error is RouteModuleLoadError {
  return error instanceof RouteModuleLoadError;
}

export async function loadRouteModule<Module, RouteComponent>(
  load: () => Promise<Module>,
  select: (module: Module) => RouteComponent,
): Promise<{ readonly default: RouteComponent }> {
  let routeModule: Module;
  try {
    routeModule = await load();
  } catch {
    throw new RouteModuleLoadError();
  }

  // Keep an invalid route export or selector bug classified as a normal render
  // failure. Only transport/module-map rejection needs the reload recovery path.
  return { default: select(routeModule) };
}
