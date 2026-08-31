#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
# shellcheck source=scripts/lib/tool-images.sh
source "${repo_root}/scripts/lib/tool-images.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

assert_file_contains() {
  local file="$1"
  local expected="$2"
  grep -Fqx -- "${expected}" "${file}" \
    || fail "Expected ${file} to contain: ${expected}"
}

assert_lines_in_order() {
  local file="$1"
  shift
  local previous=0
  local expected
  local line_number
  for expected in "$@"; do
    line_number="$(awk -v expected="${expected}" '$0 == expected { print NR; exit }' "${file}")"
    [[ -n "${line_number}" ]] || fail "Expected ${file} to contain: ${expected}"
    ((line_number > previous)) \
      || fail "Expected ${file} line after the preceding contract: ${expected}"
    previous="${line_number}"
  done
}

assert_failure() {
  local description="$1"
  shift
  if "$@" >"${test_root}/last-output" 2>&1; then
    fail "${description} unexpectedly succeeded"
  fi
}

new_fixture() {
  local name="$1"
  local fixture="${test_root}/${name}"
  mkdir -p -- "${fixture}"
  cp -R -- "${repo_root}/scripts" "${fixture}/scripts"
  chmod +x "${fixture}"/scripts/*.sh "${fixture}"/scripts/lib/*.sh
  printf '%s\n' "${fixture}"
}

test_setup() {
  local fixture
  fixture="$(new_fixture setup)"
  local bin="${fixture}/bin"
  local log="${fixture}/commands.log"
  mkdir -p -- "${bin}" "${fixture}/frontend" "${fixture}/cloudflare" "${fixture}/backend"
  printf '%s\n' "ROOT_EXAMPLE=1" >"${fixture}/.env.example"
  printf '%s\n' "FRONTEND_EXAMPLE=1" >"${fixture}/frontend/.env.example"
  printf '%s\n' "KEEP=1" >"${fixture}/.env"

  cat >"${bin}/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'v24.19.0'
EOF
  cat >"${bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "${FAKE_PNPM_VERSION:-11.22.0}"
else
  printf 'pnpm %s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  cat >"${bin}/go" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${GOENV:-}" == "off" && "${GOTOOLCHAIN:-}" == "local" ]]
if [[ "${1:-}" == "env" && "${2:-}" == "GOVERSION" ]]; then
  printf '%s\n' 'go1.26.6'
else
  [[ "${GOWORK:-}" == "off" && "${GOFLAGS:-}" == "-mod=readonly" ]]
  printf 'go %s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  chmod +x "${bin}/node" "${bin}/pnpm" "${bin}/go"

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/setup.sh" --skip-install >/dev/null
  [[ "$(cat "${fixture}/.env")" == "KEEP=1" ]] || fail "setup overwrote an existing .env"
  [[ "$(cat "${fixture}/frontend/.env.local")" == "FRONTEND_EXAMPLE=1" ]] \
    || fail "setup did not create frontend/.env.local"
  [[ ! -e "${log}" ]] || fail "setup --skip-install ran dependency commands"

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/setup.sh" >/dev/null
  assert_file_contains "${log}" "pnpm install --frozen-lockfile"
  assert_file_contains "${log}" "pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match run types"
  assert_file_contains "${log}" "go mod download"

  assert_failure "setup with wrong pnpm version" \
    env PATH="${bin}:${PATH}" FAKE_PNPM_VERSION=10.0.0 TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/setup.sh" --skip-install

  local outside_env="${test_root}/outside-env"
  rm -- "${fixture}/frontend/.env.local"
  ln -s -- "${outside_env}" "${fixture}/frontend/.env.local"
  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/setup.sh" --skip-install >/dev/null
  [[ -L "${fixture}/frontend/.env.local" && ! -e "${outside_env}" ]] \
    || fail "setup followed a broken environment-file symlink"
  pass "setup preserves env files, validates versions, and honors --skip-install"
}

test_import_env() {
  local env_file="${test_root}/valid.env"
  local invalid_file="${test_root}/invalid.env"
  printf '%s\n' '# comment' 'ALPHA=one' 'SPACED=value with spaces' "LITERAL=\$(touch should-not-run)" >"${env_file}"
  printf '%s\n' 'ALPHA=one' 'export INVALID=two' >"${invalid_file}"

  local output
  output="$(
    bash -c 'source "$1" --file "$2" >/dev/null; printf "%s|%s|%s" "$ALPHA" "$SPACED" "$LITERAL"' \
      _ "${repo_root}/scripts/import-env.sh" "${env_file}"
  )"
  [[ "${output}" == "one|value with spaces|\$(touch should-not-run)" ]] \
    || fail "import-env did not preserve literal values"
  [[ ! -e "${test_root}/should-not-run" ]] || fail "import-env evaluated a value"
  bash -c '
    set +Ee +u
    set +o pipefail
    source "$1" --file "$2" >/dev/null
    [[ $- != *E* && $- != *e* && $- != *u* ]]
    ! shopt -qo pipefail
    ! declare -F _fukamu_cycle_import_env >/dev/null
    [[ -z ${_fukamu_cycle_import_status+x} ]]
  ' _ "${repo_root}/scripts/import-env.sh" "${env_file}" \
    || fail "import-env changed caller options or leaked helper state"
  assert_failure "executed import-env" bash "${repo_root}/scripts/import-env.sh"
  # shellcheck disable=SC2016 # The command must expand positional parameters in the child shell.
  assert_failure "unsupported env syntax" \
    bash -c 'source "$1" --file "$2"' _ "${repo_root}/scripts/import-env.sh" "${invalid_file}"
  # shellcheck disable=SC2016 # The command must expand positional parameters in the child shell.
  assert_failure "readonly environment variable" \
    bash -c 'readonly ALPHA; source "$1" --file "$2"' \
    _ "${repo_root}/scripts/import-env.sh" "${env_file}"
  pass "import-env requires sourcing and accepts only literal KEY=value lines"
}

test_frontend_check() {
  local fixture
  fixture="$(new_fixture check)"
  local bin="${fixture}/bin"
  local log="${fixture}/commands.log"
  mkdir -p -- "${bin}" "${fixture}/node_modules"
  cat >"${bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_COMMAND_LOG}"
EOF
  chmod +x "${bin}/pnpm"

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/check.sh" --scope frontend >/dev/null
  assert_file_contains "${log}" "--filter fukamu-cycle-frontend --fail-if-no-match run format:check"
  assert_file_contains "${log}" "--filter fukamu-cycle-frontend --fail-if-no-match run lint"
  assert_file_contains "${log}" "--filter fukamu-cycle-frontend --fail-if-no-match run typecheck"
  assert_file_contains "${log}" "--filter fukamu-cycle-frontend --fail-if-no-match test"
  assert_file_contains "${log}" "--filter fukamu-cycle-frontend --fail-if-no-match run build"
  assert_failure "E2E with a partial scope" \
    bash "${fixture}/scripts/check.sh" --scope frontend --e2e
  assert_failure "unknown check scope" \
    bash "${fixture}/scripts/check.sh" --scope unknown
  pass "check runs the frontend contract and rejects unsafe E2E scope"
}

test_full_check_quality_order() {
  local fixture
  fixture="$(new_fixture full-check-order)"
  local bin="${fixture}/bin"
  local log="${fixture}/commands.log"
  mkdir -p -- \
    "${bin}" \
    "${fixture}/node_modules" \
    "${fixture}/frontend/dist" \
    "${fixture}/backend/internal/infrastructure/postgres/generated" \
    "${fixture}/infra/terraform/staging" \
    "${fixture}/cloudflare"
  touch "${fixture}/frontend/dist/index.html"

  cat >"${fixture}/scripts/check-security.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'security' >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${fixture}/scripts/check-docs.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'docs' >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${fixture}/scripts/check-config-parity.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'config' >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${fixture}/scripts/invoke-sqlc.sh" <<'EOF'
#!/usr/bin/env bash
printf 'sqlc %s\n' "$*" >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${fixture}/scripts/check-docker-context.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'docker-context' >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${fixture}/scripts/check-shell.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'shell' >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
printf 'pnpm %s\n' "$*" >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${bin}/go" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${GOENV:-}" == "off" ]]
[[ "${GOWORK:-}" == "off" ]]
[[ "${GOTOOLCHAIN:-}" == "local" ]]
[[ "${GOFLAGS:-}" == "-mod=readonly" ]]
printf 'go %s\n' "$*" >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${bin}/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
for trusted_argument in \
  --no-pager \
  -c core.fsmonitor=false \
  -c core.untrackedCache=false \
  -c core.hooksPath=/dev/null; do
  [[ "${1:-}" == "${trusted_argument}" ]]
  shift
done
[[ "$*" == 'ls-files --others --exclude-standard -- internal/infrastructure/postgres/generated' ]]
printf 'git %s\n' "$*" >>"${fixture_root}/commands.log"
EOF
  cat >"${bin}/gofmt" <<'EOF'
#!/usr/bin/env bash
printf 'gofmt %s\n' "$*" >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "context" && "${2:-}" == "inspect" ]]; then
  printf '%s\n' 'unix:///var/run/docker.sock'
else
  printf 'docker %s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  cat >"${bin}/terraform" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "version" && "${2:-}" == "-json" ]]; then
  printf '%s\n' '{"terraform_version":"1.15.8"}'
else
  printf 'terraform %s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  chmod +x \
    "${fixture}/scripts/check-security.sh" \
    "${fixture}/scripts/check-docs.sh" \
    "${fixture}/scripts/check-config-parity.sh" \
    "${fixture}/scripts/invoke-sqlc.sh" \
    "${fixture}/scripts/check-docker-context.sh" \
    "${fixture}/scripts/check-shell.sh" \
    "${bin}/pnpm" "${bin}/go" "${bin}/git" "${bin}/gofmt" \
    "${bin}/docker" "${bin}/terraform"

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/check.sh" >/dev/null
  [[ "$(sed -n '1,3p' "${log}")" == $'security\ndocs\nconfig' ]] \
    || fail "full check did not run security, documentation, and configuration before candidate commands"
  assert_lines_in_order "${log}" \
    "security" \
    "docs" \
    "config" \
    "pnpm --filter fukamu-cycle-frontend --fail-if-no-match run format:check" \
    "go vet ./..." \
    "docker-context"
  pass "full check runs security first and all repository quality gates before candidate commands"
}

test_shell_file_inventory_failure() {
  local fixture
  fixture="$(new_fixture shell-file-inventory)"
  local bin="${fixture}/bin"
  local tmpdir="${fixture}/tmp"
  mkdir -p -- "${bin}" "${tmpdir}" "${fixture}/.github/scripts"
  printf '%s\n' '#!/usr/bin/env bash' >"${fixture}/.github/scripts/fixture.sh"

  cat >"${bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == "context" && "${2:-}" == "inspect" ]]; then
  printf '%s\n' 'unix:///var/run/docker.sock'
else
  : >"${fixture_root}/unexpected-shell-scanner-run"
fi
EOF
  cat >"${bin}/find" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
printf '%s\0' "${fixture_root}/scripts/check-shell.sh"
exit 23
EOF
  chmod 700 "${bin}/docker" "${bin}/find"

  assert_failure \
    "shell check with a partial failed file inventory" \
    env PATH="${bin}:${PATH}" TMPDIR="${tmpdir}" \
    bash "${fixture}/scripts/check-shell.sh"
  [[ ! -e "${fixture}/unexpected-shell-scanner-run" ]] \
    || fail "shell check consumed a partial failed inventory"
  if find "${tmpdir}" -mindepth 1 -print -quit | grep -q .; then
    fail "shell check did not clean its failed inventory manifest"
  fi
  pass "shell check fails closed before scanners when file enumeration returns partial output"
}

test_backend_command_build_targets() {
  local backend_build_count
  local backend_build_without_vcs_count

  assert_file_contains "${repo_root}/scripts/check.sh" \
    "    GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go vet ./..."
  assert_file_contains "${repo_root}/scripts/check.sh" \
    "    GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go test -count=1 ./..."
  assert_file_contains "${repo_root}/scripts/check.sh" \
    "    GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o \"\${repo_root}/.tmp/check/server\" ./cmd/server"
  assert_file_contains "${repo_root}/scripts/check.sh" \
    "    GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o \"\${repo_root}/.tmp/check/migrate\" ./cmd/migrate"
  assert_file_contains "${repo_root}/scripts/check.sh" \
    "    GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o \"\${repo_root}/.tmp/check/cleanup\" ./cmd/cleanup"
  assert_file_contains "${repo_root}/scripts/check.sh" \
    "    GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -buildvcs=false -o \"\${repo_root}/.tmp/check/configcheck\" ./cmd/configcheck"
  backend_build_count="$(awk 'index($0, "go build ") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check.sh")"
  backend_build_without_vcs_count="$(awk 'index($0, "go build -buildvcs=false ") { count += 1 } END { print count + 0 }' "${repo_root}/scripts/check.sh")"
  [[ "${backend_build_count}" -eq 4 && "${backend_build_without_vcs_count}" -eq 4 ]] \
    || fail "check compile targets can invoke unisolated VCS stamping"
  pass "check builds every backend command without VCS stamping"
}

test_before_commit_check() {
  local fixture
  fixture="$(new_fixture before-commit)"
  local bin="${fixture}/bin"
  local log="${fixture}/commands.log"
  local test_database_url='postgres://fukamu_cycle:fukamu_cycle@127.0.0.1:55432/fukamu_cycle_test?sslmode=disable'
  mkdir -p -- "${bin}" "${fixture}/.github/scripts"

  cat >"${bin}/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fixture_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
for trusted_argument in \
  --no-pager \
  -c core.fsmonitor=false \
  -c core.untrackedCache=false \
  -c core.hooksPath=/dev/null; do
  [[ "${1:-}" == "${trusted_argument}" ]]
  shift
done
printf 'git %s\n' "$*" >>"${fixture_root}/commands.log"
case "$*" in
  'diff --no-ext-diff --no-textconv --cached --quiet --')
    [[ -e "${fixture_root}/fake-staged-inspection-error" ]] && exit 128
    [[ -e "${fixture_root}/fake-no-staged-changes" ]] && exit 0
    exit 1
    ;;
  'diff --no-ext-diff --no-textconv --quiet --')
    [[ -e "${fixture_root}/fake-unstaged-changes" ]] && exit 1
    exit 0
    ;;
  'ls-files --others --exclude-standard')
    [[ -e "${fixture_root}/fake-untracked-files" ]] && printf '%s\n' 'untracked.txt'
    exit 0
    ;;
  'write-tree') printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  'diff --no-ext-diff --no-textconv --check' | 'diff --no-ext-diff --no-textconv --cached --check')
    if [[ -e "${fixture_root}/fake-diff-check-secret-output" ]]; then
      printf '%s\n' '+SENSITIVE_SENTINEL' >&2
      exit 1
    fi
    ;;
  *) exit 1 ;;
esac
EOF
  cat >"${bin}/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'v24.19.0'
EOF
  cat >"${bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' '11.22.0'
else
  printf 'pnpm %s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  cat >"${bin}/go" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "env" && "${2:-}" == "GOVERSION" ]]
[[ "${GOENV:-}" == "off" ]]
[[ "${GOTOOLCHAIN:-}" == "local" ]]
printf 'go env GOVERSION GOENV=%s GOTOOLCHAIN=%s\n' "${GOENV}" "${GOTOOLCHAIN}" >>"${TEST_COMMAND_LOG}"
printf '%s\n' 'go1.26.6'
EOF
  cat >"${bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "context" && "${2:-}" == "inspect" ]]; then
  printf '%s\n' 'unix:///var/run/docker.sock'
else
  printf 'docker %s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  cat >"${bin}/jq" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"${bin}/terraform" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "version" && "${2:-}" == "-json" ]]; then
  printf '{"terraform_version":"%s"}\n' "${FAKE_TERRAFORM_VERSION:-1.15.8}"
else
  exit 0
fi
EOF
  cat >"${fixture}/.github/scripts/resolve-ci-reuse.test.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'resolve-ci-reuse test' >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${fixture}/scripts/check.sh" <<'EOF'
#!/usr/bin/env bash
printf 'check CI=%s %s\n' "${CI:-}" "$*" >>"${TEST_COMMAND_LOG}"
EOF
  cat >"${fixture}/scripts/check-security.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'security' >>"${TEST_COMMAND_LOG}"
[[ "${FAKE_SECURITY_FAILURE:-false}" != "true" ]]
EOF
  chmod +x \
    "${bin}/git" "${bin}/node" "${bin}/pnpm" "${bin}/go" "${bin}/docker" \
    "${bin}/jq" "${bin}/terraform" "${fixture}/scripts/check.sh" \
    "${fixture}/scripts/check-security.sh" \
    "${fixture}/.github/scripts/resolve-ci-reuse.test.sh"

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" TEST_DATABASE_URL="${test_database_url}" \
    bash "${fixture}/scripts/check-before-commit.sh" >/dev/null
  assert_file_contains "${log}" "pnpm install --frozen-lockfile --ignore-scripts"
  assert_file_contains "${log}" "resolve-ci-reuse test"
  grep -Fq -- "${SUPPLY_CHAIN_ACTIONLINT_IMAGE} -color" "${log}" \
    || fail "before-commit check did not run pinned actionlint"
  assert_file_contains "${log}" "check CI=true --e2e"
  assert_lines_in_order "${log}" \
    "security" \
    "git write-tree" \
    "git diff --no-ext-diff --no-textconv --check" \
    "git diff --no-ext-diff --no-textconv --cached --check" \
    "go env GOVERSION GOENV=off GOTOOLCHAIN=local" \
    "pnpm install --frozen-lockfile --ignore-scripts" \
    "resolve-ci-reuse test" \
    "docker run --rm --volume ${fixture}:/repo:ro --workdir /repo ${SUPPLY_CHAIN_ACTIONLINT_IMAGE} -color" \
    "check CI=true --e2e"
  [[ "$(grep -Fxc -- 'git diff --no-ext-diff --no-textconv --check' "${log}")" == "2" ]] \
    || fail "before-commit check did not validate unstaged whitespace before and after checks"
  [[ "$(grep -Fxc -- 'git diff --no-ext-diff --no-textconv --cached --check' "${log}")" == "2" ]] \
    || fail "before-commit check did not validate staged whitespace before and after checks"

  # shellcheck disable=SC2016 # The exact source contract must remain literal.
  assert_file_contains "${repo_root}/scripts/lib/common.sh" \
    '  go_version="$(GOENV=off GOTOOLCHAIN=local go env GOVERSION)"'

  : >"${log}"
  printf '%s\n' 'go 99.0.0' 'toolchain go99.0.0' >"${fixture}/go.work"
  assert_failure "security failure before candidate-selected Go toolchain probe" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL="${test_database_url}" FAKE_SECURITY_FAILURE=true \
    bash "${fixture}/scripts/check-before-commit.sh"
  assert_file_contains "${log}" "security"
  if grep -Fq -- "go env GOVERSION" "${log}"; then
    fail "before-commit probed the candidate-selected Go toolchain before security passed"
  fi
  if grep -Fq -- "git diff --no-ext-diff --no-textconv --check" "${log}" || grep -Fq -- "git diff --no-ext-diff --no-textconv --cached --check" "${log}"; then
    fail "before-commit inspected printable candidate diffs before security passed"
  fi

  : >"${log}"
  touch "${fixture}/fake-diff-check-secret-output"
  assert_failure "security failure before printable diff diagnostics" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL="${test_database_url}" FAKE_SECURITY_FAILURE=true \
    bash "${fixture}/scripts/check-before-commit.sh"
  rm -- "${fixture}/fake-diff-check-secret-output"
  if grep -Fq -- "git diff --no-ext-diff --no-textconv --check" "${log}" || grep -Fq -- "git diff --no-ext-diff --no-textconv --cached --check" "${log}"; then
    fail "before-commit ran printable diff diagnostics after the secret gate failed"
  fi
  if grep -Fq -- '+SENSITIVE_SENTINEL' "${test_root}/last-output"; then
    fail "before-commit exposed candidate content before the secret gate passed"
  fi

  assert_failure "before-commit check without a disposable database" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" TEST_DATABASE_URL= \
    bash "${fixture}/scripts/check-before-commit.sh"
  assert_failure "before-commit check with a remote database" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL='postgres://user:password@database.example.com:5432/app_test' \
    bash "${fixture}/scripts/check-before-commit.sh"
  assert_failure "before-commit check with wrong Terraform version" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL="${test_database_url}" FAKE_TERRAFORM_VERSION=1.15.7 \
    bash "${fixture}/scripts/check-before-commit.sh"
  : >"${log}"
  touch "${fixture}/fake-staged-inspection-error"
  assert_failure "before-commit check with a staged inspection error" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL="${test_database_url}" \
    bash "${fixture}/scripts/check-before-commit.sh"
  rm -- "${fixture}/fake-staged-inspection-error"
  [[ "$(grep -Fxc -- 'security' "${log}")" == "1" ]] \
    || fail "before-commit did not run exactly one secret gate before the staged inspection"
  if grep -Fq -- 'go env GOVERSION' "${log}" || grep -Fq -- 'pnpm install' "${log}"; then
    fail "before-commit continued to candidate-selected tools after an abnormal staged-diff status"
  fi
  touch "${fixture}/fake-no-staged-changes"
  assert_failure "before-commit check without staged changes" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL="${test_database_url}" \
    bash "${fixture}/scripts/check-before-commit.sh"
  rm -- "${fixture}/fake-no-staged-changes"
  touch "${fixture}/fake-unstaged-changes"
  assert_failure "before-commit check with unstaged changes" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL="${test_database_url}" \
    bash "${fixture}/scripts/check-before-commit.sh"
  rm -- "${fixture}/fake-unstaged-changes"
  touch "${fixture}/fake-untracked-files"
  assert_failure "before-commit check with untracked files" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    TEST_DATABASE_URL="${test_database_url}" \
    bash "${fixture}/scripts/check-before-commit.sh"
  rm -- "${fixture}/fake-untracked-files"
  assert_failure "unknown before-commit option" \
    bash "${fixture}/scripts/check-before-commit.sh" --quick
  pass "before-commit check validates the exact staged tree with the CI-equivalent gate"
}

test_local_app() {
  local fixture
  fixture="$(new_fixture local-app)"
  local bin="${fixture}/bin"
  local log="${fixture}/docker.log"
  mkdir -p -- "${bin}"
  touch "${fixture}/compose.local.yaml"
  cat >"${bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "context" && "${2:-}" == "inspect" ]]; then
  if [[ "${FAKE_REMOTE_CONTEXT:-false}" == "true" ]]; then
    printf '%s\n' 'tcp://remote.example:2376'
  else
    printf '%s\n' 'unix:///var/run/docker.sock'
  fi
else
  printf '%s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  cat >"${bin}/curl" <<'EOF'
#!/usr/bin/env bash
exit "${FAKE_CURL_EXIT:-0}"
EOF
  cat >"${bin}/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${bin}/docker" "${bin}/curl" "${bin}/sleep"

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/local-app.sh" --port 8091 --detached >/dev/null
  grep -Fq -- 'up --build --detach --remove-orphans app' "${log}" \
    || fail "local-app did not start the app"
  if grep -Fq -- 'down --volumes' "${log}"; then
    fail "detached local-app was removed automatically"
  fi
  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/local-app.sh" --down >/dev/null
  grep -Fq -- 'down --volumes --remove-orphans' "${log}" \
    || fail "local-app --down did not remove the disposable environment"
  assert_failure "remote Docker context" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" FAKE_REMOTE_CONTEXT=true \
    bash "${fixture}/scripts/local-app.sh" --detached
  assert_failure "privileged local port" \
    bash "${fixture}/scripts/local-app.sh" --port 80 --detached
  : >"${log}"
  assert_failure "readiness failure" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" FAKE_CURL_EXIT=1 \
    bash "${fixture}/scripts/local-app.sh" --detached
  grep -Fq -- 'down --volumes --remove-orphans' "${log}" \
    || fail "local-app did not clean up after readiness failure"
  pass "local-app enforces local Docker, validates ports, and preserves detached state"
}

test_sqlc_runner() {
  local fixture
  fixture="$(new_fixture sqlc)"
  local bin="${fixture}/bin"
  local log="${fixture}/sqlc.log"
  mkdir -p -- "${bin}" "${fixture}/backend"
  cat >"${bin}/sqlc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "version" ]]; then
  printf '%s\n' "${FAKE_SQLC_VERSION:-1.31.1}"
else
  printf '%s\n' "$*" >>"${TEST_COMMAND_LOG}"
fi
EOF
  chmod +x "${bin}/sqlc"

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/invoke-sqlc.sh" --runner host compile generate >/dev/null
  assert_file_contains "${log}" "compile"
  assert_file_contains "${log}" "generate"
  assert_failure "wrong host sqlc version" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" FAKE_SQLC_VERSION=1.30.0 \
    bash "${fixture}/scripts/invoke-sqlc.sh" --runner host compile
  assert_failure "unsupported sqlc command" \
    bash "${fixture}/scripts/invoke-sqlc.sh" drop
  pass "sqlc runner pins the host version and restricts commands"
}

test_clean() {
  local fixture
  fixture="$(new_fixture clean)"
  mkdir -p -- "${fixture}/.tmp/cache" "${fixture}/frontend/dist"
  printf '%s\n' "preserve" >"${fixture}/.env"
  printf '%s\n' "artifact" >"${fixture}/.tmp/cache/value"
  printf '%s\n' "asset" >"${fixture}/frontend/dist/index.html"

  bash "${fixture}/scripts/clean.sh" --dry-run >/dev/null
  [[ -f "${fixture}/.tmp/cache/value" ]] || fail "clean --dry-run removed an artifact"
  bash "${fixture}/scripts/clean.sh" >/dev/null
  [[ ! -e "${fixture}/.tmp" && ! -e "${fixture}/frontend/dist" ]] \
    || fail "clean did not remove allowlisted artifacts"
  [[ -f "${fixture}/.env" ]] || fail "clean removed an environment file"

  local outside="${test_root}/outside-clean-target"
  mkdir -p -- "${outside}"
  printf '%s\n' "keep" >"${outside}/marker"
  ln -s -- "${outside}" "${fixture}/.tmp"
  assert_failure "clean symlink escape" bash "${fixture}/scripts/clean.sh"
  [[ -f "${outside}/marker" ]] || fail "clean followed a symlink outside the repository"
  pass "clean uses an allowlist, honors dry-run, and rejects symlink escape"
}

test_reset_local_db() {
  local fixture
  fixture="$(new_fixture reset)"
  local bin="${fixture}/bin"
  local log="${fixture}/reset.log"
  mkdir -p -- "${bin}" "${fixture}/backend"
  cat >"${bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "context" && "${2:-}" == "inspect" ]]; then
  printf '%s\n' "${FAKE_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}"
elif [[ "${1:-}" == "inspect" ]]; then
  case "${3:-}" in
    '{{.State.Status}}') printf '%s\n' 'running' ;;
    '{{.Config.Image}}') printf '%s\n' "${FAKE_POSTGRES_IMAGE:-postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2}" ;;
    '{{range .Config.Env}}{{println .}}{{end}}')
      printf '%s\n' 'POSTGRES_USER=dev user' 'POSTGRES_PASSWORD=p@ss:word'
      ;;
    *) printf '%s\n' '55432' ;;
  esac
elif [[ "${1:-}" == "exec" ]]; then
  printf 'docker %s\n' "$*" >>"${TEST_COMMAND_LOG}"
else
  printf 'Unexpected docker command: %s\n' "$*" >&2
  exit 1
fi
EOF
  cat >"${bin}/go" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "env" && "${2:-}" == "GOVERSION" ]]; then
  [[ "${GOENV:-}" == "off" && "${GOTOOLCHAIN:-}" == "local" ]]
  printf '%s\n' 'go1.26.6'
elif [[ "${1:-}" == "run" ]]; then
  [[ "${GOENV:-}" == "off" ]]
  [[ "${GOWORK:-}" == "off" ]]
  [[ "${GOTOOLCHAIN:-}" == "local" ]]
  [[ "${GOFLAGS:-}" == "-mod=readonly" ]]
  expected='postgres://dev%20user:p%40ss%3Aword@127.0.0.1:55432/fukamu_cycle_test?sslmode=disable'
  [[ "${DATABASE_URL:-}" == "${expected}" && "${MIGRATIONS_DIR:-}" == "migrations" ]]
  printf 'go %s\n' "$*" >>"${TEST_COMMAND_LOG}"
else
  exit 1
fi
EOF
  chmod +x "${bin}/docker" "${bin}/go"

  bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name fukamu_cycle_test --confirm-database-name fukamu_cycle_test --dry-run >/dev/null
  assert_failure "database confirmation mismatch" \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name fukamu_cycle_test --confirm-database-name fukamu_cycle --dry-run
  assert_failure "production database reset" \
    env APP_ENV=production bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name fukamu_cycle_test --confirm-database-name fukamu_cycle_test --dry-run
  assert_failure "invalid reset container name" \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --container-name --privileged \
    --database-name fukamu_cycle_test --confirm-database-name fukamu_cycle_test --dry-run

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    FAKE_POSTGRES_IMAGE="${SUPPLY_CHAIN_POSTGRES_IMAGE}" \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name fukamu_cycle_test --confirm-database-name fukamu_cycle_test --yes >/dev/null
  grep -Fq -- 'dropdb --username dev user --if-exists --force fukamu_cycle_test' "${log}" \
    || fail "reset did not invoke dropdb with the confirmed database"
  grep -Fq -- 'createdb --username dev user --owner dev user fukamu_cycle_test' "${log}" \
    || fail "reset did not recreate the confirmed database"
  assert_file_contains "${log}" "go run ./cmd/migrate"

  assert_failure "remote reset context" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" FAKE_DOCKER_ENDPOINT=tcp://remote:2376 \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name fukamu_cycle_test --confirm-database-name fukamu_cycle_test --yes
  assert_failure "wrong PostgreSQL image" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" FAKE_POSTGRES_IMAGE=postgres:18.6-alpine \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name fukamu_cycle_test --confirm-database-name fukamu_cycle_test --yes
  pass "reset requires exact confirmation and rejects production, remote Docker, and wrong images"
}

test_admission_helpers() {
  local key
  key="$("${repo_root}/scripts/new-beta-admission-key.sh" 2>"${test_root}/key-warning")"
  [[ "${key}" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "Admission key is not 32-byte base64url"

  local output
  local token
  local digest
  local expected_digest
  output="$("${repo_root}/scripts/new-beta-invite.sh" --invite-id tester-1 2>"${test_root}/invite-warning")"
  token="$(sed -n 's/^Token: //p' <<<"${output}")"
  digest="$(sed -n 's/^Allowlist entry: .*"digest":"\([0-9a-f]*\)".*/\1/p' <<<"${output}")"
  [[ "${token}" =~ ^fukamu_cycle_beta_[A-Za-z0-9_-]{43}$ ]] \
    || fail "Admission invite token has an unexpected format"
  expected_digest="$(printf '%s' "${token}" | sha256sum | awk '{print $1}')"
  [[ "${digest}" == "${expected_digest}" ]] || fail "Admission invite digest does not match the token"
  assert_failure "invalid invite ID" \
    "${repo_root}/scripts/new-beta-invite.sh" --invite-id INVALID
  pass "Admission helpers generate base64url secrets and matching SHA-256 digests"
}

test_setup
test_import_env
test_frontend_check
test_full_check_quality_order
test_shell_file_inventory_failure
test_backend_command_build_targets
test_before_commit_check
test_local_app
test_sqlc_runner
test_clean
test_reset_local_db
test_admission_helpers
bash "${script_dir}/check-terraform-state-recovery.sh"
node --test "${script_dir}/staging-critical.test.mjs"
bash "${script_dir}/check-staging-critical.sh"
bash "${script_dir}/check-supply-chain.sh"
bash "${script_dir}/check-ci-security-model.sh"
bash "${script_dir}/check-security.sh"
bash "${script_dir}/check-docs-config.sh"
node --test "${script_dir}/repository-metrics.test.mjs"

printf '%s\n' "Bash script tests passed."
