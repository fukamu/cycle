import { describe, expect, it } from "vitest";

import {
  parseDeploymentEnvironment,
  searchIndexingTags,
  stagingTurnstileSiteKey,
  validateTurnstileSiteKey,
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

describe("Turnstile build credentials", () => {
  it("requires the approved invisible test sitekey for staging", () => {
    expect(() =>
      validateTurnstileSiteKey("staging", stagingTurnstileSiteKey),
    ).not.toThrow();
    expect(() => validateTurnstileSiteKey("staging", "live-site-key")).toThrow(
      "Staging must use the approved invisible Turnstile test sitekey.",
    );
    expect(() => validateTurnstileSiteKey("staging", undefined)).toThrow(
      "Staging must use the approved invisible Turnstile test sitekey.",
    );
  });

  it("rejects every documented test sitekey from production", () => {
    for (const siteKey of [
      "1x00000000000000000000AA",
      "2x00000000000000000000AB",
      "1x00000000000000000000BB",
      "2x00000000000000000000BB",
      "3x00000000000000000000FF",
      "",
      undefined,
    ]) {
      expect(() => validateTurnstileSiteKey("production", siteKey)).toThrow(
        "Production must use a non-test Turnstile sitekey.",
      );
    }
    expect(() =>
      validateTurnstileSiteKey("production", "live-site-key"),
    ).not.toThrow();
  });

  it("does not constrain local development", () => {
    expect(() => validateTurnstileSiteKey(undefined, undefined)).not.toThrow();
  });
});
