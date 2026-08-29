#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"

if (($# > 0)); then
  [[ "$1" == "--help" && $# -eq 1 ]] || die "This command accepts no options."
  printf '%s\n' "Usage: ./scripts/new-beta-admission-key.sh"
  exit 0
fi

require_command openssl
require_command tr
key="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
[[ "${key}" =~ ^[A-Za-z0-9_-]{43}$ ]] \
  || die "Secure key generation returned an unexpected result."

warn "The cookie signing key is displayed once. Store it directly as BETA_ADMISSION_COOKIE_KEY and do not record it elsewhere."
printf '%s\n' "${key}"
