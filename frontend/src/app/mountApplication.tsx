import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRoot } from "./AppRoot";
import { reactRootErrorOptions } from "./reactRootErrorReporter";

export function mountApplication(container: Element) {
  const root = createRoot(container, reactRootErrorOptions);
  root.render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
  return root;
}
