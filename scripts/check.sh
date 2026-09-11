#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
scope="all"
run_e2e=false

usage() {
  cat <<'EOF'
Usage: ./scripts/check.sh [--scope all|frontend|backend|infrastructure] [--e2e]

Run repository checks by scope. --e2e requires --scope all and a disposable
localhost TEST_DATABASE_URL whose database name ends in _test.
EOF
}

while (($# > 0)); do
  case "$1" in
    --scope)
      (($# >= 2)) || die "--scope requires a value."
      scope="$2"
      shift 2
      ;;
    --e2e)
      run_e2e=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

case "${scope}" in
  all | frontend | backend | infrastructure) ;;
  *) die "--scope must be all, frontend, backend, or infrastructure." ;;
esac
if [[ "${run_e2e}" == "true" && "${scope}" != "all" ]]; then
  die "--e2e requires --scope all because it starts both the frontend build and backend server."
fi

if [[ "${scope}" == "all" ]]; then
  "${script_dir}/check-security.sh"
fi
# shellcheck source=scripts/lib/check-runner.sh
source "${script_dir}/lib/check-runner.sh"
run_cycle_checks_after_security "${repo_root}" "${script_dir}" "${scope}" "${run_e2e}"
