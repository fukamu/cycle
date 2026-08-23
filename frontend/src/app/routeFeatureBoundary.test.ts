/// <reference types="node" />

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

type RouteBoundary = {
  readonly page: string;
  readonly pageExport: string;
  readonly feature: string;
  readonly featureExport: string;
  readonly queryExport: string;
  readonly featureProp: string;
  readonly allowedJsx: readonly string[];
  readonly localDeclarations: readonly string[];
  readonly allowedCalls: readonly string[];
};

type CompositionBoundary = {
  readonly page: string;
  readonly pageExport: string;
  readonly feature: string;
  readonly featureExport: string;
  readonly localDeclarations: readonly string[];
  readonly allowedCalls: readonly string[];
  readonly featureProps: readonly string[];
};

const boundaries: readonly RouteBoundary[] = [
  {
    page: "NewGoalPage",
    pageExport: "NewGoalPage",
    feature: "goal-creation",
    featureExport: "GoalCreationFeature",
    queryExport: "goalCreationQueryOptions",
    featureProp: "home",
    allowedJsx: ["GoalCreationFeature", "PageError", "PageLoading"],
    localDeclarations: [
      "session=useSession()",
      "sessionLease=useAuthenticatedRequestLease()",
      "query=useQuery(goalCreationQueryOptions(session.user.id,sessionLease))",
    ],
    allowedCalls: [
      "goalCreationQueryOptions",
      "query.refetch",
      "useAuthenticatedRequestLease",
      "useQuery",
      "useSession",
    ],
  },
  {
    page: "GoalReviewPage",
    pageExport: "GoalReviewPage",
    feature: "goal-review",
    featureExport: "GoalReviewFeature",
    queryExport: "goalReviewQueryOptions",
    featureProp: "review",
    allowedJsx: ["GoalReviewFeature", "PageError", "PageLoading"],
    localDeclarations: [
      "session=useSession()",
      "sessionLease=useAuthenticatedRequestLease()",
      "userId=session.user.id",
      '{goalId=""}=useParams()',
      "query=useQuery(goalReviewQueryOptions(userId,goalId,sessionLease))",
    ],
    allowedCalls: [
      "goalReviewQueryOptions",
      "query.refetch",
      "useAuthenticatedRequestLease",
      "useParams",
      "useQuery",
      "useSession",
    ],
  },
] as const;

const compositionBoundaries: readonly CompositionBoundary[] = [
  {
    page: "GoalWorkspacePage",
    pageExport: "GoalWorkspacePage",
    feature: "cycle-workspace",
    featureExport: "CycleWorkspaceFeature",
    localDeclarations: ['{goalId="",cycleId=""}=useParams()'],
    allowedCalls: ["useParams"],
    featureProps: ["cycleId=cycleId", "goalId=goalId"],
  },
  {
    page: "GoalHistoryPage",
    pageExport: "GoalHistoryPage",
    feature: "goal-history",
    featureExport: "GoalHistoryFeature",
    localDeclarations: [],
    allowedCalls: [],
    featureProps: [],
  },
  {
    page: "GoalTimelinePage",
    pageExport: "GoalTimelinePage",
    feature: "goal-history",
    featureExport: "GoalTimelineFeature",
    localDeclarations: ['{goalId=""}=useParams()'],
    allowedCalls: ["useParams"],
    featureProps: ["goalId=goalId"],
  },
] as const;

const compositionFeatureContracts = [
  {
    feature: "cycle-workspace",
    exports: ["CycleWorkspaceFeature"],
  },
  {
    feature: "goal-history",
    exports: ["GoalHistoryFeature", "GoalTimelineFeature"],
  },
] as const;

const srcDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const featuresDirectory = resolve(srcDirectory, "features");

function sourceFileAt(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function sourceFile(relativePath: string): ts.SourceFile {
  return sourceFileAt(resolve(srcDirectory, relativePath));
}

function modulePaths(source: ts.SourceFile): string[] {
  const paths: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      paths.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        paths.push(argument.text);
        return;
      }
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      paths.push(node.argument.literal.text);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return paths;
}

function bindingSignature(name: ts.BindingName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isObjectBindingPattern(name)) {
    return (
      "{" +
      name.elements
        .map((element) => {
          const propertyName = element.propertyName
            ? expressionSignature(element.propertyName) + ":"
            : "";
          const rest = element.dotDotDotToken ? "..." : "";
          const initializer = element.initializer
            ? "=" + expressionSignature(element.initializer)
            : "";
          return (
            propertyName + rest + bindingSignature(element.name) + initializer
          );
        })
        .join(",") +
      "}"
    );
  }
  return "[unsupported-array-binding]";
}

function expressionSignature(node: ts.Node | undefined): string {
  if (!node) return "[missing]";
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    return expressionSignature(node.expression) + "." + node.name.text;
  }
  if (ts.isCallExpression(node)) {
    return (
      expressionSignature(node.expression) +
      "(" +
      node.arguments.map(expressionSignature).join(",") +
      ")"
    );
  }
  if (ts.isParenthesizedExpression(node)) {
    return expressionSignature(node.expression);
  }
  if (ts.isVoidExpression(node)) {
    return "void " + expressionSignature(node.expression);
  }
  if (ts.isArrowFunction(node)) {
    return (
      "(" +
      node.parameters
        .map((parameter) => bindingSignature(parameter.name))
        .join(",") +
      ")=>" +
      expressionSignature(node.body)
    );
  }
  return "[unsupported:" + ts.SyntaxKind[node.kind] + "]";
}

function localDeclarationSignatures(
  pageFunction: ts.FunctionDeclaration,
): string[] {
  if (!pageFunction.body) return [];
  return pageFunction.body.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(
          (declaration) =>
            bindingSignature(declaration.name) +
            "=" +
            expressionSignature(declaration.initializer),
        )
      : [],
  );
}

function callExpressionNames(pageFunction: ts.FunctionDeclaration): string[] {
  const names: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      names.push(expressionSignature(node.expression));
    }
    ts.forEachChild(node, visit);
  }
  visit(pageFunction);
  return names.sort();
}

function jsxTags(source: ts.SourceFile): string[] {
  const tags = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      tags.add(node.tagName.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...tags].sort();
}

function jsxOpenings(
  source: ts.SourceFile,
  tagName: string,
): readonly (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === tagName
    ) {
      openings.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return openings;
}

function jsxPropSignatures(
  source: ts.SourceFile,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): string[] {
  return opening.attributes.properties
    .map((property) => {
      if (ts.isJsxSpreadAttribute(property)) {
        return "..." + expressionSignature(property.expression);
      }
      let value = "true";
      if (property.initializer && ts.isStringLiteral(property.initializer)) {
        value = JSON.stringify(property.initializer.text);
      } else if (
        property.initializer &&
        ts.isJsxExpression(property.initializer)
      ) {
        value = expressionSignature(property.initializer.expression);
      }
      return property.name.getText(source) + "=" + value;
    })
    .sort();
}

function publicIndexContract(source: ts.SourceFile): {
  readonly names: readonly string[];
  readonly invalidStatements: readonly string[];
} {
  const names: string[] = [];
  const invalidStatements: string[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      invalidStatements.push(statement.getText(source));
      continue;
    }
    names.push(
      ...statement.exportClause.elements.map((element) => element.name.text),
    );
  }
  return { names, invalidStatements };
}

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return productionTypeScriptFiles(path);
      return entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.(?:test|spec)\.tsx?$/.test(entry.name)
        ? [path]
        : [];
    })
    .sort();
}

function targetFeatureName(resolvedImport: string): string | null {
  const fromFeatures = relative(featuresDirectory, resolvedImport);
  if (
    fromFeatures === "" ||
    fromFeatures === ".." ||
    fromFeatures.startsWith(".." + sep) ||
    isAbsolute(fromFeatures)
  ) {
    return null;
  }
  return fromFeatures.split(sep)[0] ?? null;
}

function isPublicFeatureIndex(
  resolvedImport: string,
  targetFeature: string,
): boolean {
  const targetDirectory = resolve(featuresDirectory, targetFeature);
  return [
    targetDirectory,
    resolve(targetDirectory, "index"),
    resolve(targetDirectory, "index.ts"),
    resolve(targetDirectory, "index.tsx"),
  ].includes(resolvedImport);
}

describe.each(boundaries)(
  "$page route/feature ownership boundary",
  ({
    page,
    pageExport,
    feature,
    featureExport,
    queryExport,
    featureProp,
    allowedJsx,
    localDeclarations,
    allowedCalls,
  }) => {
    it("keeps the route at query/load/error/feature composition only", () => {
      const source = sourceFile(`pages/${page}.tsx`);
      const relativeImports = modulePaths(source)
        .filter((path) => path.startsWith("."))
        .sort();

      expect(relativeImports).toEqual(
        [
          "../features/auth",
          `../features/${feature}`,
          "../shared/components/AsyncState",
        ].sort(),
      );
      expect(jsxTags(source)).toEqual([...allowedJsx].sort());

      const implementationStatements = source.statements.filter(
        (statement) => !ts.isImportDeclaration(statement),
      );
      expect(implementationStatements).toHaveLength(1);
      const pageFunction = implementationStatements[0];
      expect(pageFunction && ts.isFunctionDeclaration(pageFunction)).toBe(true);
      if (!pageFunction || !ts.isFunctionDeclaration(pageFunction)) return;
      expect(pageFunction.name?.text).toBe(pageExport);
      expect(
        pageFunction.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ),
      ).toBe(true);

      const body = pageFunction.body;
      expect(body).toBeDefined();
      if (!body) return;
      expect(localDeclarationSignatures(pageFunction)).toEqual(
        localDeclarations,
      );
      expect(callExpressionNames(pageFunction)).toEqual(
        [...allowedCalls].sort(),
      );
      expect(
        body.statements.map((statement) =>
          ts.isVariableStatement(statement)
            ? "variable"
            : ts.isIfStatement(statement)
              ? "if"
              : ts.isReturnStatement(statement)
                ? "return"
                : "unsupported:" + ts.SyntaxKind[statement.kind],
        ),
      ).toEqual([
        ...localDeclarations.map(() => "variable"),
        "if",
        "if",
        "return",
      ]);
      expect(
        body.statements
          .filter(ts.isIfStatement)
          .map((statement) => expressionSignature(statement.expression)),
      ).toEqual(["query.isPending", "query.isError"]);

      const featureOpenings = jsxOpenings(source, featureExport);
      expect(featureOpenings).toHaveLength(1);
      const featureOpening = featureOpenings[0];
      if (featureOpening) {
        expect(jsxPropSignatures(source, featureOpening)).toEqual([
          featureProp + "=query.data",
        ]);
      }

      const loadingOpenings = jsxOpenings(source, "PageLoading");
      expect(loadingOpenings).toHaveLength(1);
      const loadingOpening = loadingOpenings[0];
      if (loadingOpening) {
        expect(jsxPropSignatures(source, loadingOpening)).toEqual([]);
      }

      const errorOpenings = jsxOpenings(source, "PageError");
      expect(errorOpenings).toHaveLength(1);
      const errorOpening = errorOpenings[0];
      if (errorOpening) {
        expect(jsxPropSignatures(source, errorOpening)).toEqual([
          "retry=()=>void query.refetch()",
        ]);
      }
    });

    it("publishes only the feature component and query contract", () => {
      const featureIndex = sourceFile(`features/${feature}/index.ts`);
      const contract = publicIndexContract(featureIndex);
      expect(contract.invalidStatements).toEqual([]);
      expect([...contract.names].sort()).toEqual(
        [featureExport, queryExport].sort(),
      );
    });

    it("uses public indexes for cross-feature imports", () => {
      const directory = resolve(featuresDirectory, feature);
      const violations: string[] = [];
      let crossFeatureImportCount = 0;

      for (const file of productionTypeScriptFiles(directory)) {
        for (const modulePath of modulePaths(sourceFileAt(file))) {
          if (!modulePath.startsWith(".")) continue;
          const resolvedImport = resolve(dirname(file), modulePath);
          const targetFeature = targetFeatureName(resolvedImport);
          if (!targetFeature || targetFeature === feature) continue;
          crossFeatureImportCount += 1;
          if (!isPublicFeatureIndex(resolvedImport, targetFeature)) {
            violations.push(relative(srcDirectory, file) + " -> " + modulePath);
          }
        }
      }

      expect(crossFeatureImportCount).toBeGreaterThan(0);
      expect(violations).toEqual([]);
    });
  },
);

describe.each(compositionBoundaries)(
  "$page composition-only route boundary",
  ({
    page,
    pageExport,
    feature,
    featureExport,
    localDeclarations,
    allowedCalls,
    featureProps,
  }) => {
    it("keeps the route at parameter resolution and feature composition only", () => {
      const source = sourceFile(`pages/${page}.tsx`);
      const expectedImports = [
        `../features/${feature}`,
        ...(localDeclarations.length > 0 ? ["react-router-dom"] : []),
      ].sort();

      expect(modulePaths(source).sort()).toEqual(expectedImports);
      expect(jsxTags(source)).toEqual([featureExport]);

      const implementationStatements = source.statements.filter(
        (statement) => !ts.isImportDeclaration(statement),
      );
      expect(implementationStatements).toHaveLength(1);
      const pageFunction = implementationStatements[0];
      expect(pageFunction && ts.isFunctionDeclaration(pageFunction)).toBe(true);
      if (!pageFunction || !ts.isFunctionDeclaration(pageFunction)) return;
      expect(pageFunction.name?.text).toBe(pageExport);
      expect(
        pageFunction.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ),
      ).toBe(true);
      expect(localDeclarationSignatures(pageFunction)).toEqual(
        localDeclarations,
      );
      expect(callExpressionNames(pageFunction)).toEqual(
        [...allowedCalls].sort(),
      );

      const body = pageFunction.body;
      expect(body).toBeDefined();
      if (!body) return;
      expect(
        body.statements.map((statement) =>
          ts.isVariableStatement(statement)
            ? "variable"
            : ts.isReturnStatement(statement)
              ? "return"
              : "unsupported:" + ts.SyntaxKind[statement.kind],
        ),
      ).toEqual([...localDeclarations.map(() => "variable"), "return"]);

      const featureOpenings = jsxOpenings(source, featureExport);
      expect(featureOpenings).toHaveLength(1);
      const featureOpening = featureOpenings[0];
      if (featureOpening) {
        expect(jsxPropSignatures(source, featureOpening)).toEqual([
          ...featureProps,
        ]);
      }
    });
  },
);

describe.each(compositionFeatureContracts)(
  "$feature public composition contract",
  ({ feature, exports }) => {
    it("publishes only route-composable feature components", () => {
      const featureIndex = sourceFile(`features/${feature}/index.ts`);
      const contract = publicIndexContract(featureIndex);
      expect(contract.invalidStatements).toEqual([]);
      expect([...contract.names].sort()).toEqual([...exports].sort());
    });

    it("uses public indexes for every cross-feature import", () => {
      const directory = resolve(featuresDirectory, feature);
      const violations: string[] = [];
      let crossFeatureImportCount = 0;

      for (const file of productionTypeScriptFiles(directory)) {
        for (const modulePath of modulePaths(sourceFileAt(file))) {
          if (!modulePath.startsWith(".")) continue;
          const resolvedImport = resolve(dirname(file), modulePath);
          const targetFeature = targetFeatureName(resolvedImport);
          if (!targetFeature || targetFeature === feature) continue;
          crossFeatureImportCount += 1;
          if (!isPublicFeatureIndex(resolvedImport, targetFeature)) {
            violations.push(relative(srcDirectory, file) + " -> " + modulePath);
          }
        }
      }

      expect(crossFeatureImportCount).toBeGreaterThan(0);
      expect(violations).toEqual([]);
    });
  },
);

it("owns infinite-scroll observer policy once inside goal-history", () => {
  const owners = productionTypeScriptFiles(
    resolve(featuresDirectory, "goal-history"),
  )
    .filter((file) =>
      readFileSync(file, "utf8").includes("new IntersectionObserver"),
    )
    .map((file) => relative(srcDirectory, file));

  expect(owners).toEqual(["features/goal-history/useInfiniteScrollTrigger.ts"]);
});

it("fences every route-owned post-commit publication by route generation", () => {
  const routeOwnedFeatures = [
    "features/goal-creation/GoalCreationFeature.tsx",
    "features/goal-review/GoalReviewFeature.tsx",
    "features/cycle-workspace/CycleWorkspaceFeature.tsx",
  ];

  for (const feature of routeOwnedFeatures) {
    const source = readFileSync(resolve(srcDirectory, feature), "utf8");
    const taskCount =
      source.match(/\bvoid runPostCommitCleanup\(\{/g)?.length ?? 0;
    const routeOwnershipCount =
      source.match(/\brouteOwnership: captureRouteOwnership\(\),/g)?.length ??
      0;

    expect(taskCount).toBeGreaterThan(0);
    expect(routeOwnershipCount).toBe(taskCount);
  }
});

it("keeps cycle workspace generation and product policy owners unique", () => {
  const workspacePath = resolve(
    featuresDirectory,
    "cycle-workspace/CycleWorkspaceFeature.tsx",
  );
  const workspaceSource = sourceFileAt(workspacePath);
  const workspaceOpenings = jsxOpenings(workspaceSource, "CycleWorkspace");
  expect(workspaceOpenings).toHaveLength(1);
  const workspaceOpening = workspaceOpenings[0];
  expect(workspaceOpening).toBeDefined();
  if (!workspaceOpening) return;

  const keyAttribute = workspaceOpening.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) &&
      property.name.getText(workspaceSource) === "key",
  );
  expect(keyAttribute && ts.isJsxAttribute(keyAttribute)).toBe(true);
  if (!keyAttribute || !ts.isJsxAttribute(keyAttribute)) return;
  expect(
    keyAttribute.initializer &&
      ts.isJsxExpression(keyAttribute.initializer) &&
      keyAttribute.initializer.expression?.getText(workspaceSource),
  ).toBe("`${userId}:${cycleQuery.data.cycle.id}`");

  expect(
    existsSync(resolve(featuresDirectory, "cycle-editor/model/eligibility.ts")),
  ).toBe(false);

  const productionFiles = productionTypeScriptFiles(featuresDirectory);
  const eligibilityOwners = productionFiles
    .filter((file) =>
      readFileSync(file, "utf8").includes("function getCycleEligibility("),
    )
    .map((file) => relative(srcDirectory, file));
  expect(eligibilityOwners).toEqual([
    "features/cycle-workspace/model/eligibility.ts",
  ]);

  const goalPreferenceOwners = productionFiles
    .filter((file) =>
      readFileSync(file, "utf8").includes("function preferGoal("),
    )
    .map((file) => relative(srcDirectory, file));
  expect(goalPreferenceOwners).toEqual([
    "features/goal-collection/goalCache.ts",
  ]);
});
