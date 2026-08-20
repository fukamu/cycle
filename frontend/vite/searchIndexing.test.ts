import { describe, expect, it } from "vitest";

import {
  parseDeploymentEnvironment,
  searchIndexingTags,
} from "./searchIndexing";

describe("search indexing configuration", () => {
  it("adds noindex and nofollow only for staging", () => {
    expect(searchIndexingTags("staging")).toEqual([
      {
        tag: "meta",
        attrs: {
          name: "robots",
          content: "noindex, nofollow",
        },
        injectTo: "head",
      },
    ]);
    expect(searchIndexingTags("production")).toEqual([]);
    expect(searchIndexingTags(undefined)).toEqual([]);
  });

  it("rejects an unknown deployment environment", () => {
    expect(() => parseDeploymentEnvironment("staginng")).toThrow(
      "VITE_DEPLOYMENT_ENV must be either 'staging' or 'production' when set.",
    );
  });
});
