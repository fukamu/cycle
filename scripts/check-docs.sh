#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
# shellcheck source=scripts/lib/docs-config-candidate-snapshot.sh
source "${script_dir}/lib/docs-config-candidate-snapshot.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"

if (($# > 0)); then
  [[ "$1" == "--help" && $# -eq 1 ]] || die "This command accepts no options."
  printf '%s\n' "Usage: ./scripts/check-docs.sh"
  exit 0
fi

require_command git
require_command node
node_major="$(node --print 'process.versions.node.split(".")[0]')"
[[ "${node_major}" =~ ^[0-9]+$ && "${node_major}" -ge 24 ]] \
  || die "Node.js 24 or newer is required for documentation checks."

candidate_root="$(mktemp -d)"
candidate_metadata_root="$(mktemp -d)"
trap 'rm -rf -- "${candidate_root}" "${candidate_metadata_root}"' EXIT
create_docs_config_candidate_snapshot \
  "${repo_root}" \
  "${candidate_root}" \
  "${candidate_metadata_root}"
assert_docs_config_snapshot_regular_file \
  "${candidate_root}" \
  "package.json" \
  "DOCUMENTATION_CANDIDATE_FILE_REQUIRED"
node "${script_dir}/check-docs.mjs" "${candidate_root}"
