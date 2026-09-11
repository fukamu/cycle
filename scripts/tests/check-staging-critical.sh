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
output="${test_root}/output.log"
mkdir -p -- "${bin}"
cat >"${bin}/node" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$#" == "1" ]]
[[ "$1" == "${EXPECTED_HARNESS_PATH}" ]]
[[ "${STAGING_BASE_URL}" == "https://cycle.staging.fukamu.matoruru.com" ]]
[[ "${STAGING_CRITICAL_MODE}" == "preflight" || "${STAGING_CRITICAL_MODE}" == "baseline" || "${STAGING_CRITICAL_MODE}" == "full" ]]
if [[ "${STAGING_CRITICAL_MODE}" == "preflight" ]]; then
  [[ -z "${STAGING_ADMISSION_MODE+x}" ]]
  [[ -z "${STAGING_E2E_INVITE_TOKEN+x}" ]]
else
  [[ "${STAGING_ADMISSION_MODE}" == "auto" || "${STAGING_ADMISSION_MODE}" == "off" || "${STAGING_ADMISSION_MODE}" == "closed" ]]
  if [[ "${STAGING_ADMISSION_MODE}" != "off" ]]; then
    [[ "${STAGING_E2E_INVITE_TOKEN}" =~ ^fukamu_cycle_beta_[A-Za-z0-9_-]{43}$ ]]
  else
    [[ -z "${STAGING_E2E_INVITE_TOKEN+x}" ]]
  fi
fi
[[ -z "${DEBUG+x}" ]]
[[ -z "${NODE_DEBUG+x}" ]]
[[ -z "${NODE_OPTIONS+x}" ]]
[[ -z "${PWDEBUG+x}" ]]
printf 'node %s\n' "$1" >"${TEST_COMMAND_LOG}"
printf 'mode=%s admission=%s\n' "${STAGING_CRITICAL_MODE}" "${STAGING_ADMISSION_MODE:-unset}" >>"${TEST_COMMAND_LOG}"
EOF
chmod +x -- "${bin}/node"

token="fukamu_cycle_beta_$(printf 'A%.0s' {1..43})"
env \
  PATH="${bin}:${PATH}" \
  TEST_COMMAND_LOG="${log}" \
  EXPECTED_HARNESS_PATH="${repo_root}/frontend/e2e/staging-critical.mjs" \
  DEBUG="pw:api" \
  NODE_DEBUG="module" \
  NODE_OPTIONS="--trace-warnings" \
  PWDEBUG="console" \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="full" \
  STAGING_ADMISSION_MODE="closed" \
  STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh" >"${output}" 2>&1

expected="$(
  printf '%s\n' \
    "node ${repo_root}/frontend/e2e/staging-critical.mjs" \
    "mode=full admission=closed"
)"
[[ "$(cat "${log}")" == "${expected}" ]] || fail "staging wrapper did not invoke the exact harness command"
if grep -Fq -- "${token}" "${output}" || grep -Fq -- "${token}" "${log}"; then
  fail "staging wrapper exposed the invite token"
fi

assert_failure "staging wrapper with arguments" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="full" STAGING_ADMISSION_MODE="closed" \
  STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh" unexpected
assert_failure "staging wrapper without base URL" \
  env -u STAGING_BASE_URL STAGING_CRITICAL_MODE="full" STAGING_ADMISSION_MODE="closed" STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper with blank base URL" \
  env STAGING_BASE_URL="   " STAGING_CRITICAL_MODE="full" STAGING_ADMISSION_MODE="closed" STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper without invite token" \
  env -u STAGING_E2E_INVITE_TOKEN \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="full" STAGING_ADMISSION_MODE="closed" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper with blank invite token" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="full" STAGING_ADMISSION_MODE="closed" \
  STAGING_E2E_INVITE_TOKEN=$' \t ' \
  bash "${repo_root}/scripts/check-staging-critical.sh"

env \
  -u STAGING_ADMISSION_MODE \
  -u STAGING_E2E_INVITE_TOKEN \
  PATH="${bin}:${PATH}" \
  TEST_COMMAND_LOG="${log}" \
  EXPECTED_HARNESS_PATH="${repo_root}/frontend/e2e/staging-critical.mjs" \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="preflight" \
  bash "${repo_root}/scripts/check-staging-critical.sh" >"${output}" 2>&1
[[ "$(tail -n 1 "${log}")" == "mode=preflight admission=unset" ]] || fail "preflight wrapper contract failed"

assert_failure "preflight wrapper with admission mode" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="preflight" STAGING_ADMISSION_MODE="off" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
grep -Fq -- "target=current-public; mutation_started=false; cleanup_state=not_applicable" "${test_root}/last-output" || fail "preflight configuration diagnostic omitted safe state"
assert_failure "preflight wrapper with invite token" \
  env -u STAGING_ADMISSION_MODE \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="preflight" STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
env \
  PATH="${bin}:${PATH}" \
  TEST_COMMAND_LOG="${log}" \
  EXPECTED_HARNESS_PATH="${repo_root}/frontend/e2e/staging-critical.mjs" \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="baseline" \
  STAGING_ADMISSION_MODE="off" \
  bash "${repo_root}/scripts/check-staging-critical.sh" >"${output}" 2>&1
[[ "$(tail -n 1 "${log}")" == "mode=baseline admission=off" ]] || fail "off-mode wrapper contract failed"

env \
  PATH="${bin}:${PATH}" \
  TEST_COMMAND_LOG="${log}" \
  EXPECTED_HARNESS_PATH="${repo_root}/frontend/e2e/staging-critical.mjs" \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="baseline" \
  STAGING_ADMISSION_MODE="auto" \
  STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh" >"${output}" 2>&1
[[ "$(tail -n 1 "${log}")" == "mode=baseline admission=auto" ]] || fail "auto-mode wrapper contract failed"

assert_failure "auto-mode staging wrapper without invite token" \
  env -u STAGING_E2E_INVITE_TOKEN \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_CRITICAL_MODE="baseline" STAGING_ADMISSION_MODE="auto" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
grep -Fq -- "::warning::Staging critical diagnostic failed; target=current-public; mutation_started=false; cleanup_state=not_started" "${test_root}/last-output" || fail "baseline configuration failure was not a safe warning"

assert_failure "staging wrapper without critical mode" \
  env -u STAGING_CRITICAL_MODE STAGING_ADMISSION_MODE="off" \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper without admission mode" \
  env -u STAGING_ADMISSION_MODE STAGING_CRITICAL_MODE="baseline" \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  bash "${repo_root}/scripts/check-staging-critical.sh"

printf '%s\n' "Staging critical wrapper tests passed."
