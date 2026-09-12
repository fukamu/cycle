#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
target="${script_dir}/verify-security-audit-release-gate.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT
fake_bin="${test_root}/bin"
mkdir -p -- "${fake_bin}"

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

cat >"${fake_bin}/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${FAKE_GH_LOG}"
[[ "${FAKE_SCENARIO:-}" != "api_failure" ]] || exit 1

if [[ " $* " == *"/git/ref/heads/main "* ]]; then
  case "${FAKE_SCENARIO:-}" in
    stale_target)
      printf '%s\n' '{"ref":"refs/heads/main","object":{"type":"commit","sha":"cccccccccccccccccccccccccccccccccccccccc"}}'
      ;;
    invalid_main)
      printf '%s\n' '{"ref":"refs/heads/main","object":{"type":"tag","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'
      ;;
    trailing_main)
      printf '%s\n%s\n' \
        '{"ref":"refs/heads/main","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}' \
        '{"sentinel":"must-not-be-printed"}'
      ;;
    *)
      printf '%s\n' '{"ref":"refs/heads/main","object":{"type":"commit","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'
      ;;
  esac
  exit 0
fi

case "${FAKE_SCENARIO:-no_scheduled}" in
  no_scheduled)
    printf '%s\n' '{"total_count":0,"workflow_runs":[]}'
    ;;
  scheduled_success)
    printf '%s\n' '{"total_count":1,"workflow_runs":[{"id":9000,"run_number":30,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"success","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  recovered_then_later_main)
    printf '%s\n' '{"total_count":3,"workflow_runs":[{"id":8999,"run_number":19,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"9999999999999999999999999999999999999999","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}},{"id":9002,"run_number":21,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}},{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  recovery_after_scheduled_rerun)
    printf '%s\n' '{"total_count":2,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":2,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}},{"id":9002,"run_number":21,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  multi_page)
    printf '%s\n%s\n' \
      '{"total_count":2,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}' \
      '{"total_count":2,"workflow_runs":[{"id":9002,"run_number":21,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  stale_success)
    printf '%s\n' '{"total_count":2,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}},{"id":8999,"run_number":19,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"9999999999999999999999999999999999999999","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  cancelled)
    printf '%s\n' '{"total_count":1,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"cancelled","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  wrong_success)
    printf '%s\n' '{"total_count":2,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}},{"id":9002,"run_number":21,"run_attempt":1,"name":"CI","path":".github/workflows/ci.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  invalid_total)
    printf '%s\n' '{"total_count":2,"workflow_runs":[]}'
    ;;
  duplicate_run)
    printf '%s\n' '{"total_count":2,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}},{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  inconsistent_pages)
    printf '%s\n%s\n' \
      '{"total_count":2,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}' \
      '{"total_count":3,"workflow_runs":[{"id":9002,"run_number":21,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
  trailing_history)
    printf '%s\n%s\n' \
      '{"total_count":0,"workflow_runs":[]}' \
      '{"sentinel":"must-not-be-printed"}'
    ;;
  *)
    printf '%s\n' '{"total_count":1,"workflow_runs":[{"id":9001,"run_number":20,"run_attempt":1,"name":"Security audit","path":".github/workflows/security-audit.yml","event":"schedule","status":"completed","conclusion":"failure","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"main","head_repository":{"full_name":"fukamu/cycle"}}]}'
    ;;
esac
FAKE_GH
chmod +x "${fake_bin}/gh"

run_gate() {
  local scenario="$1"
  local sha="${2:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
  : >"${test_root}/gh.log"
  env \
    PATH="${fake_bin}:${PATH}" \
    FAKE_GH_LOG="${test_root}/gh.log" \
    FAKE_SCENARIO="${scenario}" \
    GH_TOKEN=fake \
    GITHUB_REPOSITORY=fukamu/cycle \
    bash "${target}" "${sha}"
}

expect_success() {
  local scenario="$1"
  run_gate "${scenario}" >"${test_root}/output" 2>&1 \
    || fail "${scenario} unexpectedly failed"
}

expect_failure() {
  local scenario="$1"
  if run_gate "${scenario}" >"${test_root}/output" 2>&1; then
    fail "${scenario} unexpectedly passed"
  fi
}

for scenario in \
  no_scheduled \
  scheduled_success \
  recovered_then_later_main \
  recovery_after_scheduled_rerun \
  multi_page; do
  expect_success "${scenario}"
  [[ "$(wc -l <"${test_root}/gh.log")" -eq 2 ]] \
    || fail "${scenario} did not use the bounded API query set"
done
grep -Fq -- \
  'api --paginate --method GET -H Accept: application/vnd.github+json /repos/fukamu/cycle/actions/workflows/security-audit.yml/runs -f branch=main -f status=completed -f per_page=100' \
  "${test_root}/gh.log" \
  || fail "security audit history lookup was not closed to completed main runs"

for scenario in \
  stale_success \
  cancelled \
  wrong_success \
  invalid_main \
  invalid_total \
  duplicate_run \
  inconsistent_pages \
  stale_target \
  trailing_main \
  trailing_history \
  api_failure; do
  expect_failure "${scenario}"
done
grep -Fq -- must-not-be-printed "${test_root}/output" \
  && fail "invalid API payload leaked to diagnostics"

if env PATH="${fake_bin}:${PATH}" GH_TOKEN=fake GITHUB_REPOSITORY=fukamu/cycle \
  bash "${target}" invalid >"${test_root}/output" 2>&1; then
  fail "invalid target SHA unexpectedly passed"
fi
if env PATH="${fake_bin}:${PATH}" GH_TOKEN= GITHUB_REPOSITORY=fukamu/cycle \
  bash "${target}" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  >"${test_root}/output" 2>&1; then
  fail "missing token unexpectedly passed"
fi
if env PATH="${fake_bin}:${PATH}" GH_TOKEN=fake GITHUB_REPOSITORY=invalid \
  bash "${target}" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  >"${test_root}/output" 2>&1; then
  fail "invalid repository unexpectedly passed"
fi

printf '%s\n' "Security audit release gate tests passed."
