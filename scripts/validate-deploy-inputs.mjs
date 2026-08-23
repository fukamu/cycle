#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseBetaAdmissionConfig } from "../cloudflare/src/beta-admission/beta-admission.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(
    resolve(scriptDirectory, "../config/deployment-contract.json"),
    "utf8",
  ),
);
const stagingPublicOrigin = "https://cycle.staging.fukamu.matoruru.com";
const allowedReferralURL = "https://cycle.fukamu.com/";

export function validateDeploymentInputs(environment) {
  const problems = [];
  const problemKeys = new Set();
  const missing = new Set();
  const addProblem = (code, key) => {
    const problemKey = `${code}:${key}`;
    if (problemKeys.has(problemKey)) return;
    problemKeys.add(problemKey);
    problems.push({ code, key });
  };

  for (const name of requiredInputNames(contract)) {
    if (hasValue(environment, name)) continue;
    missing.add(name);
    addProblem("MISSING_REQUIRED_INPUT", name);
  }

  const modeName = contract.closedBeta.mode.name;
  if (stringValue(environment, modeName) === "closed") {
    for (const name of [
      ...contract.closedBeta.conditionalVariables,
      ...contract.closedBeta.conditionalSecrets,
    ]) {
      if (hasValue(environment, name)) continue;
      missing.add(name);
      addProblem("MISSING_REQUIRED_INPUT", name);
    }
  }

  const publicOrigin = stringValue(environment, "PUBLIC_ORIGIN");
  if (!missing.has("PUBLIC_ORIGIN") && publicOrigin !== stagingPublicOrigin) {
    addProblem("INVALID_INPUT", "PUBLIC_ORIGIN");
  }

  const referralName = contract.frontend.optional.VITE_APP_REFERRAL_URL;
  const referralURL = stringValue(environment, referralName) ?? "";
  if (referralURL !== "" && referralURL !== allowedReferralURL) {
    addProblem("INVALID_INPUT", referralName);
  }

  try {
    parseBetaAdmissionConfig({
      PUBLIC_ORIGIN: publicOrigin,
      BETA_ADMISSION_MODE: stringValue(environment, modeName),
      BETA_ADMISSION_COOKIE_TTL_DAYS: stringValue(
        environment,
        "BETA_ADMISSION_COOKIE_TTL_DAYS",
      ),
      BETA_INVITES: stringValue(environment, "BETA_INVITES"),
      BETA_ADMISSION_COOKIE_KEY: stringValue(
        environment,
        "BETA_ADMISSION_COOKIE_KEY",
      ),
    });
  } catch (error) {
    const key = betaAdmissionErrorKey(error, contract);
    if (!missing.has(key)) addProblem("INVALID_INPUT", key);
  }

  return problems;
}

function requiredInputNames(deploymentContract) {
  return unique([
    ...deploymentContract.backend.githubVariables,
    ...deploymentContract.backend.secrets,
    deploymentContract.closedBeta.mode.name,
    ...Object.values(deploymentContract.frontend.required),
    ...deploymentContract.deploy.requiredOnly,
  ]);
}

function betaAdmissionErrorKey(error, deploymentContract) {
  const message = error instanceof Error ? error.message : "";
  const names = [
    "PUBLIC_ORIGIN",
    deploymentContract.closedBeta.mode.name,
    ...deploymentContract.closedBeta.conditionalVariables,
    ...deploymentContract.closedBeta.conditionalSecrets,
  ];
  return (
    names.find((name) => message.includes(name)) ?? "BETA_ADMISSION_CONFIG"
  );
}

function hasValue(environment, name) {
  const value = stringValue(environment, name);
  return value !== undefined && value.trim() !== "";
}

function stringValue(environment, name) {
  const value = environment[name];
  return typeof value === "string" ? value : undefined;
}

function unique(values) {
  return [...new Set(values)];
}

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const problems = validateDeploymentInputs(process.env);
  for (const problem of problems) {
    console.error(`::error::${problem.code}:${problem.key}`);
  }
  if (problems.length > 0) process.exitCode = 1;
}
