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

require_standard_tool_versions

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
      pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run types
  )
  (
    cd -- "${repo_root}/backend"
    GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go mod download
  )
fi

printf '%s\n' "Local files are ready. Review .env, then follow docs/development.md to start PostgreSQL and the servers."
