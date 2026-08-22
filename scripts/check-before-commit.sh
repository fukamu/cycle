#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
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
require_command jq
require_command docker
require_command terraform
require_standard_tool_versions
require_local_docker_context >/dev/null
require_disposable_test_database_url "${TEST_DATABASE_URL:-}"

cd -- "${repo_root}"

if git diff --cached --quiet --; then
  die "No staged changes were found. Stage the complete commit candidate before running this command."
fi
git diff --quiet -- \
  || die "Unstaged tracked changes exist. Stage or revert them so checks match the commit candidate."
untracked_files="$(git ls-files --others --exclude-standard)"
[[ -z "${untracked_files}" ]] \
  || die "Untracked files exist. Stage or remove them before running commit checks: ${untracked_files//$'\n'/, }"

candidate_tree="$(git write-tree)"
git diff --check
git diff --cached --check

pnpm install --frozen-lockfile
bash .github/scripts/resolve-ci-reuse.test.sh
docker run --rm \
  --volume "${repo_root}:/repo:ro" \
  --workdir /repo \
  rhysd/actionlint:1.7.12 \
  -color
CI=true "${script_dir}/check.sh" --e2e

git diff --check
git diff --cached --check
git diff --quiet -- \
  || die "Checks changed tracked files. Review and stage the changes, then rerun the complete commit gate."
untracked_files="$(git ls-files --others --exclude-standard)"
[[ -z "${untracked_files}" ]] \
  || die "Checks created untracked files. Review them, then rerun the complete commit gate: ${untracked_files//$'\n'/, }"
validated_tree="$(git write-tree)"
[[ "${validated_tree}" == "${candidate_tree}" ]] \
  || die "The staged tree changed during checks. Rerun the complete commit gate."

printf 'Commit checks passed for staged tree %s. Commit without changing the index or working tree.\n' \
  "${validated_tree}"
