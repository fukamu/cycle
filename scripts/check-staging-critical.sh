#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

fail_configuration() {
  local run_id="local"
  local run_attempt="local"
  local commit_sha="local"
  local target="unknown"
  local mutation_started="unknown"
  local cleanup_state="not_started"
  local diagnostic_level="error"
  local diagnostic_name="Staging critical failed"
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] && run_id="${GITHUB_RUN_ID}"
  [[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] && run_attempt="${GITHUB_RUN_ATTEMPT}"
  [[ "${COMMIT_SHA:-}" =~ ^[0-9a-f]{40}$ ]] && commit_sha="${COMMIT_SHA}"
  case "${STAGING_CRITICAL_MODE:-}" in
    preflight)
      target="current-public"
      mutation_started="false"
      cleanup_state="not_applicable"
      ;;
    baseline)
      target="current-public"
      mutation_started="false"
      diagnostic_level="warning"
      diagnostic_name="Staging critical diagnostic failed"
      ;;
    full)
      target="candidate-public"
      mutation_started="true"
      ;;
  esac
  printf '%s\n' "::${diagnostic_level}::${diagnostic_name}; target=${target}; mutation_started=${mutation_started}; cleanup_state=${cleanup_state}; phase=configuration; reason=unexpected_status; run_id=${run_id}; run_attempt=${run_attempt}; candidate_sha=${commit_sha}." >&2
  exit 1
}

if (($# != 0)); then
  fail_configuration
fi

if [[ ! "${STAGING_BASE_URL:-}" =~ [^[:space:]] ]]; then
  fail_configuration
fi
if [[ "${STAGING_CRITICAL_MODE:-}" != "preflight" && "${STAGING_CRITICAL_MODE:-}" != "baseline" && "${STAGING_CRITICAL_MODE:-}" != "full" ]]; then
  fail_configuration
fi
if [[ "${STAGING_CRITICAL_MODE}" == "preflight" ]]; then
  if [[ -n "${STAGING_ADMISSION_MODE+x}" || -n "${STAGING_E2E_INVITE_TOKEN+x}" ]]; then
    fail_configuration
  fi
else
  if [[ "${STAGING_ADMISSION_MODE:-}" != "auto" && "${STAGING_ADMISSION_MODE:-}" != "off" && "${STAGING_ADMISSION_MODE:-}" != "closed" ]]; then
    fail_configuration
  fi
  if [[ "${STAGING_ADMISSION_MODE}" != "off" && ! "${STAGING_E2E_INVITE_TOKEN:-}" =~ [^[:space:]] ]]; then
    fail_configuration
  fi
fi

# Playwright debug modes can print browser evaluation arguments. The invite
# token must remain available only to the dedicated harness process.
unset DEBUG NODE_DEBUG NODE_OPTIONS PWDEBUG
if [[ "${STAGING_CRITICAL_MODE}" == "preflight" ]]; then
  unset STAGING_ADMISSION_MODE
  unset STAGING_E2E_INVITE_TOKEN
elif [[ "${STAGING_ADMISSION_MODE}" == "off" ]]; then
  unset STAGING_E2E_INVITE_TOKEN
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/..")"
cd -- "${repo_root}"

exec node "${repo_root}/frontend/e2e/staging-critical.mjs"
