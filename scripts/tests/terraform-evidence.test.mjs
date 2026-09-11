import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runTerraformEvidenceCLI } from "../terraform-evidence.mjs";

const commitSHA = "a".repeat(40);
const otherCommitSHA = "b".repeat(40);
const planRunID = "12345";
const applyRunID = "23456";

function collectingOutput() {
  let contents = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        contents += chunk.toString("utf8");
        callback();
      },
    }),
    contents: () => contents,
  };
}

async function run(env, argv = []) {
  const output = collectingOutput();
  const errorOutput = collectingOutput();
  const status = await runTerraformEvidenceCLI({
    argv,
    env,
    output: output.stream,
    errorOutput: errorOutput.stream,
  });
  return {
    status,
    output: output.contents(),
    error: errorOutput.contents(),
  };
}

async function expectFailure(env, argv = []) {
  const result = await run(env, argv);
  assert.deepEqual(result, {
    status: 1,
    output: "",
    error: "terraform evidence failed\n",
  });
}

async function withFixture(callback) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cycle-terraform-evidence-"),
  );
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function checksum(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function writePlanEnvironment(directory, result, overrides = {}) {
  return {
    TERRAFORM_EVIDENCE_OPERATION: "write_plan",
    TERRAFORM_PLAN_FILE: path.join(directory, "staging.tfplan"),
    TERRAFORM_PLAN_EVIDENCE_FILE: path.join(
      directory,
      "terraform-plan-evidence.json",
    ),
    TERRAFORM_PLAN_RESULT: result,
    COMMIT_SHA: commitSHA,
    GITHUB_RUN_ID: planRunID,
    ...overrides,
  };
}

function verifyPlanEnvironment(directory, result, overrides = {}) {
  return {
    TERRAFORM_EVIDENCE_OPERATION: "verify_plan",
    TERRAFORM_EVIDENCE_DIRECTORY: directory,
    EXPECTED_COMMIT_SHA: commitSHA,
    EXPECTED_WORKFLOW_RUN_ID: planRunID,
    EXPECTED_PLAN_RESULT: result,
    ...overrides,
  };
}

async function createPlanEvidence(directory, result = "changes_present") {
  const contents = `terraform-plan-${result}`;
  await writeFile(path.join(directory, "staging.tfplan"), contents);
  const writeResult = await run(writePlanEnvironment(directory, result));
  assert.deepEqual(writeResult, { status: 0, output: "", error: "" });
  return { contents, planSHA256: checksum(contents) };
}

function writeApplyEnvironment(planDirectory, applyDirectory, overrides = {}) {
  return {
    TERRAFORM_EVIDENCE_OPERATION: "write_apply",
    TERRAFORM_PLAN_EVIDENCE_FILE: path.join(
      planDirectory,
      "terraform-plan-evidence.json",
    ),
    TERRAFORM_APPLY_EVIDENCE_FILE: path.join(
      applyDirectory,
      "terraform-apply-evidence.json",
    ),
    COMMIT_SHA: commitSHA,
    GITHUB_RUN_ID: applyRunID,
    PLAN_RUN_ID: planRunID,
    ...overrides,
  };
}

function verifyApplyEnvironment(directory, overrides = {}) {
  return {
    TERRAFORM_EVIDENCE_OPERATION: "verify_apply",
    TERRAFORM_EVIDENCE_DIRECTORY: directory,
    EXPECTED_COMMIT_SHA: commitSHA,
    EXPECTED_WORKFLOW_RUN_ID: applyRunID,
    ...overrides,
  };
}

test("writes and verifies exact Plan evidence for both detailed-exit results", async () => {
  for (const result of ["no_changes", "changes_present"]) {
    await withFixture(async (directory) => {
      const { planSHA256 } = await createPlanEvidence(directory, result);
      const evidenceFile = path.join(directory, "terraform-plan-evidence.json");
      assert.equal((await lstat(evidenceFile)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(evidenceFile, "utf8")), {
        schemaVersion: 1,
        result,
        commitSHA,
        workflowRunID: planRunID,
        planSHA256,
      });

      assert.deepEqual(await run(verifyPlanEnvironment(directory, result)), {
        status: 0,
        output: `${planSHA256}\n`,
        error: "",
      });
    });
  }
});

test("rejects a Plan exit-result mismatch and stale identity", async () => {
  await withFixture(async (directory) => {
    await createPlanEvidence(directory, "no_changes");
    await expectFailure(verifyPlanEnvironment(directory, "changes_present"));
    await expectFailure(
      verifyPlanEnvironment(directory, "no_changes", {
        EXPECTED_COMMIT_SHA: otherCommitSHA,
      }),
    );
    await expectFailure(
      verifyPlanEnvironment(directory, "no_changes", {
        EXPECTED_WORKFLOW_RUN_ID: "999",
      }),
    );
  });
});

test("rejects tampered Plan content, extra entries, and extra evidence keys", async () => {
  await withFixture(async (directory) => {
    await createPlanEvidence(directory);
    await writeFile(path.join(directory, "staging.tfplan"), "tampered-plan");
    await expectFailure(verifyPlanEnvironment(directory, "changes_present"));
  });

  await withFixture(async (directory) => {
    await createPlanEvidence(directory);
    await writeFile(path.join(directory, "unexpected.txt"), "unexpected");
    await expectFailure(verifyPlanEnvironment(directory, "changes_present"));
  });

  await withFixture(async (directory) => {
    await createPlanEvidence(directory);
    const evidenceFile = path.join(directory, "terraform-plan-evidence.json");
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    evidence.unexpected = true;
    await writeFile(evidenceFile, JSON.stringify(evidence));
    await expectFailure(verifyPlanEnvironment(directory, "changes_present"));
  });
});

test("rejects symlink and oversized Plan evidence", async () => {
  await withFixture(async (directory) => {
    const actualDirectory = path.join(directory, "actual");
    const artifactDirectory = path.join(directory, "artifact");
    await mkdir(actualDirectory);
    await mkdir(artifactDirectory);
    await createPlanEvidence(actualDirectory);
    await writeFile(
      path.join(artifactDirectory, "staging.tfplan"),
      "terraform-plan-changes_present",
    );
    await symlink(
      path.join(actualDirectory, "terraform-plan-evidence.json"),
      path.join(artifactDirectory, "terraform-plan-evidence.json"),
    );
    await expectFailure(
      verifyPlanEnvironment(artifactDirectory, "changes_present"),
    );
  });

  await withFixture(async (directory) => {
    await writeFile(path.join(directory, "staging.tfplan"), "plan");
    await writeFile(
      path.join(directory, "terraform-plan-evidence.json"),
      " ".repeat(4097),
    );
    await expectFailure(verifyPlanEnvironment(directory, "changes_present"));
  });
});

test("does not overwrite an existing evidence output and writes mode 0600", async () => {
  await withFixture(async (directory) => {
    await writeFile(path.join(directory, "staging.tfplan"), "plan");
    const evidenceFile = path.join(directory, "terraform-plan-evidence.json");
    await writeFile(evidenceFile, "preserve");
    await chmod(evidenceFile, 0o644);
    await expectFailure(writePlanEnvironment(directory, "changes_present"));
    assert.equal(await readFile(evidenceFile, "utf8"), "preserve");
    assert.equal((await lstat(evidenceFile)).mode & 0o777, 0o644);
  });
});

test("rejects no-change Plan evidence as an Apply source", async () => {
  await withFixture(async (directory) => {
    const planDirectory = path.join(directory, "plan");
    const applyDirectory = path.join(directory, "apply");
    await mkdir(planDirectory);
    await mkdir(applyDirectory);
    await createPlanEvidence(planDirectory, "no_changes");
    await expectFailure(writeApplyEnvironment(planDirectory, applyDirectory));
    await assert.rejects(
      lstat(path.join(applyDirectory, "terraform-apply-evidence.json")),
      { code: "ENOENT" },
    );
  });
});

test("writes and verifies exact Apply evidence", async () => {
  await withFixture(async (directory) => {
    const planDirectory = path.join(directory, "plan");
    const applyDirectory = path.join(directory, "apply");
    await mkdir(planDirectory);
    await mkdir(applyDirectory);
    const { planSHA256 } = await createPlanEvidence(planDirectory);
    assert.deepEqual(
      await run(writeApplyEnvironment(planDirectory, applyDirectory)),
      { status: 0, output: "", error: "" },
    );
    const evidenceFile = path.join(
      applyDirectory,
      "terraform-apply-evidence.json",
    );
    assert.equal((await lstat(evidenceFile)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(evidenceFile, "utf8")), {
      schemaVersion: 1,
      result: "applied_plan",
      commitSHA,
      workflowRunID: applyRunID,
      sourcePlanWorkflowRunID: planRunID,
      planSHA256,
    });
    assert.deepEqual(await run(verifyApplyEnvironment(applyDirectory)), {
      status: 0,
      output: `${planSHA256}\n`,
      error: "",
    });
  });
});

test("rejects stale or invalid Apply evidence", async () => {
  await withFixture(async (directory) => {
    const planDirectory = path.join(directory, "plan");
    const applyDirectory = path.join(directory, "apply");
    await mkdir(planDirectory);
    await mkdir(applyDirectory);
    await createPlanEvidence(planDirectory);
    await run(writeApplyEnvironment(planDirectory, applyDirectory));

    await expectFailure(
      verifyApplyEnvironment(applyDirectory, {
        EXPECTED_COMMIT_SHA: otherCommitSHA,
      }),
    );
    await expectFailure(
      verifyApplyEnvironment(applyDirectory, {
        EXPECTED_WORKFLOW_RUN_ID: "999",
      }),
    );

    const evidenceFile = path.join(
      applyDirectory,
      "terraform-apply-evidence.json",
    );
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    evidence.result = "no_changes";
    await writeFile(evidenceFile, JSON.stringify(evidence));
    await expectFailure(verifyApplyEnvironment(applyDirectory));
  });
});

test("rejects invalid operations, arguments, paths, and source identity", async () => {
  await expectFailure({ TERRAFORM_EVIDENCE_OPERATION: "unknown" });
  await expectFailure({ TERRAFORM_EVIDENCE_OPERATION: "verify_plan" }, [
    "unexpected",
  ]);

  await withFixture(async (directory) => {
    await writeFile(path.join(directory, "staging.tfplan"), "plan");
    await expectFailure(
      writePlanEnvironment(directory, "changes_present", {
        TERRAFORM_PLAN_FILE: "staging.tfplan",
      }),
    );
  });

  await withFixture(async (directory) => {
    const planDirectory = path.join(directory, "plan");
    const applyDirectory = path.join(directory, "apply");
    await mkdir(planDirectory);
    await mkdir(applyDirectory);
    await createPlanEvidence(planDirectory);
    await expectFailure(
      writeApplyEnvironment(planDirectory, applyDirectory, {
        PLAN_RUN_ID: "999",
      }),
    );
    await expectFailure(
      writeApplyEnvironment(planDirectory, applyDirectory, {
        COMMIT_SHA: otherCommitSHA,
      }),
    );
  });
});
