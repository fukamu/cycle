#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  readFileSync(
    resolve(scriptDirectory, "../config/deployment-contract.json"),
    "utf8",
  ),
);
const stagingPublicOrigin = "https://cycle.staging.fukamu.matoruru.com";
const allowedReferralURL = "https://cycle.fukamu.com/";
const stagingTurnstileSiteKey = "1x00000000000000000000BB";
const stagingTurnstileSecretKey = "1x0000000000000000000000000000000AA";

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

  const publicOrigin = stringValue(environment, "PUBLIC_ORIGIN");
  if (!missing.has("PUBLIC_ORIGIN") && publicOrigin !== stagingPublicOrigin) {
    addProblem("INVALID_INPUT", "PUBLIC_ORIGIN");
  }

  const referralName = contract.frontend.optional.VITE_APP_REFERRAL_URL;
  const referralURL = stringValue(environment, referralName) ?? "";
  if (referralURL !== "" && referralURL !== allowedReferralURL) {
    addProblem("INVALID_INPUT", referralName);
  }

  const contactName = contract.frontend.required.VITE_PRIVACY_CONTACT_URL;
  const contactURL = stringValue(environment, contactName);
  if (!missing.has(contactName) && !isPublicHTTPSURL(contactURL)) {
    addProblem("INVALID_INPUT", contactName);
  }

  const backupMaxDaysName =
    contract.frontend.required.VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS;
  const backupMaxDays = stringValue(environment, backupMaxDaysName)?.trim();
  if (
    !missing.has(backupMaxDaysName) &&
    (backupMaxDays === undefined ||
      !/^[1-9][0-9]*$/u.test(backupMaxDays) ||
      !Number.isSafeInteger(Number(backupMaxDays)))
  ) {
    addProblem("INVALID_INPUT", backupMaxDaysName);
  }

  for (const [name, expected] of [
    ["TURNSTILE_SITE_KEY", stagingTurnstileSiteKey],
    ["TURNSTILE_SECRET_KEY", stagingTurnstileSecretKey],
  ]) {
    if (!missing.has(name) && stringValue(environment, name) !== expected) {
      addProblem("INVALID_INPUT", name);
    }
  }

  return problems;
}

function requiredInputNames(deploymentContract) {
  return unique([
    ...deploymentContract.backend.githubVariables,
    ...deploymentContract.backend.secrets,
    ...Object.values(deploymentContract.frontend.required),
    ...deploymentContract.deploy.requiredOnly,
  ]);
}

function hasValue(environment, name) {
  const value = stringValue(environment, name);
  return value !== undefined && value.trim() !== "";
}

function stringValue(environment, name) {
  const value = environment[name];
  return typeof value === "string" ? value : undefined;
}

function isPublicHTTPSURL(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
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
