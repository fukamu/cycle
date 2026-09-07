#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const requiredSecretNames = Object.freeze([
  "DATABASE_URL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "SESSION_TOKEN_PEPPER",
  "CSRF_TOKEN_PEPPER",
  "BOOTSTRAP_ID_PEPPER",
  "RATE_LIMIT_HMAC_SECRET",
  "CURSOR_SIGNING_SECRET",
  "OPENAI_API_KEY",
  "TURNSTILE_SECRET_KEY",
]);

export function materializeStagingWorkerSecrets({
  argv = process.argv.slice(2),
  env = process.env,
  writeFile = writeFileSync,
} = {}) {
  if (
    argv.length !== 0 ||
    typeof env.WORKER_SECRETS_FILE !== "string" ||
    !env.WORKER_SECRETS_FILE.startsWith("/") ||
    typeof writeFile !== "function"
  ) {
    throw new Error("staging Worker secret materialization failed");
  }
  const names = [...requiredSecretNames];
  if (env.BETA_ADMISSION_MODE === "closed") {
    names.push("BETA_ADMISSION_COOKIE_KEY");
  } else if (env.BETA_ADMISSION_MODE !== "off") {
    throw new Error("staging Worker secret materialization failed");
  }
  if (
    names.some((name) => typeof env[name] !== "string" || !/\S/.test(env[name]))
  ) {
    throw new Error("staging Worker secret materialization failed");
  }
  const values = Object.fromEntries(names.map((name) => [name, env[name]]));
  writeFile(env.WORKER_SECRETS_FILE, JSON.stringify(values), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    materializeStagingWorkerSecrets();
  } catch {
    process.stderr.write(
      "::error::Staging Worker secret materialization failed.\n",
    );
    process.exitCode = 1;
  }
}
