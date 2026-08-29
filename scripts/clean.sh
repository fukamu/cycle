#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
full_clean=false
dry_run=false

usage() {
  cat <<'EOF'
Usage: ./scripts/clean.sh [--all] [--dry-run]

Remove only the repository-local regenerable artifacts in the explicit
allowlist. Environment files, databases, Docker resources, and browser data
are never removed.
EOF
}

while (($# > 0)); do
  case "$1" in
    --all)
      full_clean=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

safe_targets=(
  ".tmp"
  "backend/bin"
  "backend/coverage.out"
  "backend/server"
  "backend/migrate"
  "frontend/dist"
  "frontend/coverage"
  "frontend/playwright-report"
  "frontend/test-results"
  "frontend/.eslintcache"
  "frontend/tsconfig.tsbuildinfo"
  "frontend/tsconfig.app.tsbuildinfo"
  "frontend/tsconfig.node.tsbuildinfo"
  "cloudflare/.wrangler"
)
full_targets=(
  ".pnpm-store"
  "node_modules"
  "frontend/node_modules"
  "cloudflare/node_modules"
)

remove_generated_path() {
  local relative_path="$1"
  local target="${repo_root}/${relative_path}"
  [[ -e "${target}" || -L "${target}" ]] || return 0
  assert_safe_repo_target "${repo_root}" "${target}"
  if [[ "${dry_run}" == "true" ]]; then
    printf 'Would remove: %s\n' "${target}"
    return
  fi
  rm -rf -- "${target}"
  printf 'Removed: %s\n' "${target}"
}

for target in "${safe_targets[@]}"; do
  remove_generated_path "${target}"
done
if [[ "${full_clean}" == "true" ]]; then
  for target in "${full_targets[@]}"; do
    remove_generated_path "${target}"
  done
fi

printf '%s\n' "Cleanup complete. Environment files, databases, Docker resources, and browser data were not touched."
