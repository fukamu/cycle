/// <reference types="node" />

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bundleRoot = resolve(repositoryRoot, "vendor/fukamu-design-tokens/0.1.0");
const manifestPath = join(bundleRoot, "manifest.json");
const applicationStyles = readFileSync(
  resolve(repositoryRoot, "frontend/src/styles.css"),
  "utf8",
);
const typographyStyles = readFileSync(
  resolve(repositoryRoot, "frontend/src/shared/typography/tokens.css"),
  "utf8",
);
const appReferralStyles = readFileSync(
  resolve(
    repositoryRoot,
    "frontend/src/features/app-referral/AppReferralPromotion.css",
  ),
  "utf8",
);

const expectedArtifactPaths = [
  "css/tokens.css",
  "figma/mapping.json",
  "js/index.cjs",
  "js/index.mjs",
  "json/tokens.json",
  "reference/tokens.md",
  "types/index.d.ts",
] as const;

type BundleManifest = Readonly<{
  schemaVersion: number;
  packageName: string;
  contractVersion: string;
  sourceRevision: string;
  mode: string;
  handEdited: boolean;
  artifacts: ReadonlyArray<
    Readonly<{
      path: string;
      sha256: string;
    }>
  >;
}>;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bundleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      expect(
        entry.isSymbolicLink(),
        `${entry.name} must not be a symlink`,
      ).toBe(false);
      const absolutePath = join(directory, entry.name);
      return entry.isDirectory()
        ? bundleFiles(absolutePath)
        : [relative(bundleRoot, absolutePath).split(sep).join("/")];
    })
    .sort();
}

function ruleBodies(styles: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(
    styles.matchAll(
      new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{([^{}]*)\\}`, "g"),
    ),
  );
  expect(matches.length, `${selector} must have a flat rule`).toBeGreaterThan(
    0,
  );
  return matches.map((match) => match[1]);
}

describe("shared design-token contract", () => {
  it("vendors the complete immutable 0.1.0 bundle from the approved source", () => {
    expect(sha256(manifestPath)).toBe(
      "5c7e8e90873e5581fb70e7676cb5935092fa3a517f46b3a98360c411d7633915",
    );

    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as BundleManifest;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      packageName: "@fukamu/design-tokens",
      contractVersion: "0.1.0",
      sourceRevision: "b57d1531f26c14e2f1f82440b9f150a3a185bd16",
      mode: "light",
      handEdited: false,
    });
    expect(manifest.artifacts.map(({ path }) => path)).toEqual(
      expectedArtifactPaths,
    );
    expect(bundleFiles(bundleRoot)).toEqual(
      [...expectedArtifactPaths, "manifest.json"].sort(),
    );

    for (const artifact of manifest.artifacts) {
      expect(artifact.path).toMatch(/^[a-z0-9][a-z0-9./-]*$/);
      expect(artifact.path.split("/")).not.toContain("..");
      expect(sha256(resolve(bundleRoot, artifact.path))).toBe(artifact.sha256);
    }
  });

  it("loads generated root variables before Cycle mappings without global UI rules", () => {
    const vendorImport =
      '@import "../../vendor/fukamu-design-tokens/0.1.0/css/tokens.css";';
    const typographyImport = '@import "./shared/typography/tokens.css";';
    expect(applicationStyles.indexOf(vendorImport)).toBe(0);
    expect(applicationStyles.indexOf(typographyImport)).toBeGreaterThan(
      applicationStyles.indexOf(vendorImport),
    );
    expect(applicationStyles.indexOf(":root {")).toBeGreaterThan(
      applicationStyles.indexOf(typographyImport),
    );

    const sharedStyles = readFileSync(
      join(bundleRoot, "css/tokens.css"),
      "utf8",
    );
    const uncommentedStyles = sharedStyles
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    const rootRule = /^:root\s*\{([^{}]*)\}$/.exec(uncommentedStyles);
    expect(
      rootRule,
      "generated CSS must contain one flat :root rule and no at-rules or UI selectors",
    ).not.toBeNull();

    const rootBody = rootRule?.[1] ?? "";
    expect(rootBody.trimEnd()).toMatch(/;$/);
    const declarations = rootBody
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(declaration).toMatch(/^--fukamu-[a-z0-9-]+:\s*[\s\S]+$/);
    }
  });

  it("maps only approved common roles and keeps Cycle-owned residuals", () => {
    for (const mapping of [
      "--ink: var(--fukamu-color-text-primary);",
      "--muted: var(--fukamu-color-text-secondary);",
      "--paper: var(--fukamu-color-surface-default);",
      "--line: var(--fukamu-color-border-default);",
      "--line-strong: var(--fukamu-color-border-strong);",
      "--brand-soft: var(--fukamu-color-surface-subtle);",
      "--brand: var(--fukamu-color-accent);",
      "--accent: var(--fukamu-color-accent);",
      "--brand-dark: var(--fukamu-color-action-primary);",
      "--action-primary-hover: var(--fukamu-color-action-primary-hover);",
      "--action-on-primary: var(--fukamu-color-action-on-primary);",
      "--danger: var(--fukamu-color-status-danger-foreground);",
      "--danger-dark: var(--fukamu-color-status-danger-strong);",
      "--danger-soft: var(--fukamu-color-status-danger-surface);",
      "--danger-border: var(--fukamu-color-status-danger-border);",
      "--warning: var(--fukamu-color-status-warning-foreground);",
      "--warning-soft: var(--fukamu-color-status-warning-surface);",
      "--warning-border: var(--fukamu-color-status-warning-border);",
      "--success: var(--fukamu-color-status-success-foreground);",
      "--success-soft: var(--fukamu-color-status-success-surface);",
      "--focus: var(--fukamu-color-focus-ring);",
    ]) {
      expect(applicationStyles).toContain(mapping);
    }

    for (const mapping of [
      "--font-family-body-ja: var(--fukamu-font-family-body-ja);",
      "--font-size-small: var(--fukamu-font-size-small);",
      "--font-size-body: var(--fukamu-font-size-body);",
      "--font-size-editor: var(--fukamu-font-size-editor);",
      "--font-weight-regular: var(--fukamu-font-weight-regular);",
      "--font-weight-medium: var(--fukamu-font-weight-semibold);",
      "--font-weight-bold: var(--fukamu-font-weight-bold);",
      "--line-height-ui: var(--fukamu-font-line-height-ui);",
      "--line-height-body-ja: var(--fukamu-font-line-height-body-ja);",
      "--line-height-editor-ja: var(--fukamu-font-line-height-editor);",
    ]) {
      expect(typographyStyles).toContain(mapping);
    }
    expect(typographyStyles).not.toContain(
      "--font-weight-medium: var(--fukamu-font-weight-medium);",
    );

    for (const residual of [
      "--canvas: #f7faff;",
      "--brand-light: #d6e9ff;",
      "--brand-text: #0d3b8e;",
      "--brand-deep: #082b69;",
      "--font-size-title: clamp(1.25rem, 4vw, 1.75rem);",
      "--shadow-raised: 0 20px 52px rgb(13 59 142 / 14%);",
      "--timeline-rail-color: var(--line);",
      "--timeline-event-fill: var(--paper);",
    ]) {
      expect(`${applicationStyles}\n${typographyStyles}`).toContain(residual);
    }

    for (const selector of [
      ".wordmark",
      ".drawer__current",
      ".eyebrow",
      ".section-heading span",
      ".goal-card__kicker",
      ".goal-card__status",
      ".first-use-guide__location",
      ".first-use-guide-pending",
      ".frame-template__preview > span",
      ".goal-context__label",
      ".save-status--saved",
      ".review-draft-comparison",
      '.next-cycle-note[data-review-draft="same"]',
      ".frame-title span",
      ".cycle-previous-action-reference__heading span",
      ".cycle-previous-action-reference__metadata",
      ".cycle-check-comparison__item h4 span",
      ".cycle-summary h3",
      ".review-decision-context__learning h3",
      ".timeline-learning-preview__frame h3",
      ".settings-message",
      ".cycle-completion-summary__context",
    ]) {
      const bodies = ruleBodies(applicationStyles, selector);
      expect(
        bodies.some((body) => body.includes("color: var(--brand-text);")),
        `${selector} must retain Cycle-owned brand text`,
      ).toBe(true);
      expect(
        bodies.every((body) => !body.includes("var(--brand-dark)")),
        `${selector} must not inherit action semantics`,
      ).toBe(true);
    }

    const referralStatus = ruleBodies(
      appReferralStyles,
      ".app-referral__status",
    );
    expect(
      referralStatus.some((body) => body.includes("color: var(--brand-text);")),
    ).toBe(true);
    expect(
      referralStatus.every((body) => !body.includes("var(--brand-dark)")),
    ).toBe(true);

    const textareaFocus = ruleBodies(
      applicationStyles,
      "textarea:focus-visible",
    );
    expect(
      textareaFocus.some((body) =>
        body.includes("border-color: var(--focus);"),
      ),
    ).toBe(true);
    expect(
      textareaFocus.every(
        (body) => !body.includes("border-color: var(--brand);"),
      ),
    ).toBe(true);

    const textareaHover = ruleBodies(
      applicationStyles,
      "textarea:hover:not([readonly]):not(:focus-visible)",
    );
    expect(
      textareaHover.some((body) =>
        body.includes("border-color: var(--brand);"),
      ),
    ).toBe(true);
  });
});
