#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
invite_id=""

usage() {
  cat <<'EOF'
Usage: ./scripts/new-beta-invite.sh --invite-id ID

Generate one raw Closed Beta invite token and its SHA-256 allowlist entry.
Run only in a private, unrecorded terminal.
EOF
}

while (($# > 0)); do
  case "$1" in
    --invite-id)
      (($# >= 2)) || die "--invite-id requires a value."
      invite_id="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "${invite_id}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] \
  || die "--invite-id must match ^[a-z0-9][a-z0-9_-]{0,63}$."
require_command openssl
require_command tr
require_command sha256sum
require_command awk

encoded="$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')"
[[ "${encoded}" =~ ^[A-Za-z0-9_-]{43}$ ]] \
  || die "Secure token generation returned an unexpected result."
token="fukamu_cycle_beta_${encoded}"
digest="$(printf '%s' "${token}" | sha256sum | awk '{print $1}')"
[[ "${digest}" =~ ^[0-9a-f]{64}$ ]] \
  || die "Invite digest generation returned an unexpected result."

warn "The raw invite token is displayed once. Do not run this script in a recorded or shared terminal."
printf 'Invite ID: %s\n' "${invite_id}"
printf 'Token: %s\n' "${token}"
printf 'Allowlist entry: {"id":"%s","digest":"%s"}\n' "${invite_id}" "${digest}"
