#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath -e -- "${script_dir}/../..")"
recovery_script="${repo_root}/scripts/backup-and-drill-terraform-state.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "${test_root}"' EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

assert_failure() {
  local description="$1"
  shift
  if "$@"; then
    fail "${description} unexpectedly succeeded"
  fi
}

assert_exact_line() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(grep -Fxc -- "${expected}" "${file}" || true)"
  [[ "${actual}" == "1" ]] || fail "expected one exact contract line in ${file}: ${expected}"
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "${expected}" "${file}" \
    || fail "expected contract text in ${file}: ${expected}"
}

assert_lines_in_order() {
  local file="$1"
  shift
  local previous=0
  local expected
  local line_number
  for expected in "$@"; do
    line_number="$(awk -v expected="${expected}" '$0 == expected { print NR; exit }' "${file}")"
    [[ -n "${line_number}" && "${line_number}" -gt "${previous}" ]] \
      || fail "expected ordered contract line in ${file}: ${expected}"
    previous="${line_number}"
  done
}

bin="${test_root}/bin"
runner_temp="${test_root}/runner"
object_root="${test_root}/objects"
command_log="${test_root}/commands.log"
output="${test_root}/output.log"
fixture_state="${test_root}/live.tfstate"
github_output="${test_root}/github-output"
mkdir -p -- "${bin}"

cat >"${fixture_state}" <<'EOF'
{"version":4,"terraform_version":"1.15.8","serial":7,"lineage":"0198c20b-7b95-7000-8000-000000000027","outputs":{"private":{"value":"state-private-canary","type":"string","sensitive":true}},"resources":[]}
EOF

cat >"${bin}/date" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$#" == "2" && "$1" == "-u" && "$2" == "+%Y%m%dT%H%M%SZ" ]]
printf '%s\n' '20260827T123456Z'
EOF

cat >"${bin}/terraform" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'terraform|%s|' "$PWD" >>"${FAKE_COMMAND_LOG}"
printf '%q ' "$@" >>"${FAKE_COMMAND_LOG}"
printf '\n' >>"${FAKE_COMMAND_LOG}"

command_name="${1:-}"
if [[ "${FAKE_TERRAFORM_FAIL_COMMAND:-}" == "${command_name}" ]]; then
  exit 9
fi

case "${command_name}" in
  version)
    [[ "$#" == "2" && "$2" == "-json" ]]
    printf '%s\n' '{"terraform_version":"1.15.8"}'
    ;;
  state)
    [[ "$#" == "2" && "$2" == "pull" ]]
    cat -- "${FAKE_TERRAFORM_STATE}"
    ;;
  init)
    backend_config=""
    for argument in "$@"; do
      case "${argument}" in
        -backend-config=*) backend_config="${argument#-backend-config=}" ;;
      esac
    done
    [[ -f "${backend_config}" ]]
    grep -Fq -- 'key    = "fukamu-cycle/staging/state-restore-drills/' "${backend_config}"
    ;;
  plan)
    saw_refresh=false
    saw_lock=false
    output_path=""
    for argument in "$@"; do
      case "${argument}" in
        -refresh=false) saw_refresh=true ;;
        -lock=false) saw_lock=true ;;
        -out=*) output_path="${argument#-out=}" ;;
      esac
    done
    [[ "${saw_refresh}" == "true" && "${saw_lock}" == "true" && -n "${output_path}" ]]
    : >"${output_path}"
    ;;
  *) exit 8 ;;
esac
EOF

cat >"${bin}/aws" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${AWS_ACCESS_KEY_ID}" == "${FAKE_EXPECTED_ACCESS_KEY_ID}" ]]
[[ "${AWS_SECRET_ACCESS_KEY}" == "${FAKE_EXPECTED_SECRET_ACCESS_KEY}" ]]
[[ "${AWS_REGION}" == "auto" && "${AWS_DEFAULT_REGION}" == "auto" ]]
[[ "${AWS_EC2_METADATA_DISABLED}" == "true" ]]
[[ "${AWS_CLI_AUTO_PROMPT}" == "off" ]]
[[ -f "${AWS_CONFIG_FILE}" && -f "${AWS_SHARED_CREDENTIALS_FILE}" ]]

arguments=("$@")
service_index=-1
for index in "${!arguments[@]}"; do
  if [[ "${arguments[index]}" == "s3api" ]]; then
    service_index="${index}"
    break
  fi
done
((service_index >= 0))
operation="${arguments[service_index + 1]}"

option_value() {
  local name="$1"
  local index
  for index in "${!arguments[@]}"; do
    if [[ "${arguments[index]}" == "${name}" ]]; then
      printf '%s' "${arguments[index + 1]}"
      return 0
    fi
  done
  return 1
}

bucket="$(option_value --bucket)"
key="$(option_value --key)"
[[ "${bucket}" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]
[[ "${key}" =~ ^fukamu-cycle/staging/(state-backups|state-restore-drills)/[A-Za-z0-9._/-]+$ ]]
printf 'aws|%s|%s|%s\n' "${operation}" "${bucket}" "${key}" >>"${FAKE_COMMAND_LOG}"

if [[ "${FAKE_AWS_FAIL_OPERATION:-}" == "${operation}" &&
  ( -z "${FAKE_AWS_FAIL_KEY_SUFFIX:-}" || "${key}" == *"${FAKE_AWS_FAIL_KEY_SUFFIX}" ) ]]; then
  exit 7
fi

target="${FAKE_R2_ROOT}/${bucket}/${key}"
case "${operation}" in
  put-object)
    body="$(option_value --body)"
    if_none_match="$(option_value --if-none-match)"
    [[ -f "${body}" && "${if_none_match}" == "*" && ! -e "${target}" ]]
    mkdir -p -- "$(dirname -- "${target}")"
    cp -- "${body}" "${target}"
    printf '%s\n' '{}'
    ;;
  get-object)
    output_path="${arguments[${#arguments[@]} - 1]}"
    [[ -f "${target}" && ! -e "${output_path}" ]]
    if [[ "${FAKE_AWS_CORRUPT_CHECKSUM:-}" == "true" && "${key}" == *.sha256 ]]; then
      printf '%064d\n' 0 >"${output_path}"
    elif [[ "${FAKE_AWS_CORRUPT_CHECKSUM:-}" == "multiline" && "${key}" == *.sha256 ]]; then
      printf '%032d\n%032d\n' 0 0 >"${output_path}"
    else
      cp -- "${target}" "${output_path}"
    fi
    printf '%s\n' '{}'
    ;;
  delete-object)
    rm -f -- "${target}"
    printf '%s\n' '{}'
    ;;
  *) exit 6 ;;
esac

if [[ "${FAKE_AWS_FAIL_AFTER_OPERATION:-}" == "${operation}" &&
  ( -z "${FAKE_AWS_FAIL_KEY_SUFFIX:-}" || "${key}" == *"${FAKE_AWS_FAIL_KEY_SUFFIX}" ) ]]; then
  exit 7
fi
EOF
chmod +x -- "${bin}/date" "${bin}/terraform" "${bin}/aws"

commit_sha="0123456789abcdef0123456789abcdef01234567"
bucket="fukamu-cycle-state-test"
account_id="abcdef0123456789abcdef0123456789"
access_key_id="$(printf 'A%.0s' {1..32})"
secret_access_key="$(printf 'B%.0s' {1..64})"
backup_key="fukamu-cycle/staging/state-backups/${commit_sha}/20260827T123456Z.tfstate"
checksum_key="${backup_key}.sha256"
drill_key="fukamu-cycle/staging/state-restore-drills/${commit_sha}/123456789-2/terraform.tfstate"

prepare_run() {
  rm -rf -- "${runner_temp}" "${object_root}"
  mkdir -p -- "${runner_temp}" "${object_root}"
  : >"${command_log}"
  : >"${output}"
  : >"${github_output}"
}

run_recovery() {
  prepare_run
  env -i \
    PATH="${bin}:${PATH}" \
    RUNNER_TEMP="${runner_temp}" \
    GITHUB_OUTPUT="${github_output}" \
    COMMIT_SHA="${commit_sha}" \
    GITHUB_RUN_ID="123456789" \
    GITHUB_RUN_ATTEMPT="2" \
    R2_STATE_BUCKET="${bucket}" \
    TF_VAR_cloudflare_account_id="${account_id}" \
    AWS_ACCESS_KEY_ID="${access_key_id}" \
    AWS_SECRET_ACCESS_KEY="${secret_access_key}" \
    FAKE_EXPECTED_ACCESS_KEY_ID="${access_key_id}" \
    FAKE_EXPECTED_SECRET_ACCESS_KEY="${secret_access_key}" \
    FAKE_COMMAND_LOG="${command_log}" \
    FAKE_R2_ROOT="${object_root}" \
    FAKE_TERRAFORM_STATE="${fixture_state}" \
    "$@" \
    bash "${recovery_script}" >"${output}" 2>&1
}

assert_failure "invalid commit identity" run_recovery COMMIT_SHA=invalid
[[ ! -s "${command_log}" ]] || fail "invalid input reached Terraform or R2"

assert_failure "ambient AWS profile" run_recovery AWS_PROFILE=default
[[ ! -s "${command_log}" ]] || fail "ambient AWS profile reached Terraform or R2"

assert_failure "live state pull failure" run_recovery FAKE_TERRAFORM_FAIL_COMMAND=state
if grep -Fq -- 'aws|' "${command_log}"; then
  fail "state-pull failure reached R2"
fi

assert_failure "checksum upload failure" run_recovery \
  FAKE_AWS_FAIL_OPERATION=put-object \
  FAKE_AWS_FAIL_KEY_SUFFIX=.sha256
[[ -f "${object_root}/${bucket}/${backup_key}" ]] \
  || fail "successful state upload was unexpectedly removed"
[[ ! -e "${object_root}/${bucket}/${checksum_key}" ]] \
  || fail "failed checksum upload created an object"
if grep -Fq -- 'state-restore-drills' "${command_log}"; then
  fail "checksum upload failure reached the drill"
fi

assert_failure "downloaded checksum mismatch" run_recovery FAKE_AWS_CORRUPT_CHECKSUM=true
if grep -Fq -- 'state-restore-drills' "${command_log}"; then
  fail "checksum mismatch reached the drill"
fi

assert_failure "multiline checksum shape" run_recovery FAKE_AWS_CORRUPT_CHECKSUM=multiline
if grep -Fq -- 'state-restore-drills' "${command_log}"; then
  fail "invalid checksum shape reached the drill"
fi

assert_failure "drill upload response loss" run_recovery \
  FAKE_AWS_FAIL_AFTER_OPERATION=put-object \
  FAKE_AWS_FAIL_KEY_SUFFIX="${drill_key}"
[[ ! -e "${object_root}/${bucket}/${drill_key}" ]] \
  || fail "response-loss cleanup left its isolated state object"
grep -Fq -- "aws|delete-object|${bucket}|${drill_key}" "${command_log}" \
  || fail "response-loss cleanup did not attempt isolated state deletion"

assert_failure "isolated Terraform plan failure" run_recovery FAKE_TERRAFORM_FAIL_COMMAND=plan
[[ ! -e "${object_root}/${bucket}/${drill_key}" ]] \
  || fail "failed drill left its isolated state object"
[[ -f "${object_root}/${bucket}/${backup_key}" &&
  -f "${object_root}/${bucket}/${checksum_key}" ]] \
  || fail "failed drill removed the retained backup"

assert_failure "isolated state cleanup failure" run_recovery \
  FAKE_AWS_FAIL_OPERATION=delete-object \
  FAKE_AWS_FAIL_KEY_SUFFIX=terraform.tfstate
[[ -f "${object_root}/${bucket}/${drill_key}" ]] \
  || fail "cleanup failure fixture did not retain the isolated object"

run_recovery COMMIT_SHA="${commit_sha}"
cmp --silent -- "${fixture_state}" "${object_root}/${bucket}/${backup_key}" \
  || fail "backup state bytes changed"
expected_digest="$(sha256sum "${fixture_state}" | awk '{print $1}')"
[[ "$(tr -d '\r\n' <"${object_root}/${bucket}/${checksum_key}")" == "${expected_digest}" ]] \
  || fail "backup checksum object is invalid"
[[ ! -e "${object_root}/${bucket}/${drill_key}" ]] \
  || fail "successful drill left its isolated state object"

grep -Fq -- "state_backup_key=${backup_key}" "${github_output}" \
  || fail "backup key output is missing"
grep -Fq -- "state_backup_checksum_key=${checksum_key}" "${github_output}" \
  || fail "checksum key output is missing"
grep -Fq -- 'plan -refresh=false -lock=false -input=false -no-color -out=' "${command_log}" \
  || fail "isolated drill did not run the exact no-refresh plan"
if grep -Fq -- 'state push' "${command_log}" \
  || grep -Fq -- "aws|put-object|${bucket}|fukamu-cycle/staging/terraform.tfstate" "${command_log}" \
  || grep -Fq -- "aws|delete-object|${bucket}|fukamu-cycle/staging/terraform.tfstate" "${command_log}"; then
  fail "recovery helper mutated the live state key"
fi
for private_value in "${access_key_id}" "${secret_access_key}" "state-private-canary"; do
  if grep -Fq -- "${private_value}" "${output}" \
    || grep -Fq -- "${private_value}" "${command_log}" \
    || grep -Fq -- "${private_value}" "${github_output}"; then
    fail "recovery helper exposed private state or credentials"
  fi
done

plan_workflow="${repo_root}/.github/workflows/terraform-plan.yml"
apply_workflow="${repo_root}/.github/workflows/terraform-apply.yml"
backend_template="${repo_root}/infra/terraform/staging/backend.hcl.example"
terraform_readme="${repo_root}/infra/terraform/staging/README.md"
deployment_doc="${repo_root}/docs/deployment.md"
environment_doc="${repo_root}/docs/environment.md"
operations_doc="${repo_root}/docs/operations.md"

for file in \
  "${plan_workflow}" "${apply_workflow}" "${backend_template}" \
  "${terraform_readme}" "${deployment_doc}" "${environment_doc}" "${operations_doc}"; do
  [[ -f "${file}" && ! -L "${file}" ]] || fail "Terraform recovery contract input is missing or a symlink: ${file}"
done

assert_exact_line "${plan_workflow}" "      AWS_ACCESS_KEY_ID: \${{ secrets.TERRAFORM_R2_ACCESS_KEY_ID }}"
assert_exact_line "${plan_workflow}" "      AWS_SECRET_ACCESS_KEY: \${{ secrets.TERRAFORM_R2_SECRET_ACCESS_KEY }}"
assert_exact_line "${apply_workflow}" "      AWS_ACCESS_KEY_ID: \${{ secrets.TERRAFORM_R2_ACCESS_KEY_ID }}"
assert_exact_line "${apply_workflow}" "      AWS_SECRET_ACCESS_KEY: \${{ secrets.TERRAFORM_R2_SECRET_ACCESS_KEY }}"
if grep -Fq -- 'staging-terraform-apply' "${plan_workflow}"; then
  fail "Terraform Plan must not receive the Apply environment"
fi
assert_exact_line "${plan_workflow}" '          terraform_wrapper: false'
assert_exact_line "${apply_workflow}" '          terraform_wrapper: false'
assert_exact_line "${plan_workflow}" "          terraform init -lock=false -input=false -backend-config=\"\${RUNNER_TEMP}/fukamu-cycle-staging-backend.hcl\""
assert_exact_line "${plan_workflow}" '          terraform plan -lock=false -input=false -no-color -out=staging.tfplan'
assert_exact_line "${backend_template}" 'use_lockfile                 = true'
assert_exact_line "${apply_workflow}" '      - name: Back up and drill Terraform state'
assert_exact_line "${apply_workflow}" '        id: state_recovery'
assert_exact_line "${apply_workflow}" '        run: bash ./scripts/backup-and-drill-terraform-state.sh'
assert_lines_in_order "${apply_workflow}" \
  '      - name: Initialize Terraform' \
  '      - name: Re-verify approved plan is still main HEAD' \
  '      - name: Back up and drill Terraform state' \
  '      - name: Apply approved saved plan'

for file in "${recovery_script}" "${plan_workflow}" "${apply_workflow}"; do
  if grep -Fq -- 'terraform state push' "${file}"; then
    fail "Terraform recovery path contains a state-push path: ${file}"
  fi
done

assert_contains "${terraform_readme}" 'Object Read Only'
assert_contains "${terraform_readme}" 'Object Read & Write'
assert_contains "${deployment_doc}" 'fukamu-cycle/staging/state-backups/<commit-sha>/<utc-timestamp>.tfstate'
assert_contains "${deployment_doc}" 'fukamu-cycle/staging/state-restore-drills/'
assert_contains "${deployment_doc}" 'automatic snapshot deletion is disabled'
assert_contains "${environment_doc}" 'Object Read Only'
assert_contains "${environment_doc}" 'Object Read & Write'
assert_contains "${operations_doc}" 'staging-terraform-apply'
assert_contains "${operations_doc}" 'Object Read & Write'

printf '%s\n' "Terraform state recovery tests passed."
