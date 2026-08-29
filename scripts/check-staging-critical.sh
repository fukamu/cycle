#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

if (($# != 0)); then
  printf '%s\n' 'Usage: STAGING_BASE_URL=... STAGING_E2E_INVITE_TOKEN=... ./scripts/check-staging-critical.sh' >&2
  exit 2
fi

if [[ ! "${STAGING_BASE_URL:-}" =~ [^[:space:]] ]]; then
  printf '%s\n' '::error::STAGING_BASE_URL is required for the staging critical journey.' >&2
  exit 1
fi
if [[ ! "${STAGING_E2E_INVITE_TOKEN:-}" =~ [^[:space:]] ]]; then
  printf '%s\n' '::error::STAGING_E2E_INVITE_TOKEN is required for the staging critical journey.' >&2
  exit 1
fi

# Playwright debug modes can print browser evaluation arguments. The invite
# token must remain available only to the dedicated harness process.
unset DEBUG NODE_DEBUG NODE_OPTIONS PWDEBUG

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/..")"
cd -- "${repo_root}"

exec node "${repo_root}/frontend/e2e/staging-critical.mjs"
