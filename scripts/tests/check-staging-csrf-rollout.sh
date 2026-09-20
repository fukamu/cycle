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
[[ -z "${DEBUG+x}" ]]
[[ -z "${NODE_DEBUG+x}" ]]
[[ -z "${NODE_OPTIONS+x}" ]]
[[ -z "${PWDEBUG+x}" ]]
printf 'node %s\n' "$1" >"${TEST_COMMAND_LOG}"
EOF
chmod +x -- "${bin}/node"

env \
  PATH="${bin}:${PATH}" \
  TEST_COMMAND_LOG="${log}" \
  EXPECTED_HARNESS_PATH="${repo_root}/frontend/e2e/staging-csrf-rollout.mjs" \
  DEBUG="pw:api" NODE_DEBUG="module" NODE_OPTIONS="--trace-warnings" PWDEBUG="console" \
  STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  bash "${repo_root}/scripts/check-staging-csrf-rollout.sh" >/dev/null 2>&1
[[ "$(cat "${log}")" == "node ${repo_root}/frontend/e2e/staging-csrf-rollout.mjs" ]] \
  || fail "rollout wrapper did not invoke the exact harness"

assert_failure "rollout wrapper with arguments" \
  env STAGING_BASE_URL="https://cycle.staging.fukamu.matoruru.com" \
  bash "${repo_root}/scripts/check-staging-csrf-rollout.sh" unexpected
assert_failure "rollout wrapper without base URL" \
  env -u STAGING_BASE_URL bash "${repo_root}/scripts/check-staging-csrf-rollout.sh"
assert_failure "rollout wrapper with blank base URL" \
  env STAGING_BASE_URL="   " bash "${repo_root}/scripts/check-staging-csrf-rollout.sh"

printf '%s\n' "Staging CSRF rollout wrapper tests passed."
