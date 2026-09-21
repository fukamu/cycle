import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRoot } from "./AppRoot";
import { reactRootErrorOptions } from "./reactRootErrorReporter";
import { preloadCurrentRouteModule } from "./routeModules";

export function mountApplication(container: Element) {
  preloadCurrentRouteModule();
  const root = createRoot(container, reactRootErrorOptions);
  root.render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
  return root;
}
