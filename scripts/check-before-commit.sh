#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
# shellcheck source=scripts/lib/tool-images.sh
source "${script_dir}/lib/tool-images.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"

usage() {
  cat <<'EOF'
Usage: ./scripts/check-before-commit.sh

Validate the fully staged commit candidate with the CI-equivalent workflow,
including all Playwright E2E tests. TEST_DATABASE_URL must identify a disposable
localhost PostgreSQL database whose name ends in _test.
EOF
}

if (($# > 0)); then
  [[ "$1" == "--help" && $# -eq 1 ]] || die "This command accepts no options."
  usage
  exit 0
fi

require_command git

cd -- "${repo_root}"

# The complete local repository guard and every secret view run before host Git
# inspects candidate diffs or any candidate-selected tool contacts the network.
bash ./scripts/check-security.sh

staged_diff_status=0
trusted_git diff --no-ext-diff --no-textconv --cached --quiet -- || staged_diff_status=$?
case "${staged_diff_status}" in
  0) die "No staged changes were found. Stage the complete commit candidate before running this command." ;;
  1) ;;
  *) die "Could not inspect staged changes safely." ;;
esac
unset staged_diff_status
trusted_git diff --no-ext-diff --no-textconv --quiet -- \
  || die "Unstaged tracked changes exist. Stage or revert them so checks match the commit candidate."
untracked_files="$(trusted_git ls-files --others --exclude-standard)"
[[ -z "${untracked_files}" ]] \
  || die "Untracked files exist. Stage or remove them before running commit checks."

candidate_tree="$(trusted_git write-tree)"

trusted_git diff --no-ext-diff --no-textconv --check
trusted_git diff --no-ext-diff --no-textconv --cached --check

require_command jq
require_command docker
require_standard_tool_versions
require_terraform_version
require_local_docker_context >/dev/null
require_disposable_test_database_url "${TEST_DATABASE_URL:-}"

pnpm install --frozen-lockfile --ignore-scripts
trusted_git diff --no-ext-diff --no-textconv --quiet -- \
  || die "Dependency installation changed tracked files."
installed_tree="$(trusted_git write-tree)"
[[ "${installed_tree}" == "${candidate_tree}" ]] \
  || die "Dependency installation changed the staged tree."
untracked_files="$(trusted_git ls-files --others --exclude-standard)"
[[ -z "${untracked_files}" ]] \
  || die "Dependency installation created untracked files."
bash .github/scripts/resolve-ci-reuse.test.sh
docker run --rm \
  --volume "${repo_root}:/repo:ro" \
  --workdir /repo \
  "${SUPPLY_CHAIN_ACTIONLINT_IMAGE}" \
  -color
CI=true "${script_dir}/check.sh" --e2e

trusted_git diff --no-ext-diff --no-textconv --check
trusted_git diff --no-ext-diff --no-textconv --cached --check
trusted_git diff --no-ext-diff --no-textconv --quiet -- \
  || die "Checks changed tracked files. Review and stage the changes, then rerun the complete commit gate."
untracked_files="$(trusted_git ls-files --others --exclude-standard)"
[[ -z "${untracked_files}" ]] \
  || die "Checks created untracked files. Review them, then rerun the complete commit gate: ${untracked_files//$'\n'/, }"
validated_tree="$(trusted_git write-tree)"
[[ "${validated_tree}" == "${candidate_tree}" ]] \
  || die "The staged tree changed during checks. Rerun the complete commit gate."

printf 'Commit checks passed for staged tree %s. Commit without changing the index or working tree.\n' \
  "${validated_tree}"
