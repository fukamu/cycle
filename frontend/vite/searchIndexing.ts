import type { HtmlTagDescriptor, Plugin } from "vite";

export type DeploymentEnvironment = "staging" | "production" | undefined;

export const stagingTurnstileSiteKey = "1x00000000000000000000BB";

const officialTurnstileTestSiteKeys = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  stagingTurnstileSiteKey,
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);

export function parseDeploymentEnvironment(
  value: string | undefined,
): DeploymentEnvironment {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  if (normalized === "staging" || normalized === "production") {
    return normalized;
  }

  throw new Error(
    "VITE_DEPLOYMENT_ENV must be either 'staging' or 'production' when set.",
  );
}

export function validateTurnstileSiteKey(
  deploymentEnvironment: DeploymentEnvironment,
  siteKey: string | undefined,
): void {
  if (deploymentEnvironment === undefined) return;

  const normalizedSiteKey = siteKey?.trim() ?? "";
  if (deploymentEnvironment === "staging") {
    if (normalizedSiteKey !== stagingTurnstileSiteKey) {
      throw new Error(
        "Staging must use the approved invisible Turnstile test sitekey.",
      );
    }
    return;
  }

  if (
    normalizedSiteKey === "" ||
    officialTurnstileTestSiteKeys.has(normalizedSiteKey)
  ) {
    throw new Error("Production must use a non-test Turnstile sitekey.");
  }
}

export function searchIndexingTags(
  environment: DeploymentEnvironment,
): HtmlTagDescriptor[] {
  if (environment !== "staging") return [];

  return [
    {
      tag: "meta",
      attrs: {
        name: "robots",
        content: "noindex, nofollow",
      },
      injectTo: "head",
    },
  ];
}

export function searchIndexingPlugin(
  environment: DeploymentEnvironment,
): Plugin {
  return {
    name: "fukamu-cycle-search-indexing",
    transformIndexHtml: () => searchIndexingTags(environment),
  };
}
