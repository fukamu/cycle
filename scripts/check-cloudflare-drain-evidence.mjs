#!/usr/bin/env node

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CloudflareDrainFailure,
  createCloudflareRawAdapter,
  formatCloudflareDrainDiagnostic,
  proveCloudflareDrain,
  serializeCloudflareDrainEvidence,
} from "./lib/cloudflare-drain-evidence.mjs";

const workerName = "fukamu-cycle-staging";
const containerApplicationName = "fukamu-cycle-staging-backend";
const wakeSignal = "cloudflare_drain_baseline_ready\n";
const wakeAcknowledgement = "candidate_deploy_completed\n";
const maximumAcknowledgementBytes = 64;
const maximumDockerOutputBytes = 64 * 1024;
const accountIDPattern = /^[0-9a-f]{32}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const namePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;

export async function resolveLocalCandidateImageDigest({
  accountId,
  applicationName,
  workerVersionId,
  execFileImpl = execFile,
}) {
  if (
    typeof accountId !== "string" ||
    !accountIDPattern.test(accountId) ||
    typeof applicationName !== "string" ||
    !namePattern.test(applicationName) ||
    typeof workerVersionId !== "string" ||
    !uuidPattern.test(workerVersionId) ||
    typeof execFileImpl !== "function"
  ) {
    throw new Error("local candidate image identity is invalid");
  }

  const localImageTag = `${applicationName}:${workerVersionId.split("-")[0]}`;
  const stdout = await new Promise((resolve, reject) => {
    execFileImpl(
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", localImageTag],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        killSignal: "SIGTERM",
        maxBuffer: maximumDockerOutputBytes,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, output) => {
        if (error !== null) reject(error);
        else resolve(output);
      },
    );
  });
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") > maximumDockerOutputBytes
  ) {
    throw new Error("local candidate image evidence is invalid");
  }

  let repositoryDigests;
  try {
    repositoryDigests = JSON.parse(stdout);
  } catch {
    throw new Error("local candidate image evidence is invalid");
  }
  if (!Array.isArray(repositoryDigests) || repositoryDigests.length > 32) {
    throw new Error("local candidate image evidence is invalid");
  }
  const expectedPrefix = `registry.cloudflare.com/${accountId}/${applicationName}@`;
  const matches = [];
  for (const value of repositoryDigests) {
    if (typeof value !== "string" || value.length > 1024) {
      throw new Error("local candidate image evidence is invalid");
    }
    if (value.startsWith(expectedPrefix)) {
      const digest = value.slice(expectedPrefix.length);
      if (!imageDigestPattern.test(digest)) {
        throw new Error("local candidate image evidence is invalid");
      }
      matches.push(digest);
    }
  }
  if (matches.length !== 1) {
    throw new Error("local candidate image evidence is invalid");
  }
  return matches[0];
}

function metadata(env) {
  return {
    runID: /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "")
      ? env.GITHUB_RUN_ID
      : "local",
    runAttempt: /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
      ? env.GITHUB_RUN_ATTEMPT
      : "local",
    commitSHA: /^[0-9a-f]{40}$/.test(env.COMMIT_SHA ?? "")
      ? env.COMMIT_SHA
      : "local",
  };
}

async function write(output, value) {
  if (output.write(value)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("output failed"));
    };
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("error", onError);
    };
    output.once("drain", onDrain);
    output.once("error", onError);
  });
}

async function waitForWakeAcknowledgement(input) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const fail = () => {
      cleanup();
      reject(new Error("wake acknowledgement failed"));
    };
    const onError = () => fail();
    const onEnd = () => fail();
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received = Buffer.concat([received, bytes]);
      if (received.length > maximumAcknowledgementBytes) {
        fail();
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      if (
        newline !== received.length - 1 ||
        received.toString("utf8") !== wakeAcknowledgement
      ) {
        fail();
        return;
      }
      cleanup();
      resolve();
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

export async function runCloudflareDrainEvidenceCLI({
  argv = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  fetchImpl = fetch,
  resolveCandidateImageDigest,
  now,
  sleep,
} = {}) {
  const diagnosticMetadata = metadata(env);
  try {
    if (argv.length !== 0) {
      throw new CloudflareDrainFailure(
        "configuration",
        "invalid_configuration",
      );
    }
    const candidateCommitSHA = env.COMMIT_SHA;
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const adapter = createCloudflareRawAdapter({
      accountId,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      workerName,
      containerApplicationName,
      fetchImpl,
    });

    if (env === process.env) {
      delete process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.DEBUG;
      delete process.env.NODE_DEBUG;
    }
    const evidence = await proveCloudflareDrain({
      candidateCommitSHA,
      rawAdapter: adapter,
      resolveCandidateImageDigest:
        resolveCandidateImageDigest ??
        (({ workerVersionId }) =>
          resolveLocalCandidateImageDigest({
            accountId,
            applicationName: containerApplicationName,
            workerVersionId,
          })),
      ...(now === undefined ? {} : { now }),
      ...(sleep === undefined ? {} : { sleep }),
      wake: async () => {
        await write(output, wakeSignal);
        await waitForWakeAcknowledgement(input);
      },
    });
    await write(output, serializeCloudflareDrainEvidence(evidence));
    return 0;
  } catch (error) {
    const failure =
      error instanceof CloudflareDrainFailure
        ? error
        : new CloudflareDrainFailure("configuration", "invalid_configuration");
    await write(
      errorOutput,
      `${formatCloudflareDrainDiagnostic(failure, diagnosticMetadata)}\n`,
    ).catch(() => undefined);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCloudflareDrainEvidenceCLI();
}
