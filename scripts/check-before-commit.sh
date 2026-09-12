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

Validate the fully staged commit candidate with the conservative change profile.
Full fallback includes all Playwright E2E tests and requires TEST_DATABASE_URL to
identify a disposable localhost PostgreSQL database whose name ends in _test.
EOF
}

if (($# > 0)); then
  [[ "$1" == "--help" && $# -eq 1 ]] || die "This command accepts no options."
  usage
  exit 0
fi

require_command git

cd -- "${repo_root}"

# Freeze a complete, quiet staged inventory before security. Candidate content
# is not printed, formatted, or passed to dependency tooling in this phase.
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

assert_candidate_state() {
  local phase="$1"
  local observed_tree
  local confirmed_tree
  local untracked_files

  observed_tree="$(trusted_git write-tree)"
  [[ "${observed_tree}" == "${candidate_tree}" ]] \
    || die "The staged tree changed ${phase}."
  trusted_git diff --no-ext-diff --no-textconv --quiet -- \
    || die "Unstaged tracked changes appeared ${phase}."
  untracked_files="$(trusted_git ls-files --others --exclude-standard)"
  [[ -z "${untracked_files}" ]] \
    || die "Untracked files appeared ${phase}."
  confirmed_tree="$(trusted_git write-tree)"
  [[ "${confirmed_tree}" == "${candidate_tree}" ]] \
    || die "The staged tree changed while confirming it ${phase}."
}

# Run the candidate security profile exactly once, before classification,
# printable diagnostics, candidate-selected tool probes, dependency access,
# or candidate commands.
bash ./scripts/check-security.sh --profile candidate
assert_candidate_state "while the candidate security profile was running"
# shellcheck source=scripts/lib/check-runner.sh
source "${script_dir}/lib/check-runner.sh"

classification_file="$(mktemp "${TMPDIR:-/tmp}/fukamu-cycle-change-profile.XXXXXXXX")"
cleanup_classification() {
  rm -f -- "${classification_file}"
}
trap cleanup_classification EXIT
if ! bash ./scripts/check-control-plane-fixtures.sh \
  --classify-only --staged >"${classification_file}"; then
  die "Could not classify the staged candidate safely."
fi
mapfile -t classification_lines <"${classification_file}"
[[ "${#classification_lines[@]}" -eq 2 ]] \
  || die "The staged candidate classifier returned an invalid result."
change_profile="${classification_lines[0]#change_profile=}"
change_reason="${classification_lines[1]#change_reason=}"
[[ "${classification_lines[0]}" == "change_profile=${change_profile}" &&
  "${classification_lines[1]}" == "change_reason=${change_reason}" &&
  "${change_reason}" =~ ^[a-z_]+$ ]] \
  || die "The staged candidate classifier returned an invalid result."
case "${change_profile}" in
  docs | frontend | backend | application | full) ;;
  *) die "The staged candidate classifier returned an unknown profile." ;;
esac
assert_candidate_state "while changes were being classified"
printf 'Commit change profile: %s (%s).\n' "${change_profile}" "${change_reason}"

if [[ "${change_profile}" == "full" ]]; then
  bash ./scripts/check-security.sh --profile extended
  assert_candidate_state "while the extended security profile was running"
fi

trusted_git diff --no-ext-diff --no-textconv --check
trusted_git diff --no-ext-diff --no-textconv --cached --check

require_node_pnpm_versions
pnpm install --frozen-lockfile --ignore-scripts
assert_candidate_state "while dependencies were being installed"

case "${change_profile}" in
  docs)
    bash ./scripts/check-docs.sh
    ;;
  frontend)
    bash ./scripts/check-docs.sh
    CI=true run_cycle_checks_after_security \
      "${repo_root}" "${script_dir}" frontend false
    ;;
  backend)
    require_go_version
    require_disposable_test_database_url "${TEST_DATABASE_URL:-}"
    bash ./scripts/check-docs.sh
    CI=true run_cycle_checks_after_security \
      "${repo_root}" "${script_dir}" backend false
    ;;
  application)
    require_go_version
    require_disposable_test_database_url "${TEST_DATABASE_URL:-}"
    bash ./scripts/check-docs.sh
    CI=true run_cycle_checks_after_security \
      "${repo_root}" "${script_dir}" application false
    ;;
  full)
    require_command jq
    require_command docker
    require_standard_tool_versions
    require_terraform_version
    require_local_docker_context >/dev/null
    require_disposable_test_database_url "${TEST_DATABASE_URL:-}"
    bash .github/scripts/resolve-ci-reuse.test.sh
    docker run --rm \
      --volume "${repo_root}:/repo:ro" \
      --workdir /repo \
      "${SUPPLY_CHAIN_ACTIONLINT_IMAGE}" \
      -color
    CI=true run_cycle_checks_after_security \
      "${repo_root}" "${script_dir}" all true
    ;;
esac

trusted_git diff --no-ext-diff --no-textconv --check
trusted_git diff --no-ext-diff --no-textconv --cached --check
assert_candidate_state "while checks were running"
validated_tree="${candidate_tree}"
cleanup_classification
trap - EXIT

printf 'Commit checks passed for staged tree %s. Commit without changing the index or working tree.\n' \
  "${validated_tree}"
