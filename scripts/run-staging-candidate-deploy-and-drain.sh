#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

drain_pid=""
secrets_file=""

cleanup() {
  local status="$?"
  trap - EXIT
  if [[ -n "${secrets_file}" ]]; then
    rm -f -- "${secrets_file}" 3>&-
    secrets_file=""
  fi
  if [[ -n "${drain_pid}" ]] && kill -0 "${drain_pid}" 2>/dev/null; then
    kill -TERM "${drain_pid}" 2>/dev/null || true
    wait "${drain_pid}" 2>/dev/null || true
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  local source="${1:-configuration}"
  case "${source}" in
    configuration | baseline_handshake | main_guard | mutation_checkpoint | migration | secret_materialization | wrangler_deploy | drain_handshake | evidence_serialization) ;;
    *) source="configuration" ;;
  esac
  printf '%s\n' "::error::Staging candidate deployment failed; source=${source}." >&3 || true
  exit 1
}

if (($# != 0)); then
  fail
fi

required=(
  COMMIT_SHA GITHUB_ACTIONS GITHUB_ACTOR GITHUB_REPOSITORY GITHUB_RUN_ATTEMPT GITHUB_RUN_ID
  GITHUB_STEP_SUMMARY GH_TOKEN RUNNER_TEMP DEPLOY_MODE EXACT_MAIN_CI_RUN_ID PUBLIC_ORIGIN
  STAGING_DEPLOY_CHECKPOINT_STATE_FILE
  MIGRATION_DATABASE_URL DATABASE_URL CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
  OTEL_EXPORTER_OTLP_HEADERS SESSION_TOKEN_PEPPER CSRF_TOKEN_PEPPER
  BOOTSTRAP_ID_PEPPER RATE_LIMIT_HMAC_SECRET CURSOR_SIGNING_SECRET OPENAI_API_KEY
  TURNSTILE_SECRET_KEY AI_MODEL
)
for name in "${required[@]}"; do
  [[ "${!name:-}" =~ [^[:space:]] ]] || fail
done
[[ "${COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]] || fail
[[ "${GITHUB_ACTIONS}" == "true" ]] || fail
[[ "${GITHUB_REPOSITORY}" == "fukamu/cycle" ]] || fail
[[ "${GITHUB_RUN_ID}" =~ ^[1-9][0-9]*$ ]] || fail
[[ "${GITHUB_RUN_ATTEMPT}" =~ ^[1-9][0-9]*$ ]] || fail
[[ "${EXACT_MAIN_CI_RUN_ID}" =~ ^[1-9][0-9]*$ ]] || fail
[[ "${GITHUB_ACTOR}" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]] || fail
[[ "${DEPLOY_MODE}" == "normal" || "${DEPLOY_MODE}" == "recovery" ]] || fail
if [[ "${DEPLOY_MODE}" == "normal" ]]; then
  [[ "${INFRA_EVIDENCE_KIND:-}" == "no_changes_plan" || "${INFRA_EVIDENCE_KIND:-}" == "applied_plan" ]] || fail
  [[ "${INFRA_EVIDENCE_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || fail
  [[ "${INFRA_PLAN_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || fail
else
  [[ -z "${INFRA_EVIDENCE_KIND:-}" ]] || fail
  [[ -z "${INFRA_EVIDENCE_RUN_ID:-}" ]] || fail
  [[ -z "${INFRA_PLAN_SHA256:-}" ]] || fail
fi
[[ "${RUNNER_TEMP}" == /* && -d "${RUNNER_TEMP}" && ! -L "${RUNNER_TEMP}" ]] || fail
[[ "${GITHUB_STEP_SUMMARY}" == /* && ! -L "${GITHUB_STEP_SUMMARY}" ]] || fail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}" 3>&-)" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/.." 3>&-)"
cd -- "${repo_root}" || fail configuration

secrets_file="${RUNNER_TEMP}/fukamu-cycle-worker-secrets.json"
evidence_file="${RUNNER_TEMP}/fukamu-cycle-stable-csrf-rollout-drained.json"
[[ ! -e "${secrets_file}" && ! -L "${secrets_file}" ]] || fail
[[ ! -e "${evidence_file}" && ! -L "${evidence_file}" ]] || fail

coproc DRAIN_EVIDENCE { node ./scripts/check-cloudflare-drain-evidence.mjs 2>&3; }
drain_pid="${DRAIN_EVIDENCE_PID}"
drain_read_fd="${DRAIN_EVIDENCE[0]}"
drain_write_fd="${DRAIN_EVIDENCE[1]}"

IFS= read -r baseline_signal <&"${drain_read_fd}" || fail baseline_handshake
[[ "${baseline_signal}" == "cloudflare_drain_baseline_ready" ]] || fail baseline_handshake

if ! current_main_sha="$(
  gh api \
    -H 'Accept: application/vnd.github+json' \
    "/repos/${GITHUB_REPOSITORY}/git/ref/heads/main" \
    --jq '.object.sha' \
    3>&-
)"; then
  fail main_guard
fi
[[ "${current_main_sha}" =~ ^[0-9a-f]{40}$ && "${current_main_sha}" == "${COMMIT_SHA}" ]] || fail main_guard

if ! STAGING_DEPLOY_CHECKPOINT_OPERATION=mark_mutation_boundary \
  node ./scripts/staging-deploy-retry-checkpoint.mjs 3>&-; then
  fail mutation_checkpoint
fi

if ! (
  cd -- backend
  DATABASE_URL="${MIGRATION_DATABASE_URL}" \
    MIGRATIONS_DIR=migrations \
    GOENV=off \
    GOWORK=off \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=readonly \
    go run ./cmd/migrate
) 3>&-; then
  fail migration
fi

if ! current_main_sha="$(
  gh api \
    -H 'Accept: application/vnd.github+json' \
    "/repos/${GITHUB_REPOSITORY}/git/ref/heads/main" \
    --jq '.object.sha' \
    3>&-
)"; then
  fail main_guard
fi
[[ "${current_main_sha}" =~ ^[0-9a-f]{40}$ && "${current_main_sha}" == "${COMMIT_SHA}" ]] || fail main_guard

umask 077
if ! WORKER_SECRETS_FILE="${secrets_file}" \
  node ./scripts/materialize-staging-worker-secrets.mjs 3>&-; then
  fail secret_materialization
fi

variable_names=(
  PUBLIC_ORIGIN OTEL_EXPORTER_OTLP_ENDPOINT DB_MAX_OPEN_CONNS
  DB_MAX_IDLE_CONNS DB_CONN_MAX_LIFETIME_MINUTES
  SESSION_IDLE_DAYS SESSION_ABSOLUTE_DAYS SESSION_ACTIVITY_TOUCH_MINUTES
  ANONYMOUS_BOOTSTRAP_TTL_MINUTES MAX_PROGRESSING_GOALS AI_MODEL AI_REASONING_EFFORT
  AI_MAX_INPUT_TOKENS
  AI_GOAL_REFINE_MAX_OUTPUT_TOKENS AI_ACTION_MAX_OUTPUT_TOKENS AI_MAX_CONTEXT_CYCLES
  AI_TIMEOUT_SECONDS AI_MAX_PROVIDER_ATTEMPTS AI_MAX_RETRY_BACKOFF_SECONDS
  AI_FINALIZATION_GRACE_SECONDS AI_LEASE_SECONDS AI_MAX_GENERATIONS_PER_USER_24H
  AI_GOAL_REFINE_PROMPT_VERSION AI_GENERATE_PROMPT_VERSION AI_REFINE_PROMPT_VERSION
  AI_TOKENIZER_ENCODING AI_MONTHLY_BUDGET_USD AI_WARNING_THRESHOLDS
  AI_PRICE_INPUT_USD_PER_MILLION AI_PRICE_OUTPUT_USD_PER_MILLION GOOGLE_WEB_CLIENT_ID
  RATE_ANONYMOUS_CREATE_PER_IP_HOUR RATE_ANONYMOUS_CREATE_PER_IP_24H
  RATE_GOAL_START_PER_USER_MINUTE RATE_GOAL_START_PER_SESSION_MINUTE
  RATE_AI_PER_USER_MINUTE RATE_AI_PER_SESSION_MINUTE RATE_AI_PER_IP_MINUTE
)
variable_args=()
for name in "${variable_names[@]}"; do
  [[ "${!name:-}" =~ [^[:space:]] ]] || fail
  variable_args+=(--var "${name}:${!name}")
done
variable_args+=(--var "AI_PRICING_MODEL:${AI_MODEL}")

if ! pnpm --filter fukamu-cycle-cloudflare --fail-if-no-match exec wrangler deploy \
  "${variable_args[@]}" \
  --secrets-file "${secrets_file}" \
  --containers-rollout=immediate \
  --tag "${COMMIT_SHA}" \
  3>&-; then
  fail wrangler_deploy
fi

rm -f -- "${secrets_file}" 3>&-
secrets_file=""

printf '%s\n' "candidate_deploy_completed" >&"${drain_write_fd}" || fail drain_handshake
exec {drain_write_fd}>&-
IFS= read -r drain_evidence <&"${drain_read_fd}" || fail drain_handshake
if IFS= read -r _ <&"${drain_read_fd}"; then
  fail drain_handshake
fi
exec {drain_read_fd}<&-
wait "${drain_pid}" || fail drain_handshake
drain_pid=""

if ! printf '%s\n' "${drain_evidence}" \
  | STAGING_ROLLOUT_EVIDENCE_STAGE=drained \
    STAGING_ROLLOUT_EVIDENCE_FILE="${evidence_file}" \
    node ./scripts/write-staging-rollout-evidence.mjs 3>&-; then
  fail evidence_serialization
fi

printf '%s\n' "Staging candidate deployment and authoritative drain succeeded."
