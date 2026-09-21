import { expect, test } from "@playwright/test";

test("shared token mappings preserve Cycle light computed styles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  const computed = await page.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.setAttribute("aria-label", "design token fixture");
    fixture.innerHTML = `
      <button id="token-primary" class="button button--primary">Primary</button>
      <p id="token-danger" class="inline-error">Danger</p>
      <p id="token-warning" class="limit-notice">Warning</p>
      <p id="token-success" class="status status--achieved">Success</p>
      <p id="token-brand-text" class="eyebrow">Brand text</p>
      <textarea id="token-editor" aria-label="Token editor"></textarea>
      <div class="timeline-period">
        <span id="token-past-rail" class="timeline-period__rail"></span>
      </div>
      <div class="timeline-period" data-version-state="current">
        <span id="token-current-rail" class="timeline-period__rail"></span>
      </div>
    `;
    document.body.append(fixture);

    const style = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement))
        throw new Error(`missing token fixture: ${selector}`);
      return window.getComputedStyle(element);
    };
    const body = window.getComputedStyle(document.body);
    const primary = style("#token-primary");
    const danger = style("#token-danger");
    const warning = style("#token-warning");
    const success = style("#token-success");
    const editor = style("#token-editor");

    return {
      lang: document.documentElement.lang,
      colorScheme: window.getComputedStyle(document.documentElement)
        .colorScheme,
      body: {
        color: body.color,
        backgroundColor: body.backgroundColor,
        fontFamily: body.fontFamily,
        fontSize: body.fontSize,
        lineHeight: body.lineHeight,
      },
      primary: {
        color: primary.color,
        backgroundColor: primary.backgroundColor,
        fontWeight: primary.fontWeight,
        lineHeight: primary.lineHeight,
        minHeight: primary.minHeight,
      },
      danger: {
        color: danger.color,
        backgroundColor: danger.backgroundColor,
        borderColor: danger.borderColor,
      },
      warning: {
        color: warning.color,
        backgroundColor: warning.backgroundColor,
        borderColor: warning.borderColor,
      },
      success: {
        color: success.color,
        backgroundColor: success.backgroundColor,
      },
      brandText: style("#token-brand-text").color,
      editor: {
        fontFamily: editor.fontFamily,
        fontSize: editor.fontSize,
        lineHeight: editor.lineHeight,
      },
      timeline: {
        past: style("#token-past-rail").backgroundColor,
        current: style("#token-current-rail").backgroundColor,
      },
    };
  });

  expect(computed).toEqual({
    lang: "ja",
    colorScheme: "light",
    body: {
      color: "rgb(16, 35, 63)",
      backgroundColor: "rgb(247, 250, 255)",
      fontFamily:
        '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif',
      fontSize: "16px",
      lineHeight: "27.2px",
    },
    primary: {
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(13, 59, 142)",
      fontWeight: "600",
      lineHeight: "23.2px",
      minHeight: "44px",
    },
    danger: {
      color: "rgb(180, 35, 58)",
      backgroundColor: "rgb(255, 240, 243)",
      borderColor: "rgb(242, 186, 196)",
    },
    warning: {
      color: "rgb(113, 81, 10)",
      backgroundColor: "rgb(255, 247, 219)",
      borderColor: "rgb(234, 217, 158)",
    },
    success: {
      color: "rgb(7, 93, 85)",
      backgroundColor: "rgb(217, 243, 239)",
    },
    brandText: "rgb(13, 59, 142)",
    editor: {
      fontFamily:
        '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif',
      fontSize: "16px",
      lineHeight: "28px",
    },
    timeline: {
      past: "rgb(204, 218, 236)",
      current: "rgb(74, 144, 226)",
    },
  });

  const primary = page.locator("#token-primary");
  await primary.hover();
  await expect(primary).toHaveCSS("background-color", "rgb(8, 43, 105)");
  await primary.focus();
  await expect(primary).toHaveCSS("outline-color", "rgb(74, 144, 226)");

  const editor = page.locator("#token-editor");
  await editor.evaluate(() => {
    const semanticOverride = new CSSStyleSheet();
    semanticOverride.replaceSync(
      "#token-editor { --brand: #123456; --focus: #abcdef; }",
    );
    document.adoptedStyleSheets = [
      ...document.adoptedStyleSheets,
      semanticOverride,
    ];
  });
  await editor.hover();
  await expect(editor).toHaveCSS("border-color", "rgb(18, 52, 86)");
  await editor.focus();
  expect(
    await editor.evaluate(
      (element) =>
        element.matches(":hover") && element.matches(":focus-visible"),
    ),
  ).toBe(true);
  await expect(editor).toHaveCSS("border-color", "rgb(171, 205, 239)");
  await expect(editor).toHaveCSS("outline-color", "rgb(171, 205, 239)");
});
