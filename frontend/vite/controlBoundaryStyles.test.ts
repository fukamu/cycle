/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const applicationStyles = readFileSync(resolve(root, "src/styles.css"), "utf8");
const betaAdmissionStyles = readFileSync(
  resolve(root, "src/features/beta-admission/BetaAdmissionGate.css"),
  "utf8",
);

type CssBlock = Readonly<{ prelude: string; body: string }>;

function directBlocks(source: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const openingBrace = source.indexOf("{", cursor);
    if (openingBrace < 0) break;
    const prelude = source.slice(cursor, openingBrace).trim();
    let depth = 1;
    let closingBrace = openingBrace + 1;
    while (closingBrace < source.length && depth > 0) {
      if (source[closingBrace] === "{") depth += 1;
      else if (source[closingBrace] === "}") depth -= 1;
      closingBrace += 1;
    }
    if (depth !== 0) throw new Error(`unterminated CSS block: ${prelude}`);
    blocks.push({
      prelude,
      body: source.slice(openingBrace + 1, closingBrace - 1),
    });
    cursor = closingBrace;
  }
  return blocks;
}

function normalizedSelectors(prelude: string): string[] {
  return prelude
    .split(",")
    .map((selector) => selector.trim().replace(/\s+/g, " "))
    .sort();
}

function ruleBody(source: string, selectors: readonly string[]): string {
  const expected = [...selectors].sort();
  const rule = directBlocks(source).find(
    ({ prelude }) =>
      normalizedSelectors(prelude).join("\n") === expected.join("\n"),
  );
  expect(rule, `missing CSS rule: ${selectors.join(", ")}`).toBeDefined();
  return rule?.body ?? "";
}

describe("control boundary styles", () => {
  it("uses the established brand boundary for white form controls and secondary actions", () => {
    expect(
      ruleBody(applicationStyles, [".button--secondary", ".secondary-button"]),
    ).toContain("border-color: var(--brand);");
    expect(ruleBody(applicationStyles, ["textarea"])).toContain(
      "border: 1px solid var(--brand);",
    );
    expect(ruleBody(betaAdmissionStyles, [".beta-admission input"])).toContain(
      "border: 1px solid var(--brand);",
    );
  });

  it("keeps compact Core Loop text actions at a minimum 44px touch target", () => {
    expect(ruleBody(applicationStyles, [".history-link"])).toContain(
      "min-height: 44px;",
    );
    expect(
      ruleBody(applicationStyles, [".danger-link", ".text-button"]),
    ).toContain("min-height: 44px;");
    expect(ruleBody(applicationStyles, [".touch-target"])).toContain(
      "min-height: 44px;",
    );
    const inlineTarget = ruleBody(applicationStyles, [".touch-target--inline"]);
    expect(inlineTarget).toContain("display: inline-flex;");
    expect(inlineTarget).toContain("align-items: center;");
  });
});
