import { randomBytes } from "node:crypto";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  formatStagingCSRFRolloutDiagnostic,
  runStagingCSRFRollout,
  StagingCSRFRolloutFailure,
} from "../../scripts/lib/staging-csrf-rollout.mjs";
import {
  deriveBootstrapUUIDv7,
  parseStagingAdmissionMode,
  parseStagingBaseURL,
  validateStagingInviteToken,
} from "../../scripts/lib/staging-critical.mjs";
import { createStagingCSRFRolloutBrowserAdapter } from "./staging-csrf-rollout-entry.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

let adapter;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  if (adapter !== undefined) {
    adapter.interrupt();
  }
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

let failures;
let runMetadata = { runID: "local", runAttempt: "local", commitSHA: "local" };
let inviteToken = "";
try {
  const baseURL = parseStagingBaseURL(process.env.STAGING_BASE_URL);
  const admissionMode = parseStagingAdmissionMode(
    process.env.STAGING_ADMISSION_MODE,
  );
  if (admissionMode !== "off") {
    inviteToken = validateStagingInviteToken(
      process.env.STAGING_E2E_INVITE_TOKEN,
    );
  }
  runMetadata = parseRunMetadata(process.env);

  delete process.env.STAGING_E2E_INVITE_TOKEN;
  delete process.env.DEBUG;
  delete process.env.NODE_DEBUG;
  delete process.env.NODE_OPTIONS;
  delete process.env.PWDEBUG;

  const timestampMilliseconds = Date.now();
  const privateRunKey = randomBytes(32).toString("hex");
  adapter = createStagingCSRFRolloutBrowserAdapter({
    baseURL,
    admissionMode,
    inviteToken,
    bootstrapID: deriveBootstrapUUIDv7(
      `${privateRunKey}:bootstrap`,
      timestampMilliseconds,
    ),
    marker: randomBytes(6).toString("hex"),
    repositoryRoot,
    retryCheckpointEnabled: runMetadata.runID !== "local",
  });
  inviteToken = "";
  failures = await runStagingCSRFRollout({ adapter });
} catch {
  failures = [
    new StagingCSRFRolloutFailure("configuration", "unexpected_status"),
  ];
} finally {
  inviteToken = "";
  if (adapter !== undefined) {
    await adapter.close().catch(() => undefined);
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

if (interrupted && failures.length === 0) {
  failures.push(
    new StagingCSRFRolloutFailure("browser_launch", "unexpected_status"),
  );
}
for (const failure of failures) {
  process.stderr.write(
    `${formatStagingCSRFRolloutDiagnostic(failure, runMetadata)}\n`,
  );
}
if (failures.length > 0 || interrupted) {
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Staging stable CSRF rollout and public account cleanup succeeded.\n",
  );
}

function parseRunMetadata(environment) {
  if (environment.GITHUB_ACTIONS !== "true") {
    return { runID: "local", runAttempt: "local", commitSHA: "local" };
  }
  if (
    typeof environment.GITHUB_RUN_ID !== "string" ||
    !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID) ||
    typeof environment.GITHUB_RUN_ATTEMPT !== "string" ||
    !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ATTEMPT) ||
    typeof environment.COMMIT_SHA !== "string" ||
    !/^[0-9a-f]{40}$/.test(environment.COMMIT_SHA)
  ) {
    throw new Error("GitHub staging run identity is invalid");
  }
  return {
    runID: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    commitSHA: environment.COMMIT_SHA,
  };
}
