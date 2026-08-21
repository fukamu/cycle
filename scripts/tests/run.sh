#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
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
if [[ "${1:-}" == "env" && "${2:-}" == "GOVERSION" ]]; then
  printf '%s\n' 'go1.26.6'
else
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
  assert_file_contains "${log}" "pnpm --filter pdcai-cloudflare run types"
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
  assert_file_contains "${log}" "--filter pdcai-frontend run format:check"
  assert_file_contains "${log}" "--filter pdcai-frontend run lint"
  assert_file_contains "${log}" "--filter pdcai-frontend run typecheck"
  assert_file_contains "${log}" "--filter pdcai-frontend test"
  assert_file_contains "${log}" "--filter pdcai-frontend run build"
  assert_failure "E2E with a partial scope" \
    bash "${fixture}/scripts/check.sh" --scope frontend --e2e
  assert_failure "unknown check scope" \
    bash "${fixture}/scripts/check.sh" --scope unknown
  pass "check runs the frontend contract and rejects unsafe E2E scope"
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
    '{{.Config.Image}}') printf '%s\n' "${FAKE_POSTGRES_IMAGE:-postgres:18.6-alpine3.24}" ;;
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
  printf '%s\n' 'go1.26.6'
elif [[ "${1:-}" == "run" ]]; then
  expected='postgres://dev%20user:p%40ss%3Aword@127.0.0.1:55432/pdcai_test?sslmode=disable'
  [[ "${DATABASE_URL:-}" == "${expected}" && "${MIGRATIONS_DIR:-}" == "migrations" ]]
  printf 'go %s\n' "$*" >>"${TEST_COMMAND_LOG}"
else
  exit 1
fi
EOF
  chmod +x "${bin}/docker" "${bin}/go"

  bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name pdcai_test --confirm-database-name pdcai_test --dry-run >/dev/null
  assert_failure "database confirmation mismatch" \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name pdcai_test --confirm-database-name pdcai --dry-run
  assert_failure "production database reset" \
    env APP_ENV=production bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name pdcai_test --confirm-database-name pdcai_test --dry-run
  assert_failure "invalid reset container name" \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --container-name --privileged \
    --database-name pdcai_test --confirm-database-name pdcai_test --dry-run

  PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name pdcai_test --confirm-database-name pdcai_test --yes >/dev/null
  grep -Fq -- 'dropdb --username dev user --if-exists --force pdcai_test' "${log}" \
    || fail "reset did not invoke dropdb with the confirmed database"
  grep -Fq -- 'createdb --username dev user --owner dev user pdcai_test' "${log}" \
    || fail "reset did not recreate the confirmed database"
  assert_file_contains "${log}" "go run ./cmd/migrate"

  assert_failure "remote reset context" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" FAKE_DOCKER_ENDPOINT=tcp://remote:2376 \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name pdcai_test --confirm-database-name pdcai_test --yes
  assert_failure "wrong PostgreSQL image" \
    env PATH="${bin}:${PATH}" TEST_COMMAND_LOG="${log}" FAKE_POSTGRES_IMAGE=postgres:18.6-alpine \
    bash "${fixture}/scripts/reset-local-db.sh" \
    --database-name pdcai_test --confirm-database-name pdcai_test --yes
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
  [[ "${token}" =~ ^pdcai_beta_[A-Za-z0-9_-]{43}$ ]] \
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
test_local_app
test_sqlc_runner
test_clean
test_reset_local_db
test_admission_helpers

printf '%s\n' "Bash script tests passed."
