#!/usr/bin/env node

import GithubSlugger from "github-slugger";
import MarkdownIt from "markdown-it";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

const requiredDocumentationTools = [
  {
    manifestCode: "MARKDOWN_IT_VERSION",
    name: "markdown-it",
    unavailableCode: "MARKDOWN_IT_TOOL_UNAVAILABLE",
    version: "15.0.0",
  },
  {
    manifestCode: "GITHUB_SLUGGER_VERSION",
    name: "github-slugger",
    unavailableCode: "GITHUB_SLUGGER_TOOL_UNAVAILABLE",
    version: "2.0.0",
  },
  {
    manifestCode: "MERMAID_VERSION",
    name: "mermaid",
    unavailableCode: "MERMAID_TOOL_UNAVAILABLE",
    version: "11.16.1",
  },
];
const requiredMermaidVersion = "11.16.1";
const rootArgument = process.argv[2];
const root = resolve(rootArgument ?? "");
const problems = [];
const documents = new Map();
const markdown = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false,
});
// Reference-definition tokens are normally removed before callers see them.
// Keeping them lets this gate validate unused destinations and duplicates with
// the parser's own CommonMark recognition rather than a second regex parser.
markdown.core.ruler.disable("strip_references");

if (
  process.argv.length !== 3 ||
  rootArgument === undefined ||
  rootArgument === ""
) {
  fail("Usage: node ./scripts/check-docs.mjs <repository-root>");
}

const canonicalRoot = await realpath(root).catch(() => null);
if (canonicalRoot === null) fail("Documentation root does not exist.");

const installedTools = await validateDocumentationToolConfiguration();

for (const path of await markdownFiles(canonicalRoot)) {
  const source = normalizeMarkdownSource(await readFile(path, "utf8"));
  documents.set(path, parseDocument(path, source));
}

if (documents.size === 0 && problems.length === 0) {
  fail("No Markdown documents were found.");
}

validateDesignLegacyTrace();

const mermaid = installedTools.has("mermaid") ? await loadMermaid() : null;
if (mermaid !== null) await validateMermaidBlocks(mermaid);

for (const document of documents.values()) {
  for (const link of document.links) await validateTarget(document, link);
}

problems.sort(
  (left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.code.localeCompare(right.code),
);
for (const problem of problems) {
  console.error(
    `${relative(canonicalRoot, problem.file)}:${problem.line}: ${problem.code}: ${problem.message}`,
  );
}
if (problems.length > 0) process.exit(1);

const mermaidCount = [...documents.values()].reduce(
  (count, document) => count + document.mermaidBlocks.length,
  0,
);
console.log(
  `Documentation checks passed for ${documents.size} Markdown files and ${mermaidCount} Mermaid diagrams.`,
);

async function validateDocumentationToolConfiguration() {
  const manifestPath = resolve(canonicalRoot, "package.json");
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    addProblem(
      manifestPath,
      1,
      "DOCUMENTATION_TOOL_CONFIGURATION",
      "root package.json must declare the pinned documentation tools",
    );
  }

  const installed = new Set();
  const requireFromChecker = createRequire(import.meta.url);
  for (const tool of requiredDocumentationTools) {
    if (manifest?.devDependencies?.[tool.name] !== tool.version) {
      addProblem(
        manifestPath,
        1,
        tool.manifestCode,
        `devDependencies.${tool.name} must equal ${tool.version}`,
      );
    }

    try {
      const installedManifestPath = requireFromChecker.resolve(
        `${tool.name}/package.json`,
      );
      const installedManifest = JSON.parse(
        await readFile(installedManifestPath, "utf8"),
      );
      if (installedManifest.version !== tool.version) {
        throw new Error("installed tool version does not match the contract");
      }
      installed.add(tool.name);
    } catch {
      addProblem(
        manifestPath,
        1,
        tool.unavailableCode,
        `Installed ${tool.name} must equal ${tool.version}`,
      );
    }
  }
  return installed;
}

async function markdownFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (extname(entry.name).toLowerCase() === ".md") {
        addProblem(
          path,
          1,
          "SYMLINK_MARKDOWN_NOT_ALLOWED",
          "Markdown files must not be symbolic links",
        );
      }
      continue;
    }
    if (entry.isDirectory()) {
      result.push(...(await markdownFiles(path)));
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      result.push(path);
    }
  }
  return result;
}

function normalizeMarkdownSource(source) {
  return source.replace(/^\uFEFF/, "").replace(/\r\n?|\n/g, "\n");
}

function parseDocument(path, source) {
  const environment = { references: Object.create(null) };
  const tokens = markdown.parse(source, environment);
  const anchors = new Set();
  const links = [];
  const mermaidBlocks = [];
  const referenceLabels = new Set();
  const slugger = new GithubSlugger();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const line = token.map?.[0] + 1 || 1;

    if (token.type === "fence") {
      validateFenceClosure(path, token, line);
      if (fenceLanguage(token.info) === "mermaid") {
        mermaidBlocks.push({ line, source: token.content });
      }
    }

    if (token.type === "heading_open") {
      const inline = tokens[index + 1];
      if (inline?.type === "inline") {
        const heading = inlineText(inline.children ?? []);
        const anchor = slugger.slug(heading);
        if (anchor !== "") anchors.add(anchor);
      }
    }

    if (token.type === "reference_definition") {
      const label = token.meta?.label;
      if (typeof label !== "string" || label === "") {
        addProblem(
          path,
          line,
          "REFERENCE_PARSE_ERROR",
          "Markdown parser returned an invalid reference definition",
        );
      } else if (referenceLabels.has(label)) {
        addProblem(
          path,
          line,
          "DUPLICATE_REFERENCE",
          `reference '${label}' is defined more than once`,
        );
      } else {
        referenceLabels.add(label);
        const reference = environment.references[label];
        if (typeof reference?.href !== "string") {
          addProblem(
            path,
            line,
            "REFERENCE_PARSE_ERROR",
            `reference '${label}' has no parsed destination`,
          );
        } else {
          links.push({ destination: reference.href, line });
        }
      }
    }

    if (token.type === "inline") {
      collectInlineLinks(token.children ?? [], line, links);
      collectInlineHTMLMetadata(token.children ?? [], line, anchors, links);
    } else if (token.type === "html_block") {
      collectHTMLMetadata(token.content, line, anchors, links);
    }
  }

  return { anchors, links, mermaidBlocks, path, source };
}

function validateDesignLegacyTrace() {
  const designPath = resolve(canonicalRoot, "docs/design.md");
  const document = documents.get(designPath);
  if (document === undefined) return;

  const heading = /^## 54\.3 Legacy §0–54 trace[ \t]*$/mu.exec(
    document.source,
  );
  if (heading === null) {
    addProblem(
      designPath,
      1,
      "DESIGN_LEGACY_TRACE_MISSING",
      "docs/design.md must contain the M31 legacy §0–54 trace",
    );
    return;
  }

  const traceSource = document.source.slice(heading.index + heading[0].length);
  const rows = [...traceSource.matchAll(/^\| ([0-9]+) \|/gmu)];
  const values = rows.map((match) => Number.parseInt(match[1], 10));
  const complete =
    values.length === 55 && values.every((value, index) => value === index);
  if (complete) return;

  const line = document.source.slice(0, heading.index).split("\n").length;
  addProblem(
    designPath,
    line,
    "DESIGN_LEGACY_TRACE_SEQUENCE",
    `legacy trace rows must contain each section from 0 through 54 exactly once in order; found [${values.join(", ")}]`,
  );
}

function validateFenceClosure(path, token, line) {
  if (token.map === null) {
    addProblem(
      path,
      line,
      "FENCE_PARSE_ERROR",
      "Markdown parser returned a fenced block without a source range",
    );
    return;
  }

  // CommonMark permits a fence to end at EOF or at a container boundary.
  // Markdown-it removes container prefixes (including blockquotes) from the
  // token content. A real closing marker contributes the one additional source
  // line beyond the opening and content lines.
  const contentLines =
    token.content === ""
      ? 0
      : token.content.split("\n").length -
        (token.content.endsWith("\n") ? 1 : 0);
  const sourceLines = token.map[1] - token.map[0];
  if (sourceLines !== contentLines + 2) {
    addProblem(
      path,
      line,
      "UNCLOSED_FENCE",
      `fenced code block opened with '${token.markup}' is not closed`,
    );
  }
}

function fenceLanguage(info) {
  return info.trim().split(/\s+/u, 1)[0]?.toLocaleLowerCase("en-US") ?? "";
}

function inlineText(tokens) {
  let text = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline") {
      text += token.content;
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      text += " ";
    } else if (token.type === "image") {
      text +=
        token.children === null || token.children.length === 0
          ? token.content
          : inlineText(token.children);
    } else if (token.children !== null) {
      text += inlineText(token.children);
    }
  }
  return text;
}

function collectInlineLinks(tokens, line, links) {
  for (const token of tokens) {
    if (token.type === "link_open") {
      const destination = token.attrGet("href");
      if (destination !== null) links.push({ destination, line });
    } else if (token.type === "image") {
      const destination = token.attrGet("src");
      if (destination !== null) links.push({ destination, line });
    }
    if (token.children !== null) {
      collectInlineLinks(token.children, line, links);
    }
  }
}

function collectInlineHTMLMetadata(tokens, line, anchors, links) {
  for (const token of tokens) {
    if (token.type === "html_inline") {
      collectHTMLMetadata(token.content, line, anchors, links);
    }
    if (token.children !== null) {
      collectInlineHTMLMetadata(token.children, line, anchors, links);
    }
  }
}

function collectHTMLMetadata(source, line, anchors, links) {
  for (const tag of htmlStartTags(source)) {
    const attributes = htmlAttributes(tag.attributes);
    if (tag.name === "a") {
      for (const anchorName of ["id", "name"]) {
        const anchor = attributes.get(anchorName);
        if (anchor !== undefined) anchors.add(decodeHTMLAttribute(anchor));
      }
      const destination = attributes.get("href");
      if (destination !== undefined) {
        links.push({ destination: decodeHTMLAttribute(destination), line });
      }
    } else if (tag.name === "img") {
      const destination = attributes.get("src");
      if (destination !== undefined) {
        links.push({ destination: decodeHTMLAttribute(destination), line });
      }
    }
  }
}

function htmlStartTags(source) {
  const tags = [];
  const lowerSource = source.toLowerCase();
  const rawTextElements = new Set([
    "iframe",
    "noembed",
    "noframes",
    "plaintext",
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
  ]);
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) break;

    if (source.startsWith("<!--", open)) {
      const commentEnd = source.indexOf("-->", open + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const cdataEnd = source.indexOf("]]>", open + 9);
      cursor = cdataEnd === -1 ? source.length : cdataEnd + 3;
      continue;
    }

    const marker = source[open + 1];
    if (marker === "/" || marker === "!" || marker === "?") {
      const end = htmlTagEnd(source, open + 2);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }

    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(source.slice(open + 1));
    if (nameMatch === null) {
      cursor = open + 1;
      continue;
    }

    const name = nameMatch[0].toLowerCase();
    const nameEnd = open + 1 + nameMatch[0].length;
    const end = htmlTagEnd(source, nameEnd);
    if (end === -1) break;
    if (name === "a" || name === "img") {
      tags.push({ attributes: source.slice(nameEnd, end), name });
    }
    cursor = end + 1;

    if (!rawTextElements.has(name)) continue;
    if (name === "plaintext") {
      cursor = source.length;
      continue;
    }
    const closingPrefix = "</" + name;
    let closingStart = lowerSource.indexOf(closingPrefix, cursor);
    while (
      closingStart !== -1 &&
      !/[\t\n\f\r />]/.test(
        lowerSource[closingStart + closingPrefix.length] ?? "",
      )
    ) {
      closingStart = lowerSource.indexOf(closingPrefix, closingStart + 1);
    }
    if (closingStart === -1) {
      cursor = source.length;
      continue;
    }
    const closingEnd = htmlTagEnd(source, closingStart + closingPrefix.length);
    cursor = closingEnd === -1 ? source.length : closingEnd + 1;
  }
  return tags;
}

function htmlTagEnd(source, start) {
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== "") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function htmlAttributes(source) {
  const attributes = new Map();
  let cursor = 0;
  while (cursor < source.length) {
    while (/[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length || source[cursor] === "/") break;

    const nameStart = cursor;
    while (
      cursor < source.length &&
      !/[\t\n\f\r />="'\x60]/.test(source[cursor])
    ) {
      cursor += 1;
    }
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (/[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor += 1;

    let value = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/[\t\n\f\r ]/.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < source.length && source[cursor] !== quote) {
          cursor += 1;
        }
        value = source.slice(valueStart, cursor);
        if (cursor < source.length) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < source.length && !/[\t\n\f\r ]/.test(source[cursor])) {
          cursor += 1;
        }
        value = source.slice(valueStart, cursor);
      }
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

function decodeHTMLAttribute(value) {
  return value
    .split("\\")
    .map((part) => markdown.utils.unescapeAll(part))
    .join("\\");
}

async function loadMermaid() {
  const manifestPath = resolve(canonicalRoot, "package.json");
  try {
    const requireFromChecker = createRequire(import.meta.url);
    const requireFromMermaid = createRequire(
      requireFromChecker.resolve("mermaid"),
    );

    // Mermaid sanitizes labels even during parse. This gate only parses trusted
    // repository text and never renders it, so identity hooks keep validation
    // DOM-free while retaining Mermaid's real grammar and semantic actions.
    const domPurifyCommonJSPath = requireFromMermaid.resolve("dompurify");
    const domPurifyESMPath = resolve(
      dirname(domPurifyCommonJSPath),
      "purify.es.mjs",
    );
    const { default: domPurify } = await import(
      pathToFileURL(domPurifyESMPath)
    );
    domPurify.addHook = () => {};
    domPurify.sanitize = (value) => value;
    const { default: mermaid } = await import("mermaid");
    return mermaid;
  } catch {
    addProblem(
      manifestPath,
      1,
      "MERMAID_TOOL_UNAVAILABLE",
      `Mermaid ${requiredMermaidVersion} could not be loaded`,
    );
    return null;
  }
}

async function validateMermaidBlocks(mermaid) {
  for (const document of documents.values()) {
    for (const block of document.mermaidBlocks) {
      try {
        await mermaid.parse(block.source);
      } catch {
        addProblem(
          document.path,
          block.line,
          "MERMAID_SYNTAX",
          "fenced Mermaid diagram has invalid syntax",
        );
      }
    }
  }
}

async function validateTarget(document, link) {
  const destination = link.destination;
  if (destination === "" || isExternal(destination)) return;

  const hash = destination.indexOf("#");
  const pathPart = hash === -1 ? destination : destination.slice(0, hash);
  const fragmentPart = hash === -1 ? "" : destination.slice(hash + 1);
  const query = pathPart.indexOf("?");
  const rawPath = query === -1 ? pathPart : pathPart.slice(0, query);
  let decodedPath;
  let decodedFragment;
  try {
    decodedPath = decodeURIComponent(rawPath);
    decodedFragment = decodeURIComponent(fragmentPart);
  } catch {
    addProblem(
      document.path,
      link.line,
      "INVALID_LINK_ENCODING",
      "local link contains invalid percent encoding",
    );
    return;
  }

  const targetPath =
    decodedPath === ""
      ? document.path
      : resolve(
          isAbsolute(decodedPath) ? canonicalRoot : dirname(document.path),
          decodedPath.replace(/^[/\\]+/, ""),
        );
  if (!isInsideRoot(targetPath)) {
    addProblem(
      document.path,
      link.line,
      "LINK_OUTSIDE_REPOSITORY",
      `local link escapes the repository: ${link.destination}`,
    );
    return;
  }

  const stat = await lstat(targetPath).catch(() => null);
  if (stat === null) {
    addProblem(
      document.path,
      link.line,
      "MISSING_LINK_TARGET",
      `local link target does not exist: ${link.destination}`,
    );
    return;
  }
  if (stat.isSymbolicLink()) {
    addProblem(
      document.path,
      link.line,
      "SYMLINK_LINK_TARGET_NOT_ALLOWED",
      `local link target must not be a symbolic link: ${link.destination}`,
    );
    return;
  }

  const canonicalTarget = await realpath(targetPath).catch(() => null);
  if (canonicalTarget === null) {
    addProblem(
      document.path,
      link.line,
      "MISSING_LINK_TARGET",
      `local link target cannot be resolved: ${link.destination}`,
    );
    return;
  }
  if (canonicalTarget !== targetPath) {
    addProblem(
      document.path,
      link.line,
      "SYMLINK_LINK_TARGET_NOT_ALLOWED",
      `local link path must not traverse a symbolic link: ${link.destination}`,
    );
    return;
  }
  if (!isInsideRoot(canonicalTarget)) {
    addProblem(
      document.path,
      link.line,
      "LINK_OUTSIDE_REPOSITORY",
      `local link resolves outside the repository: ${link.destination}`,
    );
    return;
  }

  if (decodedFragment === "") return;
  if (!stat.isFile() || extname(targetPath).toLowerCase() !== ".md") {
    addProblem(
      document.path,
      link.line,
      "INVALID_LINK_FRAGMENT",
      `fragment target is not a Markdown document: ${link.destination}`,
    );
    return;
  }
  const targetDocument = documents.get(targetPath);
  if (
    targetDocument === undefined ||
    !targetDocument.anchors.has(decodedFragment)
  ) {
    addProblem(
      document.path,
      link.line,
      "MISSING_LINK_FRAGMENT",
      `Markdown anchor does not exist: ${link.destination}`,
    );
  }
}

function isExternal(destination) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("//")
  );
}

function isInsideRoot(path) {
  const pathFromRoot = relative(canonicalRoot, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function addProblem(file, line, code, message) {
  problems.push({ code, file, line, message });
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
