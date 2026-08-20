import type { HtmlTagDescriptor, Plugin } from "vite";

export type DeploymentEnvironment = "staging" | "production" | undefined;

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
    name: "pdcai-search-indexing",
    transformIndexHtml: () => searchIndexingTags(environment),
  };
}
