#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
skip_install=false

usage() {
  cat <<'EOF'
Usage: ./scripts/setup.sh [--skip-install]

Create missing local environment files without overwriting existing files,
then install pinned JavaScript and Go dependencies unless --skip-install is set.
EOF
}

while (($# > 0)); do
  case "$1" in
    --skip-install)
      skip_install=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

require_command node
require_command pnpm
require_command go

node_version="$(node --version)"
node_version="${node_version#v}"
node_major="${node_version%%.*}"
if [[ ! "${node_major}" =~ ^[0-9]+$ ]] || ((node_major < 24)); then
  die "Node.js 24 or newer is required; found ${node_version}."
fi

pnpm_version="$(pnpm --version)"
[[ "${pnpm_version}" == "11.22.0" ]] \
  || die "pnpm 11.22.0 is required for reproducible local/CI builds; found ${pnpm_version}."

go_version="$(go env GOVERSION)"
go_version="${go_version#go}"
[[ "${go_version}" == "1.26.6" ]] \
  || die "Go 1.26.6 is required for reproducible local/CI builds; found ${go_version}."

copy_example_if_missing() {
  local example="$1"
  local destination="$2"
  if [[ -e "${destination}" || -L "${destination}" ]]; then
    printf 'Preserved existing file: %s\n' "${destination}"
    return
  fi
  cp -- "${example}" "${destination}"
  printf 'Created: %s\n' "${destination}"
}

copy_example_if_missing "${repo_root}/.env.example" "${repo_root}/.env"
copy_example_if_missing "${repo_root}/frontend/.env.example" "${repo_root}/frontend/.env.local"

if [[ "${skip_install}" == "false" ]]; then
  (
    cd -- "${repo_root}"
    pnpm install --frozen-lockfile
    XDG_CONFIG_HOME="${repo_root}/cloudflare/.wrangler/config" \
      pnpm --filter pdcai-cloudflare run types
  )
  (
    cd -- "${repo_root}/backend"
    go mod download
  )
fi

printf '%s\n' "Local files are ready. Review .env, then follow docs/development.md to start PostgreSQL and the servers."
