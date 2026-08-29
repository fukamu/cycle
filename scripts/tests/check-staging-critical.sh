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
[[ "${STAGING_E2E_INVITE_TOKEN}" =~ ^fukamu_cycle_beta_[A-Za-z0-9_-]{43}$ ]]
[[ -z "${DEBUG+x}" ]]
[[ -z "${NODE_DEBUG+x}" ]]
[[ -z "${NODE_OPTIONS+x}" ]]
[[ -z "${PWDEBUG+x}" ]]
printf 'node %s\n' "$1" >"${TEST_COMMAND_LOG}"
printf 'token_length=%s\n' "${#STAGING_E2E_INVITE_TOKEN}" >>"${TEST_COMMAND_LOG}"
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
  STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh" >"${output}" 2>&1

expected="$(
  printf '%s\n' \
    "node ${repo_root}/frontend/e2e/staging-critical.mjs" \
    "token_length=61"
)"
[[ "$(cat "${log}")" == "${expected}" ]] || fail "staging wrapper did not invoke the exact harness command"
if grep -Fq -- "${token}" "${output}" || grep -Fq -- "${token}" "${log}"; then
  fail "staging wrapper exposed the invite token"
fi

assert_failure "staging wrapper with arguments" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh" unexpected
assert_failure "staging wrapper without base URL" \
  env -u STAGING_BASE_URL STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper with blank base URL" \
  env STAGING_BASE_URL="   " STAGING_E2E_INVITE_TOKEN="${token}" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper without invite token" \
  env -u STAGING_E2E_INVITE_TOKEN \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  bash "${repo_root}/scripts/check-staging-critical.sh"
assert_failure "staging wrapper with blank invite token" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  STAGING_E2E_INVITE_TOKEN=$' \t ' \
  bash "${repo_root}/scripts/check-staging-critical.sh"

printf '%s\n' "Staging critical wrapper tests passed."
