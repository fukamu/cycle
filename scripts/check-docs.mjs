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
validateSpecificationChangeControl();
validatePullRequestReviewTemplate();
await validateOperationalDocumentationTopology();

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
  const headings = [];
  const links = [];
  const mermaidBlocks = [];
  const referenceLabels = new Set();
  const slugger = new GithubSlugger();
  const visibleMarkdownLinks = [];
  const visibleTextBlocks = [];

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
        headings.push({
          level: Number.parseInt(token.tag.slice(1), 10),
          line,
          text: heading,
        });
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
      const visibleText = inlineText(token.children ?? []).trim();
      if (visibleText !== "") {
        visibleTextBlocks.push({ line, text: visibleText });
      }
      collectInlineLinks(token.children ?? [], line, links);
      collectVisibleMarkdownLinks(
        token.children ?? [],
        line,
        visibleMarkdownLinks,
      );
      collectInlineHTMLMetadata(token.children ?? [], line, anchors, links);
    } else if (token.type === "html_block") {
      collectHTMLMetadata(token.content, line, anchors, links);
    }
  }

  return {
    anchors,
    headings,
    links,
    mermaidBlocks,
    path,
    source,
    visibleMarkdownLinks,
    visibleTextBlocks,
  };
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

function validateSpecificationChangeControl() {
  const designPath = resolve(canonicalRoot, "docs/design.md");
  const document = documents.get(designPath);
  if (document === undefined) return;

  const tokens = markdown.parse(document.source, {
    references: Object.create(null),
  });
  let sectionStart = -1;
  let sectionEnd = tokens.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "heading_open" || token.tag !== "h2") continue;
    const heading = tokens[index + 1];
    const text =
      heading?.type === "inline" ? inlineText(heading.children ?? []) : "";
    if (sectionStart === -1 && text === "52.5 Specification update procedure") {
      sectionStart = index;
    } else if (sectionStart !== -1) {
      sectionEnd = index;
      break;
    }
  }

  const sectionTokens =
    sectionStart === -1 ? [] : tokens.slice(sectionStart, sectionEnd);
  const tableRows = [];
  let currentRow = null;
  for (const token of sectionTokens) {
    if (token.type === "tr_open") {
      currentRow = [];
    } else if (token.type === "inline" && currentRow !== null) {
      currentRow.push(inlineText(token.children ?? []).trim());
    } else if (token.type === "tr_close" && currentRow !== null) {
      tableRows.push(currentRow);
      currentRow = null;
    }
  }
  const expectedRows = [
    ["Classification", "判定", "実行条件"],
    [
      "既存仕様内の具体化",
      "Canonical ownerの意味を変えないDeliveryまたはmaintenance（§52.4を含む）として、既存Contractを実装・修正・検証する",
      "根拠となるcanonical sectionと影響または非影響の理由を記録する",
    ],
    [
      "仕様変更",
      "Product Rule、Architecture Constraint、Implementation Contract、required verificationの意味を変える",
      "理由・影響・実行可能な選択肢を示し、Product Ownerの明示承認を得る",
    ],
    [
      "Discoveryのみ",
      "仮説、調査、比較、計測だけを行い、canonical ownerまたはProduct behaviorを変更しない",
      "参照したcanonical sectionと、採用時は別のDelivery変更として再分類することを記録する",
    ],
  ];
  const approvalRule =
    "仕様変更は、Product Ownerが理由・影響・選択肢を明示して承認した後だけ、canonical ownerまたは実装の変更に着手できる。承認前は該当変更を停止し、承認証跡をIssueまたはPull Requestへ記録する。";
  const contractPresent =
    JSON.stringify(tableRows) === JSON.stringify(expectedRows) &&
    sectionTokens.filter(
      (token) =>
        token.type === "inline" &&
        inlineText(token.children ?? []).trim() === approvalRule,
    ).length === 1;
  if (contractPresent) return;

  const sectionHeading = document.headings.find(
    (heading) => heading.text === "52.5 Specification update procedure",
  );
  addProblem(
    designPath,
    sectionHeading?.line ?? 1,
    "DESIGN_CHANGE_CONTROL_CONTRACT",
    "docs/design.md §52.5 must retain one visible classification table and Product Owner approval rule in its canonical section",
  );
}

async function validateOperationalDocumentationTopology() {
  const retiredPaths = [
    "docs/ai-evaluation.md",
    "docs/deployment.md",
    "docs/troubleshooting.md",
    "infra/terraform/staging/README.md",
  ];
  for (const retiredPath of retiredPaths) {
    const path = resolve(canonicalRoot, retiredPath);
    if (!documents.has(path)) continue;
    addProblem(
      path,
      1,
      "OBSOLETE_OPERATIONAL_DOCUMENT",
      `${retiredPath} was consolidated by M32 and must not be restored`,
    );
  }

  const deploymentContract = resolve(
    canonicalRoot,
    "config/deployment-contract.json",
  );
  if ((await lstat(deploymentContract).catch(() => null)) === null) return;

  const readmePath = resolve(canonicalRoot, "README.md");
  const readme = documents.get(readmePath);
  if (readme === undefined) {
    addProblem(
      readmePath,
      1,
      "README_NAVIGATION_MISSING",
      "README.md must link to every canonical documentation owner",
    );
    return;
  }

  const requiredTargets = [
    "AGENTS.md",
    "docs/closed-beta-admission.md",
    "docs/database.md",
    "docs/design.md",
    "docs/development.md",
    "docs/environment.md",
    "docs/operations.md",
  ];
  for (const requiredTarget of requiredTargets) {
    const targetPath = resolve(canonicalRoot, requiredTarget);
    const linked = readme.links.some(
      (link) => localLinkPath(readme.path, link.destination) === targetPath,
    );
    if (linked) continue;
    addProblem(
      readmePath,
      1,
      "README_NAVIGATION_MISSING",
      `README.md must link to ${requiredTarget}`,
    );
  }
}

function validatePullRequestReviewTemplate() {
  const templatePath = resolve(
    canonicalRoot,
    ".github/pull_request_template.md",
  );
  const template = documents.get(templatePath);
  if (template === undefined) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_MISSING",
      ".github/pull_request_template.md must provide the Source of Truth review gate",
    );
    return;
  }

  // This is intentionally a structural prompt guard, not a claim that text
  // matching can prove semantic consistency between the specification and its
  // consumers. Authors and reviewers remain responsible for that assessment.
  const lines = template.source.split("\n");
  const exactLineIndex = (expected) => {
    const indexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === expected) indexes.push(index);
    }
    return indexes.length === 1 ? indexes[0] : -1;
  };
  const hasVisiblePrompt = (sourceLine, visibleText) => {
    const index = exactLineIndex(sourceLine);
    return (
      index !== -1 &&
      template.visibleTextBlocks.some(
        (block) => block.line === index + 1 && block.text === visibleText,
      )
    );
  };
  const headingIndex = (sourceLine, level, text) => {
    const index = exactLineIndex(sourceLine);
    if (index === -1) return -1;
    return template.headings.some(
      (heading) =>
        heading.line === index + 1 &&
        heading.level === level &&
        heading.text === text,
    )
      ? index
      : -1;
  };
  const isBetween = (index, start, end = lines.length) =>
    index > start && index < end;

  const structure = [
    headingIndex("# Summary", 1, "Summary"),
    headingIndex("## Source of Truth impact", 2, "Source of Truth impact"),
    headingIndex(
      "### Specification Impact classification",
      3,
      "Specification Impact classification",
    ),
    headingIndex("### Cross-reference review", 3, "Cross-reference review"),
    headingIndex("### Change-control gate", 3, "Change-control gate"),
    headingIndex("## Verification evidence", 2, "Verification evidence"),
  ];
  const expectedSourceSectionHeadings = [
    {
      level: 3,
      line: structure[2] + 1,
      text: "Specification Impact classification",
    },
    { level: 3, line: structure[3] + 1, text: "Cross-reference review" },
    { level: 3, line: structure[4] + 1, text: "Change-control gate" },
  ];
  const sourceSectionHeadings = template.headings.filter(
    (heading) =>
      heading.line > structure[1] + 1 &&
      heading.line < structure[5] + 1 &&
      heading.level <= 3,
  );
  const sourceHierarchyPresent =
    sourceSectionHeadings.length === expectedSourceSectionHeadings.length &&
    sourceSectionHeadings.every((heading, index) => {
      const expected = expectedSourceSectionHeadings[index];
      return (
        expected !== undefined &&
        heading.level === expected.level &&
        heading.line === expected.line &&
        heading.text === expected.text
      );
    });
  const structurePresent =
    structure.every((index) => index !== -1) &&
    structure.every((index, position) => {
      const previous = structure[position - 1];
      return previous === undefined || previous < index;
    }) &&
    sourceHierarchyPresent;
  if (!structurePresent) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_STRUCTURE",
      "Pull request template must retain the visible Summary, Source of Truth, classification, cross-reference, change-control, and verification sections in order",
    );
  }

  const [, sourceStart, classificationStart, crossReferenceStart, gateStart] =
    structure;
  const verificationStart = structure[5];

  const requiredCanonicalLinks = [
    {
      destination:
        "https://github.com/fukamu/cycle/blob/main/docs/design.md#01-文書の権威",
      fragment: "01-文書の権威",
      label: "文書の権威",
      path: "docs/design.md",
    },
    {
      destination:
        "https://github.com/fukamu/cycle/blob/main/docs/design.md#523-changes-that-require-updating-this-document",
      fragment: "523-changes-that-require-updating-this-document",
      label: "更新が必要な変更",
      path: "docs/design.md",
    },
    {
      destination:
        "https://github.com/fukamu/cycle/blob/main/docs/design.md#524-changes-that-normally-do-not-require-updating-this-document",
      fragment: "524-changes-that-normally-do-not-require-updating-this-document",
      label: "通常は更新不要な変更",
      path: "docs/design.md",
    },
    {
      destination:
        "https://github.com/fukamu/cycle/blob/main/docs/design.md#525-specification-update-procedure",
      fragment: "525-specification-update-procedure",
      label: "仕様更新手順",
      path: "docs/design.md",
    },
    {
      destination:
        "https://github.com/fukamu/cycle/blob/main/docs/design.md#542-canonical-ownership-index",
      fragment: "542-canonical-ownership-index",
      label: "Canonical ownership index",
      path: "docs/design.md",
    },
    {
      destination:
        "https://github.com/fukamu/cycle/blob/main/AGENTS.md#仕様変更と停止条件",
      fragment: "仕様変更と停止条件",
      label: "仕様変更と停止条件",
      path: "AGENTS.md",
    },
  ];
  const decodedTemplateLinks = template.visibleMarkdownLinks.map((link) => {
    try {
      return { ...link, destination: decodeURIComponent(link.destination) };
    } catch {
      return link;
    }
  });
  const canonicalSectionLine =
    "- Canonical design section(s): <!-- 必須。`docs/design.md` §§...を記載。Discoveryのみの場合も、変更しない根拠と確認したsectionを記載。 -->";
  const classificationRationaleLine =
    "- Classification rationale: <!-- 既存仕様で完全に規定済みか、§52.4の非意味変更か、Product Owner承認済みの仕様変更か、Discoveryだけかを説明。 -->";
  const canonicalOwnerStart = exactLineIndex("Canonical owner:");
  const enforcementMirrorStart = exactLineIndex(
    "Repository enforcement mirror:",
  );
  const canonicalReferencesPresent =
    hasVisiblePrompt("Canonical owner:", "Canonical owner:") &&
    isBetween(canonicalOwnerStart, sourceStart, classificationStart) &&
    hasVisiblePrompt(
      "Repository enforcement mirror:",
      "Repository enforcement mirror:",
    ) &&
    isBetween(
      enforcementMirrorStart,
      sourceStart,
      classificationStart,
    ) &&
    hasVisiblePrompt(canonicalSectionLine, "Canonical design section(s):") &&
    isBetween(
      exactLineIndex(canonicalSectionLine),
      classificationStart,
      crossReferenceStart,
    ) &&
    hasVisiblePrompt(classificationRationaleLine, "Classification rationale:") &&
    isBetween(
      exactLineIndex(classificationRationaleLine),
      classificationStart,
      crossReferenceStart,
    ) &&
    requiredCanonicalLinks.every((requiredLink) => {
      const target = documents.get(resolve(canonicalRoot, requiredLink.path));
      const linkStart =
        requiredLink.path === "AGENTS.md"
          ? enforcementMirrorStart
          : canonicalOwnerStart;
      const linkEnd =
        requiredLink.path === "AGENTS.md"
          ? classificationStart
          : enforcementMirrorStart;
      return (
        target?.anchors.has(requiredLink.fragment) === true &&
        decodedTemplateLinks.some(
          (link) =>
            link.destination === requiredLink.destination &&
            link.label === requiredLink.label &&
            isBetween(link.line - 1, linkStart, linkEnd),
        )
      );
    });
  if (!canonicalReferencesPresent) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_CANONICAL_REFERENCE",
      "Pull request template must retain visible canonical-section and rationale fields, absolute PR-context owner links, and the separate repository enforcement mirror",
    );
  }

  const classificationLines = [
    ["- [ ] `既存仕様内の具体化`", "[ ] 既存仕様内の具体化"],
    ["- [ ] `仕様変更`", "[ ] 仕様変更"],
    ["- [ ] `Discoveryのみ`", "[ ] Discoveryのみ"],
  ];
  const classificationPrompt = "次の3分類から1つだけ選択してください。";
  if (
    !hasVisiblePrompt(classificationPrompt, classificationPrompt) ||
    !isBetween(
      exactLineIndex(classificationPrompt),
      classificationStart,
      crossReferenceStart,
    ) ||
    !classificationLines.every(
      ([sourceLine, visibleText]) =>
        hasVisiblePrompt(sourceLine, visibleText) &&
        isBetween(
          exactLineIndex(sourceLine),
          classificationStart,
          crossReferenceStart,
        ),
    )
  ) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_CLASSIFICATION",
      "Pull request template must retain the three visible Specification Impact choices and the exactly-one human-review instruction",
    );
  }

  const impactAreas = [
    "Product / UX",
    "Domain / state",
    "DB / migration",
    "API",
    "Frontend",
    "AI",
    "Security / Privacy",
    "Operations",
    "Test",
  ];
  const impactPrompt =
    "各行を必ず埋め、影響がない場合は `N/A — 理由` と記載してください。空欄または理由のない `N/A` は認めません。";
  const visibleImpactPrompt =
    "各行を必ず埋め、影響がない場合は N/A — 理由 と記載してください。空欄または理由のない N/A は認めません。";
  const impactReviewPresent =
    hasVisiblePrompt(impactPrompt, visibleImpactPrompt) &&
    isBetween(
      exactLineIndex(impactPrompt),
      crossReferenceStart,
      gateStart,
    ) &&
    impactAreas.every((area) => {
      const rowIndex = exactLineIndex(`| ${area} | <!-- 必須 --> |`);
      return (
        isBetween(rowIndex, crossReferenceStart, gateStart) &&
        template.visibleTextBlocks.filter((block) => block.text === area)
          .length === 1
      );
    });
  if (!impactReviewPresent) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_IMPACT_REVIEW",
      "Pull request template must retain every visible cross-reference area and the impact-or-explicit-N/A-reason human-review instruction",
    );
  }

  const productOwnerEvidenceLine =
    "- Product Owner approval: <!-- 仕様変更では、理由・影響・選択肢を含む承認証跡を記載。その他は `N/A — 理由`。 -->";
  const ownerFirstLine =
    "- [ ] `仕様変更`はProduct Owner承認後に着手し、canonical ownerをcodeより前またはこのPull Requestで更新した。その他の分類はその根拠を上に記載した。";
  const visibleOwnerFirstLine =
    "[ ] 仕様変更はProduct Owner承認後に着手し、canonical ownerをcodeより前またはこのPull Requestで更新した。その他の分類はその根拠を上に記載した。";
  const enforcementMirrorLine =
    "- [ ] DDL、API Schema、Prompt、Test等のenforcement mirrorと実装をcanonical ownerと同じ変更で整合した。該当しない場合はCross-reference reviewに理由を記載した。";
  const visibleEnforcementMirrorLine = enforcementMirrorLine.slice(2);
  if (
    !hasVisiblePrompt(productOwnerEvidenceLine, "Product Owner approval:") ||
    !isBetween(
      exactLineIndex(productOwnerEvidenceLine),
      classificationStart,
      crossReferenceStart,
    ) ||
    !hasVisiblePrompt(ownerFirstLine, visibleOwnerFirstLine) ||
    !isBetween(exactLineIndex(ownerFirstLine), gateStart, verificationStart) ||
    !hasVisiblePrompt(
      enforcementMirrorLine,
      visibleEnforcementMirrorLine,
    ) ||
    !isBetween(
      exactLineIndex(enforcementMirrorLine),
      gateStart,
      verificationStart,
    )
  ) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_OWNER_FIRST",
      "Pull request template must retain the visible Product Owner evidence, owner-first or same-PR, and enforcement-mirror human-review prompts",
    );
  }

  const stopConditionLine =
    "- [ ] Product質問、仕様矛盾、security/data retention/auth/permission/production上の重要な判断不能、または影響範囲不明は未解決でない。発見した場合は該当変更を停止し、Product Ownerの判断を記録した。";
  if (
    !hasVisiblePrompt(stopConditionLine, stopConditionLine.slice(2)) ||
    !isBetween(
      exactLineIndex(stopConditionLine),
      gateStart,
      verificationStart,
    )
  ) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_STOP_CONDITION",
      "Pull request template must retain the visible unresolved-question stop-condition human-review prompt",
    );
  }

  const mainConsistencyLine =
    "- [ ] 仕様だけまたは実装だけが先行する一時的不整合をmainへmergeせず、Product / UX、Domain / state、DB / migration、API、Frontend、AI、Security / Privacy、Operations、Testが同じ現在形になっている。";
  if (
    !hasVisiblePrompt(mainConsistencyLine, mainConsistencyLine.slice(2)) ||
    !isBetween(
      exactLineIndex(mainConsistencyLine),
      gateStart,
      verificationStart,
    )
  ) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_MAIN_CONSISTENCY",
      "Pull request template must retain the visible human-review prompt that prohibits specification-only or implementation-only inconsistency on main",
    );
  }

  const evidenceLines = [
    [
      "- Commands and results: <!-- 実行commandと結果。SecretやUser Contentを記載しない。 -->",
      "Commands and results:",
    ],
    [
      "- Not run and reason: <!-- 未実行がある場合は対象と理由。なければ `N/A — 全必須check実行済み`。 -->",
      "Not run and reason:",
    ],
    [
      "- Manual / staging evidence: <!-- 必要な場合のみ。その他は `N/A — 理由`。 -->",
      "Manual / staging evidence:",
    ],
  ];
  const verificationEvidencePresent =
    verificationStart !== -1 &&
    evidenceLines.every(
      ([sourceLine, visibleText]) =>
        hasVisiblePrompt(sourceLine, visibleText) &&
        isBetween(exactLineIndex(sourceLine), verificationStart),
    );
  if (!verificationEvidencePresent) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_VERIFICATION_EVIDENCE",
      "Pull request template must retain visible fields for executed, omitted, and manual verification evidence",
    );
  }

  const semanticScopeLines = [
    "このtemplateは意味的整合性を自動証明しません。実装者とreviewerがcanonical ownerとconsumerを読み、同じ現在形に整合していることを確認してください。",
    "Repository checkはtemplate sourceのprompt存在だけを検査します。個々のPull Request本文の選択数、記入内容、承認の有効性はreviewerが確認してください。",
  ];
  if (
    !semanticScopeLines.every(
      (line) =>
        hasVisiblePrompt(line, line) &&
        isBetween(exactLineIndex(line), sourceStart, classificationStart),
    )
  ) {
    addProblem(
      templatePath,
      1,
      "PULL_REQUEST_TEMPLATE_SEMANTIC_SCOPE",
      "Pull request template must visibly state that source prompts do not prove semantic consistency or validate completed pull request bodies",
    );
  }
}

function localLinkPath(documentPath, destination) {
  if (destination === "" || isExternal(destination)) return null;
  const hash = destination.indexOf("#");
  const pathPart = hash === -1 ? destination : destination.slice(0, hash);
  const query = pathPart.indexOf("?");
  const rawPath = query === -1 ? pathPart : pathPart.slice(0, query);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return resolve(
    isAbsolute(decodedPath) ? canonicalRoot : dirname(documentPath),
    decodedPath.replace(/^[/\\]+/, ""),
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

function collectVisibleMarkdownLinks(tokens, line, links) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "link_open") continue;

    let depth = 1;
    let end = index + 1;
    for (; end < tokens.length; end += 1) {
      if (tokens[end].type === "link_open") depth += 1;
      if (tokens[end].type === "link_close") depth -= 1;
      if (depth === 0) break;
    }
    const destination = token.attrGet("href");
    const label = inlineText(tokens.slice(index + 1, end)).trim();
    if (destination !== null && label !== "") {
      links.push({ destination, label, line });
    }
    index = end;
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
