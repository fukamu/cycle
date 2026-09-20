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

assert_failure() {
  local description="$1"
  shift
  if "$@" >"${test_root}/last-output" 2>&1; then
    fail "${description} unexpectedly succeeded"
  fi
}

bin="${test_root}/bin"
log="${test_root}/command.log"
mkdir -p -- "${bin}"
cat >"${bin}/node" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$#" == "1" ]]
[[ "$1" == "${EXPECTED_HARNESS_PATH}" ]]
[[ "${STAGING_BASE_URL}" == "https://cycle.staging.fukamu.matoruru.com" ]]
[[ "${STAGING_CRITICAL_MODE}" == "preflight" || "${STAGING_CRITICAL_MODE}" == "baseline" || "${STAGING_CRITICAL_MODE}" == "full" ]]
[[ -z "${DEBUG+x}" ]]
[[ -z "${NODE_DEBUG+x}" ]]
[[ -z "${NODE_OPTIONS+x}" ]]
[[ -z "${PWDEBUG+x}" ]]
printf 'node %s\nmode=%s\n' "$1" "${STAGING_CRITICAL_MODE}" >"${TEST_COMMAND_LOG}"
EOF
chmod +x -- "${bin}/node"

run_valid() {
  local mode="$1"
  env \
    PATH="${bin}:${PATH}" \
    TEST_COMMAND_LOG="${log}" \
    EXPECTED_HARNESS_PATH="${repo_root}/frontend/e2e/staging-critical.mjs" \
    DEBUG="pw:api" NODE_DEBUG="module" NODE_OPTIONS="--trace-warnings" PWDEBUG="console" \
    STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
    STAGING_CRITICAL_MODE="${mode}" \
    bash "${repo_root}/scripts/check-staging-critical.sh" >/dev/null 2>&1
  [[ "$(tail -n 1 "${log}")" == "mode=${mode}" ]] || fail "${mode} wrapper contract failed"
}

run_valid full
run_valid preflight
run_valid baseline

assert_failure "staging wrapper with arguments" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" STAGING_CRITICAL_MODE=full \
  bash "${repo_root}/scripts/check-staging-critical.sh" unexpected
assert_failure "staging wrapper without base URL" \
  env -u STAGING_BASE_URL STAGING_CRITICAL_MODE=full \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper with blank base URL" \
  env STAGING_BASE_URL="   " STAGING_CRITICAL_MODE=full \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper without critical mode" \
  env -u STAGING_CRITICAL_MODE STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper with invalid critical mode" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" STAGING_CRITICAL_MODE=invalid \
  bash "${repo_root}/scripts/check-staging-critical.sh"

printf '%s\n' "Staging critical wrapper tests passed."
