#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

fail_configuration() {
  local run_id="local"
  local run_attempt="local"
  local commit_sha="local"
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] && run_id="${GITHUB_RUN_ID}"
  [[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] && run_attempt="${GITHUB_RUN_ATTEMPT}"
  [[ "${COMMIT_SHA:-}" =~ ^[0-9a-f]{40}$ ]] && commit_sha="${COMMIT_SHA}"
  printf '%s\n' "::error::Staging CSRF rollout failed; phase=configuration; reason=unexpected_status; run_id=${run_id}; run_attempt=${run_attempt}; commit_sha=${commit_sha}." >&2
  exit 1
}

if (($# != 0)); then
  fail_configuration
fi
if [[ ! "${STAGING_BASE_URL:-}" =~ [^[:space:]] ]]; then
  fail_configuration
fi
if [[ "${STAGING_ADMISSION_MODE:-}" != "auto" && "${STAGING_ADMISSION_MODE:-}" != "off" && "${STAGING_ADMISSION_MODE:-}" != "closed" ]]; then
  fail_configuration
fi
if [[ "${STAGING_ADMISSION_MODE}" != "off" && ! "${STAGING_E2E_INVITE_TOKEN:-}" =~ [^[:space:]] ]]; then
  fail_configuration
fi

unset DEBUG NODE_DEBUG NODE_OPTIONS PWDEBUG
if [[ "${STAGING_ADMISSION_MODE}" == "off" ]]; then
  unset STAGING_E2E_INVITE_TOKEN
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/..")"
cd -- "${repo_root}"

exec node "${repo_root}/frontend/e2e/staging-csrf-rollout.mjs"
