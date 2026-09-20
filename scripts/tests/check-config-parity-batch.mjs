import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "node:test";
import { inspect } from "node:util";

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  throw new Error("usage: check-config-parity-batch.mjs MANIFEST");
}

const fields = readFileSync(manifestPath, "utf8").split("\0");
if (fields.at(-1) === "") fields.pop();
if (fields.length === 0 || fields.length % 4 !== 0) {
  throw new Error("configuration parity batch manifest is malformed");
}

const cases = [];
for (let index = 0; index < fields.length; index += 4) {
  const [fixtureRoot, expectation, description, expectedMessage] = fields.slice(
    index,
    index + 4,
  );
  if (expectation !== "pass" && expectation !== "fail") {
    throw new Error(`unsupported batch expectation: ${expectation}`);
  }
  cases.push({
    description,
    expectation,
    expectedMessage,
    testFile: resolve(
      fixtureRoot,
      "cloudflare/src/config/deployment-contract.test.mjs",
    ),
  });
}

const results = new Map(
  cases.map(({ testFile }) => [testFile, { failures: [], observed: false }]),
);
const stream = run({
  concurrency: false,
  files: cases.map(({ testFile }) => testFile),
  isolation: "none",
});

for await (const event of stream) {
  const file = event.data?.file;
  if (!file) continue;
  const result = results.get(resolve(file));
  if (!result) continue;
  result.observed = true;
  if (event.type === "test:fail") {
    result.failures.push(event.data.details?.error);
  }
}

const problems = [];
for (const testCase of cases) {
  const result = results.get(testCase.testFile);
  if (!result.observed) {
    problems.push(`${testCase.description}: test file was not executed`);
    continue;
  }
  if (testCase.expectation === "pass") {
    if (result.failures.length > 0) {
      problems.push(
        `${testCase.description}: unexpectedly failed\n${formatFailures(result.failures)}`,
      );
    }
    continue;
  }
  if (result.failures.length === 0) {
    problems.push(`${testCase.description}: unexpectedly succeeded`);
    continue;
  }
  const failureText = formatFailures(result.failures);
  if (!failureText.includes(testCase.expectedMessage)) {
    problems.push(
      `${testCase.description}: did not report ${testCase.expectedMessage}\n${failureText}`,
    );
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n\n"));
  process.exitCode = 1;
}

function formatFailures(failures) {
  return failures
    .map((error) => {
      if (error instanceof Error) {
        return [error.message, error.stack].filter(Boolean).join("\n");
      }
      return inspect(error, { depth: 8 });
    })
    .join("\n");
}
