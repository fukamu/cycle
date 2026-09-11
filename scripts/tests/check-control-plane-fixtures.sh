#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-cycle-control-plane-test.XXXXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT
  chmod -R u+w -- "${test_root}" 2>/dev/null || status=1
  rm -rf -- "${test_root}" 2>/dev/null || status=1
  exit "${status}"
}
trap cleanup EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

fixture_git() {
  env -i \
    PATH="${PATH}" \
    LC_ALL=C \
    GIT_ATTR_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_NO_LAZY_FETCH=1 \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_OPTIONAL_LOCKS=0 \
    GIT_PAGER=cat \
    GIT_TERMINAL_PROMPT=0 \
    PAGER=cat \
    git \
    --no-pager \
    -c core.fsmonitor=false \
    -c core.untrackedCache=false \
    -c core.hooksPath=/dev/null \
    -C "${fixture_repo}" \
    "$@"
}

fixture_commit() {
  fixture_git \
    -c user.name='Cycle Test' \
    -c user.email='cycle-test@example.invalid' \
    commit --quiet -m "$1"
}

create_fixture() {
  local label="$1"
  fixture_repo="${test_root}/${label}"
  suite_marker="${test_root}/${label}-suite-marker"
  external_diff_marker="${test_root}/${label}-external-diff-marker"
  classifier_output="${test_root}/${label}-classifier-output"
  external_diff_helper="${test_root}/${label}-external-diff"

  mkdir -p -- \
    "${fixture_repo}/.github/workflows" \
    "${fixture_repo}/backend" \
    "${fixture_repo}/config" \
    "${fixture_repo}/docs" \
    "${fixture_repo}/frontend" \
    "${fixture_repo}/frontend/src" \
    "${fixture_repo}/scripts/lib" \
    "${fixture_repo}/scripts/tests"

  cp -- \
    "${repo_root}/scripts/check-control-plane-fixtures.sh" \
    "${fixture_repo}/scripts/check-control-plane-fixtures.sh"
  cp -- \
    "${repo_root}/scripts/classify-change-profile.py" \
    "${fixture_repo}/scripts/classify-change-profile.py"
  cp -- "${repo_root}/scripts/lib/common.sh" "${fixture_repo}/scripts/lib/common.sh"

  # shellcheck disable=SC2016 # The fake suite must expand this at execution time.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -Eeuo pipefail' \
    ': "${CONTROL_PLANE_FIXTURE_MARKER:?}"' \
    'printf "suite-ran\\n" >>"${CONTROL_PLANE_FIXTURE_MARKER}"' \
    >"${fixture_repo}/scripts/tests/run.sh"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    "printf 'external-diff-ran\\n' >>'${external_diff_marker}'" \
    'exit 86' \
    >"${external_diff_helper}"
  chmod +x -- \
    "${fixture_repo}/scripts/check-control-plane-fixtures.sh" \
    "${fixture_repo}/scripts/classify-change-profile.py" \
    "${fixture_repo}/scripts/tests/run.sh" \
    "${external_diff_helper}"

  printf '%s\n' 'backend/*.go diff=fixture-trap' >"${fixture_repo}/.gitattributes"
  printf '%s\n' 'name: fixture' >"${fixture_repo}/.github/workflows/ci.yml"
  printf '%s\n' 'package backend' >"${fixture_repo}/backend/app.go"
  printf '%s\n' '{"fixture":true}' >"${fixture_repo}/config/tool.json"
  printf '%s\n' '# Fixture documentation' >"${fixture_repo}/docs/guide.md"
  printf '%s\n' 'export const app = true;' >"${fixture_repo}/frontend/src/app.ts"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"${fixture_repo}/scripts/policy.sh"

  git init --quiet "${fixture_repo}"
  fixture_git add -- .
  fixture_commit 'baseline'
  fixture_git config diff.external "${external_diff_helper}"
  fixture_git config diff.fixture-trap.textconv "${external_diff_helper}"
}

marker_count() {
  local marker="$1"
  if [[ ! -e "${marker}" ]]; then
    printf '0\n'
    return
  fi
  awk 'END { print NR + 0 }' "${marker}"
}

run_classifier() {
  local expected="$1"
  local description="$2"
  shift 2
  local status=0
  local actual_suite_count
  local actual_external_diff_count

  rm -f -- "${suite_marker}" "${external_diff_marker}" "${classifier_output}"
  CONTROL_PLANE_FIXTURE_MARKER="${suite_marker}" \
    bash "${fixture_repo}/scripts/check-control-plane-fixtures.sh" "$@" \
    >"${classifier_output}" 2>&1 || status=$?

  [[ "${status}" -eq 0 ]] \
    || fail "${description} exited with status ${status}: $(tr '\n' ' ' <"${classifier_output}")"

  actual_suite_count="$(marker_count "${suite_marker}")"
  actual_external_diff_count="$(marker_count "${external_diff_marker}")"
  [[ "${actual_external_diff_count}" -eq 0 ]] \
    || fail "${description} invoked a repository-configured external diff/textconv command"

  case "${expected}" in
    skip)
      [[ "${actual_suite_count}" -eq 0 ]] \
        || fail "${description} ran the fixture suite ${actual_suite_count} time(s), expected zero"
      ;;
    run)
      [[ "${actual_suite_count}" -eq 1 ]] \
        || fail "${description} ran the fixture suite ${actual_suite_count} time(s), expected exactly once"
      ;;
    *) fail "test bug: unknown expectation ${expected}" ;;
  esac

  pass "${description}"
}

assert_profile() {
  local expected_profile="$1"
  local expected_reason="$2"
  local description="$3"
  shift 3
  local expected_output
  local actual_output

  expected_output="$(printf 'change_profile=%s\nchange_reason=%s' \
    "${expected_profile}" "${expected_reason}")"
  actual_output="$(
    CONTROL_PLANE_FIXTURE_MARKER="${suite_marker}" \
      bash "${fixture_repo}/scripts/check-control-plane-fixtures.sh" \
      --classify-only "$@"
  )"
  [[ "${actual_output}" == "${expected_output}" ]] \
    || fail "${description} returned unexpected profile: ${actual_output//$'\n'/, }"
  pass "${description}"
}

create_fixture application-staged
printf '%s\n' 'package backend' '// ordinary staged change' >"${fixture_repo}/backend/app.go"
fixture_git add -- backend/app.go
run_classifier skip 'application-only staged changes skip control-plane fixtures' --staged
assert_profile backend backend_scope 'backend changes select the backend profile' --staged

create_fixture docs-profile
printf '%s\n' '# Updated fixture documentation' >"${fixture_repo}/docs/guide.md"
fixture_git add -- docs/guide.md
run_classifier skip 'documentation-only changes skip control-plane fixtures' --staged
assert_profile docs docs_only 'documentation-only changes select the docs profile' --staged

create_fixture frontend-profile
printf '%s\n' 'export const app = false;' >"${fixture_repo}/frontend/src/app.ts"
fixture_git add -- frontend/src/app.ts
run_classifier skip 'frontend-only changes skip control-plane fixtures' --staged
assert_profile frontend frontend_scope 'frontend changes select the frontend profile' --staged

create_fixture application-union-profile
printf '%s\n' 'package backend' '// union change' >"${fixture_repo}/backend/app.go"
printf '%s\n' 'export const app = false;' >"${fixture_repo}/frontend/src/app.ts"
printf '%s\n' '# Related documentation' >"${fixture_repo}/docs/guide.md"
fixture_git add -- backend/app.go frontend/src/app.ts docs/guide.md
run_classifier skip 'known frontend and backend changes skip control-plane fixtures' --staged
assert_profile application application_union 'frontend and backend changes select the union profile' --staged

create_fixture application-working-tree
printf '%s\n' 'package backend' '// ordinary unstaged change' >"${fixture_repo}/backend/app.go"
printf '%s\n' 'export const extra = true;' >"${fixture_repo}/frontend/src/extra.ts"
run_classifier skip 'application-only working-tree changes skip control-plane fixtures' --working-tree

create_fixture application-range
base_sha="$(fixture_git rev-parse HEAD)"
printf '%s\n' 'export const app = false;' >"${fixture_repo}/frontend/src/app.ts"
fixture_git add -- frontend/src/app.ts
fixture_commit 'application change'
head_sha="$(fixture_git rev-parse HEAD)"
run_classifier skip 'application-only commit ranges skip control-plane fixtures' \
  --range "${base_sha}" "${head_sha}"

create_fixture nul-safe-application-path
special_application_path=$'backend/a path with spaces\tand-tabs.go'
printf '%s\n' \
  'package nulfixture' \
  '' \
  'const uniqueNULSafeFixture = "spaces-and-tabs"' \
  >"${fixture_repo}/${special_application_path}"
fixture_git add -- "${special_application_path}"
run_classifier skip 'NUL-delimited application paths with spaces and tabs remain application-only' --staged

create_fixture scripts-change
printf '%s\n' '# changed' >>"${fixture_repo}/scripts/policy.sh"
fixture_git add -- scripts/policy.sh
run_classifier run 'scripts changes run control-plane fixtures exactly once' --staged
assert_profile full control_or_infrastructure_change 'classifier changes select the full profile' --staged

create_fixture github-change
printf '%s\n' '# changed' >>"${fixture_repo}/.github/workflows/ci.yml"
fixture_git add -- .github/workflows/ci.yml
run_classifier run '.github changes run control-plane fixtures exactly once' --staged

create_fixture untracked-control-plane
printf '%s\n' 'name: untracked-fixture' >"${fixture_repo}/.github/workflows/untracked.yml"
run_classifier run 'untracked control-plane paths run fixtures exactly once' --working-tree

create_fixture config-change
printf '%s\n' '{"fixture":false}' >"${fixture_repo}/config/tool.json"
fixture_git add -- config/tool.json
run_classifier run 'config changes run control-plane fixtures exactly once' --staged

create_fixture github-range
base_sha="$(fixture_git rev-parse HEAD)"
printf '%s\n' 'name: changed-fixture' >"${fixture_repo}/.github/workflows/ci.yml"
fixture_git add -- .github/workflows/ci.yml
fixture_commit 'workflow change'
head_sha="$(fixture_git rev-parse HEAD)"
run_classifier run 'control-plane commit ranges run fixtures exactly once' \
  --range "${base_sha}" "${head_sha}"

create_fixture mixed-change
printf '%s\n' 'package backend' '// mixed app change' >"${fixture_repo}/backend/app.go"
printf '%s\n' '# mixed control-plane change' >>"${fixture_repo}/scripts/policy.sh"
fixture_git add -- backend/app.go scripts/policy.sh
run_classifier run 'mixed application and control-plane changes run fixtures exactly once' --staged

create_fixture application-rename
fixture_git mv -- backend/app.go backend/renamed.go
run_classifier run 'renaming between application paths remains fail-closed' --staged
assert_profile full rename_or_type_change 'renames select the full profile' --staged

create_fixture control-plane-copy
cp -- "${fixture_repo}/scripts/policy.sh" "${fixture_repo}/backend/copied-policy.go"
fixture_git add -- backend/copied-policy.go
run_classifier run 'copying a control-plane path into application code remains fail-closed' --staged

create_fixture unknown-application-config
printf '%s\n' 'policy: unclassified' >"${fixture_repo}/backend/ci-policy.yaml"
fixture_git add -- backend/ci-policy.yaml
run_classifier run 'unknown configuration below an application directory fails closed' --staged

create_fixture application-type-change
rm -f -- "${fixture_repo}/backend/app.go"
ln -s -- ../frontend/src/app.ts "${fixture_repo}/backend/app.go"
fixture_git add -- backend/app.go
run_classifier run 'an application file type change fails closed' --staged

create_fixture application-mode-change
chmod +x -- "${fixture_repo}/backend/app.go"
fixture_git add -- backend/app.go
run_classifier run 'an application file mode change fails closed' --staged
assert_profile full rename_or_type_change 'mode changes select the full profile' --staged

create_fixture unknown-path
printf '%s\n' 'unclassified repository input' >"${fixture_repo}/unclassified.fixture"
fixture_git add -- unclassified.fixture
run_classifier run 'an unclassified repository path fails closed' --staged
assert_profile full unknown_path 'unknown paths select the full profile' --staged

create_fixture newline-path
newline_path=$'backend/noncanonical\npath.go'
printf '%s\n' 'package backend' >"${fixture_repo}/${newline_path}"
fixture_git add -- "${newline_path}"
run_classifier run 'newline-containing paths are treated as an ambiguous inventory' --staged

create_fixture backslash-path
backslash_path='backend/noncanonical\path.go'
printf '%s\n' 'package backend' >"${fixture_repo}/${backslash_path}"
fixture_git add -- "${backslash_path}"
run_classifier run 'backslash-containing paths are treated as an ambiguous inventory' --staged

create_fixture corrupt-index
printf '%s\n' 'not-a-git-index' >"${fixture_repo}/.git/index"
run_classifier run 'an unreadable staged-change inventory fails closed' --staged

create_fixture malformed-sha
head_sha="$(fixture_git rev-parse HEAD)"
run_classifier run 'a malformed range revision fails closed' \
  --range not-a-full-sha "${head_sha}"

create_fixture unknown-sha
head_sha="$(fixture_git rev-parse HEAD)"
unknown_sha='0000000000000000000000000000000000000001'
run_classifier run 'an unknown full-length range revision fails closed' \
  --range "${unknown_sha}" "${head_sha}"

create_fixture non-commit-sha
head_sha="$(fixture_git rev-parse HEAD)"
blob_sha="$(fixture_git rev-parse HEAD:backend/app.go)"
run_classifier run 'a non-commit Git object used as a range revision fails closed' \
  --range "${blob_sha}" "${head_sha}"

create_fixture non-ancestor-range
head_sha="$(fixture_git rev-parse HEAD)"
tree_sha="$(fixture_git rev-parse 'HEAD^{tree}')"
unrelated_sha="$(
  fixture_git \
    -c user.name='Cycle Test' \
    -c user.email='cycle-test@example.invalid' \
    commit-tree "${tree_sha}" -m 'unrelated root'
)"
run_classifier run 'a non-ancestor commit range fails closed' \
  --range "${unrelated_sha}" "${head_sha}"

create_fixture oversized-inventory
for ((file_number = 1; file_number <= 101; file_number += 1)); do
  printf '%s\n' 'export const fixture = true;' \
    >"${fixture_repo}/frontend/generated-${file_number}.ts"
done
fixture_git add -- frontend
run_classifier run 'an oversized application-only inventory fails closed' --staged
assert_profile full change_limit_exceeded 'oversized inventories select the full profile' --staged

create_fixture empty-staged-diff
run_classifier run 'an empty staged inventory fails closed' --staged
assert_profile full empty_change_inventory 'empty inventories select the full profile' --staged

create_fixture empty-range
head_sha="$(fixture_git rev-parse HEAD)"
run_classifier run 'an empty commit range fails closed' --range "${head_sha}" "${head_sha}"

printf '%s\n' 'Control-plane fixture classifier tests completed successfully.'
