import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workerSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts"),
  "utf8",
);

test("backend forwarding preserves incoming trace context without synthesizing it", () => {
  assert.match(
    workerSource,
    /const headers = new Headers\(request\.headers\);/,
  );
  assert.match(
    workerSource,
    /const forwarded = new Request\(request, \{ headers \}\);/,
  );
  assert.doesNotMatch(
    workerSource,
    /headers\.(?:set|delete|append)\(\s*["']trace(?:parent|state)["']/i,
  );
});
