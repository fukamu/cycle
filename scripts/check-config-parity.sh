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
  printf '%s\n' "Usage: ./scripts/check-config-parity.sh"
  exit 0
fi

require_command git
require_command node
require_command go
node_major="$(node --print 'process.versions.node.split(".")[0]')"
[[ "${node_major}" =~ ^[0-9]+$ && "${node_major}" -ge 24 ]] \
  || die "Node.js 24 or newer is required for configuration parity checks."
go_version="$(GOENV=off GOTOOLCHAIN=local go env GOVERSION)"
[[ "${go_version}" == "go1.27.0" ]] \
  || die "Go 1.27.0 is required for configuration parity checks; found ${go_version}."

candidate_root="$(mktemp -d)"
candidate_metadata_root="$(mktemp -d)"
trap 'rm -rf -- "${candidate_root}" "${candidate_metadata_root}"' EXIT
create_docs_config_candidate_snapshot \
  "${repo_root}" \
  "${candidate_root}" \
  "${candidate_metadata_root}"
config_candidate_files=(
  ".env.example"
  ".github/workflows/deploy.yml"
  "backend/internal/config/config.go"
  "cloudflare/package.json"
  "cloudflare/src/config/deployment-contract.test.mjs"
  "cloudflare/src/index.ts"
  "cloudflare/tsconfig.json"
  "scripts/config-go-ast-inventory.go"
  "cloudflare/wrangler.jsonc"
  "config/deployment-contract.json"
  "docs/environment.md"
  "frontend/.env.example"
  "frontend/index.html"
  "frontend/package.json"
  "frontend/vite.config.ts"
  "frontend/vite/searchIndexing.ts"
  "scripts/validate-deploy-inputs.mjs"
)
for candidate_file in "${config_candidate_files[@]}"; do
  assert_docs_config_snapshot_regular_file \
    "${candidate_root}" \
    "${candidate_file}" \
    "CONFIG_CANDIDATE_FILE_REQUIRED"
done
assert_docs_config_snapshot_real_directory \
  "${candidate_root}" \
  "backend" \
  "CONFIG_CANDIDATE_DIRECTORY_REQUIRED"
assert_docs_config_snapshot_real_directory \
  "${candidate_root}" \
  "frontend/src" \
  "CONFIG_CANDIDATE_DIRECTORY_REQUIRED"
typescript_module="${repo_root}/cloudflare/node_modules/typescript/lib/typescript.js"
[[ -f "${typescript_module}" ]] \
  || die "Pinned TypeScript 5.9.3 is required for configuration parity checks."
typescript_module="$(realpath -e -- "${typescript_module}")" \
  || die "Pinned TypeScript parser path cannot be resolved."
parse5_module="${repo_root}/frontend/node_modules/parse5/dist/index.js"
[[ -f "${parse5_module}" ]] \
  || die "Pinned parse5 8.0.1 is required for configuration parity checks."
parse5_module="$(realpath -e -- "${parse5_module}")" \
  || die "Pinned HTML parser path cannot be resolved."
FUKAMU_CONFIG_PARSE5_MODULE="${parse5_module}" \
  FUKAMU_CONFIG_TYPESCRIPT_MODULE="${typescript_module}" \
  node --test "${candidate_root}/cloudflare/src/config/deployment-contract.test.mjs"
