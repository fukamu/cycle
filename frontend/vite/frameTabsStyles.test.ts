/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
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
      !prelude.startsWith("@") &&
      normalizedSelectors(prelude).join("\n") === expected.join("\n"),
  );
  expect(rule, `missing CSS rule: ${selectors.join(", ")}`).toBeDefined();
  return rule?.body ?? "";
}

function allRuleBodiesForSelector(
  source: string,
  expectedSelector: string,
): string[] {
  return directBlocks(source).flatMap(({ prelude, body }) =>
    prelude.startsWith("@")
      ? allRuleBodiesForSelector(body, expectedSelector)
      : normalizedSelectors(prelude).includes(expectedSelector)
        ? [body]
        : [],
  );
}

describe("frame tab responsive CSS contract", () => {
  it("keeps four compact columns and lets long tab details wrap", () => {
    expect(ruleBody(styles, [".frame-tabs"])).toContain(
      "grid-template-columns: repeat(4, minmax(0, 1fr));",
    );
    expect(ruleBody(styles, [".frame-tabs button"])).toContain("min-width: 0;");
    expect(ruleBody(styles, [".frame-tabs__details"])).toContain(
      "overflow-wrap: anywhere;",
    );
  });

  it("hides only the full name in the fixed mobile navigation", () => {
    const mobile = directBlocks(styles).find(
      ({ prelude }) => prelude === "@media (max-width: 640px)",
    )?.body;
    expect(mobile, "missing mobile media query").toBeDefined();
    const navigation = ruleBody(mobile ?? "", [".frame-tabs"]);
    const hiddenDetails = ruleBody(mobile ?? "", [
      ".frame-tabs__separator",
      ".frame-tabs__name",
    ]);

    expect(navigation).toContain("position: fixed;");
    expect(navigation).toContain("bottom: 0;");
    expect(navigation).toContain("env(safe-area-inset-bottom)");
    expect(hiddenDetails).toContain("display: none;");
    for (const selector of [
      ".frame-tabs",
      ".frame-tabs button",
      ".frame-tabs small",
      ".frame-tabs__details",
      ".frame-tabs__recovery",
    ]) {
      for (const body of allRuleBodiesForSelector(styles, selector))
        expect(body, `${selector} must remain visible`).not.toMatch(
          /display\s*:\s*none\s*;/,
        );
    }
  });
});
