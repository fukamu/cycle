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

fake_bin="${test_root}/bin"
runner_temp="${test_root}/runner"
summary="${test_root}/summary.md"
log="${test_root}/command.log"
output="${test_root}/output.log"
mkdir -p -- "${fake_bin}" "${runner_temp}"
touch -- "${summary}" "${log}"

cat >"${fake_bin}/node" <<'FAKE_NODE'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  ./scripts/check-cloudflare-drain-evidence.mjs)
    printf '%s\n' drain-start >>"${TEST_COMMAND_LOG}"
    printf '%s\n' cloudflare_drain_baseline_ready
    IFS= read -r acknowledgement
    [[ "${acknowledgement}" == candidate_deploy_completed ]]
    printf '%s\n' drain-ack >>"${TEST_COMMAND_LOG}"
    printf '{"result":"drained","commitSHA":"%s","workerDeploymentId":"00000000-0000-4000-8000-000000000001","workerVersionId":"00000000-0000-4000-8000-000000000002","drainedWorkerVersionId":"00000000-0000-4000-8000-000000000003","containerApplicationId":"00000000-0000-4000-8000-000000000004","containerRolloutId":"00000000-0000-4000-8000-000000000005","containerVersion":2,"containerImageDigest":"sha256:%s","containerInstanceId":"00000000-0000-4000-8000-000000000006","drainedContainerVersion":1,"drainedContainerImageDigest":"sha256:%s","observedAt":"2026-09-07T00:00:00.000Z"}\n' \
      "${COMMIT_SHA}" "$(printf '1%.0s' {1..64})" "$(printf '2%.0s' {1..64})"
    ;;
  ./scripts/materialize-staging-worker-secrets.mjs)
    [[ "${WORKER_SECRETS_FILE}" == "${RUNNER_TEMP}/fukamu-cycle-worker-secrets.json" ]]
    printf '%s\n' materialize >>"${TEST_COMMAND_LOG}"
    printf '%s' '{"private":"worker-private-value"}' >"${WORKER_SECRETS_FILE}"
    chmod 600 "${WORKER_SECRETS_FILE}"
    ;;
  ./scripts/write-staging-rollout-evidence.mjs)
    [[ "${STAGING_ROLLOUT_EVIDENCE_STAGE}" == drained ]]
    IFS= read -r evidence
    [[ "${evidence}" == *'"result":"drained"'* ]]
    printf '%s\n' writer >>"${TEST_COMMAND_LOG}"
    printf '%s\n' '{"result":"drained_smoke_pending"}' >"${STAGING_ROLLOUT_EVIDENCE_FILE}"
    printf '%s\n' 'safe summary' >>"${GITHUB_STEP_SUMMARY}"
    ;;
  *) exit 97 ;;
esac
FAKE_NODE

cat >"${fake_bin}/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' gh >>"${TEST_COMMAND_LOG}"
printf '%s\n' "${FAKE_MAIN_SHA:-${COMMIT_SHA}}"
FAKE_GH

cat >"${fake_bin}/go" <<'FAKE_GO'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${PWD}" == */backend ]]
[[ "$*" == 'run ./cmd/migrate' ]]
[[ "${DATABASE_URL}" == migration-private-value ]]
printf '%s\n' migrate >>"${TEST_COMMAND_LOG}"
FAKE_GO

cat >"${fake_bin}/pnpm" <<'FAKE_PNPM'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f "${RUNNER_TEMP}/fukamu-cycle-worker-secrets.json" ]]
[[ "$*" == *'wrangler deploy'* ]]
[[ "$*" == *"--tag ${COMMIT_SHA}"* ]]
[[ "$*" == *"--secrets-file ${RUNNER_TEMP}/fukamu-cycle-worker-secrets.json"* ]]
printf '%s\n' deploy >>"${TEST_COMMAND_LOG}"
[[ "${FAKE_PNPM_FAIL:-0}" == 0 ]]
FAKE_PNPM
chmod +x -- "${fake_bin}/node" "${fake_bin}/gh" "${fake_bin}/go" "${fake_bin}/pnpm"

commit_sha="$(printf 'a%.0s' {1..40})"

run_child() {
  local main_sha="$1"
  local pnpm_fail="$2"
  local deploy_mode="${3-normal}"
  local infra_evidence_kind="${4-no_changes_plan}"
  local infra_evidence_run_id="${5-456}"
  local infra_plan_sha256="${6-$(printf '3%.0s' {1..64})}"
  env -i \
    PATH="${fake_bin}:/usr/bin:/bin" \
    TEST_COMMAND_LOG="${log}" \
    RUNNER_TEMP="${runner_temp}" \
    GITHUB_STEP_SUMMARY="${summary}" \
    GITHUB_REPOSITORY=fukamu/cycle \
    GITHUB_ACTOR=matoruru \
    GITHUB_RUN_ID=123 \
    GITHUB_RUN_ATTEMPT=1 \
    EXACT_MAIN_CI_RUN_ID=789 \
    GH_TOKEN=github-private-value \
    COMMIT_SHA="${commit_sha}" \
    FAKE_MAIN_SHA="${main_sha}" \
    FAKE_PNPM_FAIL="${pnpm_fail}" \
    DEPLOY_MODE="${deploy_mode}" \
    INFRA_EVIDENCE_KIND="${infra_evidence_kind}" \
    INFRA_EVIDENCE_RUN_ID="${infra_evidence_run_id}" \
    INFRA_PLAN_SHA256="${infra_plan_sha256}" \
    PUBLIC_ORIGIN=https://cycle.staging.fukamu.matoruru.com \
    MIGRATION_DATABASE_URL=migration-private-value \
    DATABASE_URL=runtime-database-private-value \
    CLOUDFLARE_ACCOUNT_ID="$(printf 'b%.0s' {1..32})" \
    CLOUDFLARE_API_TOKEN=cloudflare-private-value \
    OTEL_EXPORTER_OTLP_HEADERS=otel-private-value \
    SESSION_TOKEN_PEPPER=session-private-value \
    CSRF_TOKEN_PEPPER=csrf-private-value \
    BOOTSTRAP_ID_PEPPER=bootstrap-private-value \
    RATE_LIMIT_HMAC_SECRET=rate-private-value \
    CURSOR_SIGNING_SECRET=cursor-private-value \
    OPENAI_API_KEY=openai-private-value \
    TURNSTILE_SECRET_KEY=turnstile-private-value \
    BETA_ADMISSION_MODE=off \
    AI_MODEL=model \
    OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.invalid \
    DB_MAX_OPEN_CONNS=1 DB_MAX_IDLE_CONNS=1 DB_CONN_MAX_LIFETIME_MINUTES=1 \
    SESSION_IDLE_DAYS=1 SESSION_ABSOLUTE_DAYS=1 SESSION_ACTIVITY_TOUCH_MINUTES=1 \
    ANONYMOUS_BOOTSTRAP_TTL_MINUTES=1 MAX_PROGRESSING_GOALS=1 AI_REASONING_EFFORT=low \
    AI_MAX_INPUT_TOKENS=1 AI_GOAL_REFINE_MAX_OUTPUT_TOKENS=1 AI_ACTION_MAX_OUTPUT_TOKENS=1 \
    AI_MAX_CONTEXT_CYCLES=1 AI_TIMEOUT_SECONDS=1 AI_MAX_PROVIDER_ATTEMPTS=1 \
    AI_MAX_RETRY_BACKOFF_SECONDS=1 AI_FINALIZATION_GRACE_SECONDS=1 AI_LEASE_SECONDS=1 \
    AI_MAX_GENERATIONS_PER_USER_24H=1 AI_GOAL_REFINE_PROMPT_VERSION=v1 \
    AI_GENERATE_PROMPT_VERSION=v1 AI_REFINE_PROMPT_VERSION=v1 AI_TOKENIZER_ENCODING=test \
    AI_MONTHLY_BUDGET_USD=1 AI_WARNING_THRESHOLDS=1 \
    AI_PRICE_INPUT_USD_PER_MILLION=1 AI_PRICE_OUTPUT_USD_PER_MILLION=1 \
    GOOGLE_WEB_CLIENT_ID=client RATE_ANONYMOUS_CREATE_PER_IP_HOUR=1 \
    RATE_ANONYMOUS_CREATE_PER_IP_24H=1 RATE_GOAL_START_PER_USER_MINUTE=1 \
    RATE_GOAL_START_PER_SESSION_MINUTE=1 RATE_AI_PER_USER_MINUTE=1 \
    RATE_AI_PER_SESSION_MINUTE=1 RATE_AI_PER_IP_MINUTE=1 \
    bash "${repo_root}/scripts/run-staging-candidate-deploy-and-drain.sh"
}

: >"${log}"
run_child "${commit_sha}" 0 >"${output}" 2>&1 \
  || fail "candidate deploy/drain wrapper rejected the valid fixture"
[[ "$(cat "${log}")" == $'drain-start\ngh\nmigrate\ngh\nmaterialize\ndeploy\ndrain-ack\nwriter' ]] \
  || fail "candidate deploy/drain command order changed"
[[ ! -e "${runner_temp}/fukamu-cycle-worker-secrets.json" ]] \
  || fail "candidate deploy/drain left the Worker secret file"
[[ -f "${runner_temp}/fukamu-cycle-stable-csrf-rollout-drained.json" ]] \
  || fail "candidate deploy/drain did not create release evidence"
for private_value in github-private-value migration-private-value runtime-database-private-value cloudflare-private-value worker-private-value; do
  if grep -Fq -- "${private_value}" "${output}" "${log}" "${summary}"; then
    fail "candidate deploy/drain exposed a private value"
  fi
done

rm -f -- "${runner_temp}/fukamu-cycle-stable-csrf-rollout-drained.json"
: >"${log}"
run_child "${commit_sha}" 0 recovery '' '' '' >"${output}" 2>&1 \
  || fail "candidate deploy/drain wrapper rejected the valid recovery fixture"
[[ "$(cat "${log}")" == $'drain-start\ngh\nmigrate\ngh\nmaterialize\ndeploy\ndrain-ack\nwriter' ]] \
  || fail "candidate deploy/drain recovery command order changed"

rm -f -- "${runner_temp}/fukamu-cycle-stable-csrf-rollout-drained.json"
: >"${log}"
if run_child "${commit_sha}" 0 normal changes_present 456 "$(printf '3%.0s' {1..64})" >"${output}" 2>&1; then
  fail "candidate deploy/drain accepted an invalid Terraform evidence kind"
fi
[[ ! -s "${log}" ]] \
  || fail "invalid Terraform evidence reached a deployment operation"

: >"${log}"
if run_child "$(printf 'c%.0s' {1..40})" 0 >"${output}" 2>&1; then
  fail "candidate deploy/drain accepted stale main"
fi
[[ ! -e "${runner_temp}/fukamu-cycle-worker-secrets.json" ]] \
  || fail "stale-main failure left a Worker secret file"
if grep -Fq migrate "${log}"; then
  fail "stale-main failure reached migration"
fi

: >"${log}"
if run_child "${commit_sha}" 1 >"${output}" 2>&1; then
  fail "candidate deploy/drain accepted a failed Wrangler deployment"
fi
[[ ! -e "${runner_temp}/fukamu-cycle-worker-secrets.json" ]] \
  || fail "failed deployment left a Worker secret file"
if grep -Fq drain-ack "${log}"; then
  fail "failed deployment started drain polling"
fi

printf '%s\n' "Staging candidate deploy/drain wrapper tests passed."
