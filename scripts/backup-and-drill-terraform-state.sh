#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
terraform_root="${repo_root}/infra/terraform/staging"
live_state_key="fukamu-cycle/staging/terraform.tfstate"
maximum_state_bytes=$((16 * 1024 * 1024))

if (($# != 0)); then
  die "This command accepts no arguments."
fi

validate_private_environment_value() {
  local name="$1"
  local minimum_length="$2"
  local maximum_length="$3"
  local value="${!name:-}"
  if ((\
    ${#value} < minimum_length || \
    ${#value} > maximum_length)) \
      || [[ "${value}" =~ [[:cntrl:]] ]]; then
    die "${name} is missing or invalid."
  fi
}

[[ "${COMMIT_SHA:-}" =~ ^[0-9a-f]{40}$ ]] \
  || die "COMMIT_SHA must be a 40-character lowercase Git commit SHA."
[[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] \
  || die "GITHUB_RUN_ID must be a positive decimal run ID."
[[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]{0,9}$ ]] \
  || die "GITHUB_RUN_ATTEMPT must be a positive decimal attempt."
[[ "${R2_STATE_BUCKET:-}" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] \
  || die "R2_STATE_BUCKET must be a canonical 3-63 character bucket name."
[[ "${TF_VAR_cloudflare_account_id:-}" =~ ^[0-9a-f]{32}$ ]] \
  || die "TF_VAR_cloudflare_account_id must be 32 lowercase hexadecimal characters."
validate_private_environment_value AWS_ACCESS_KEY_ID 16 128
validate_private_environment_value AWS_SECRET_ACCESS_KEY 32 4096
if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
  validate_private_environment_value AWS_SESSION_TOKEN 16 8192
fi

for name in \
  AWS_ACCOUNT_ID AWS_ACCOUNT_ID_ENDPOINT_MODE AWS_CA_BUNDLE \
  AWS_CLI_AUTO_PROMPT AWS_CLI_FILE_ENCODING AWS_CONFIG_FILE AWS_DATA_PATH \
  AWS_DEFAULT_PROFILE AWS_DEFAULT_REGION AWS_EC2_METADATA_DISABLED \
  AWS_ENDPOINT_URL AWS_ENDPOINT_URL_S3 AWS_MAX_ATTEMPTS AWS_PAGER AWS_PROFILE \
  AWS_REGION AWS_RETRY_MODE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME \
  AWS_SHARED_CREDENTIALS_FILE AWS_SIGV4A_SIGNING_REGION_SET \
  AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_FULL_URI \
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI TF_CLI_ARGS TF_CLI_ARGS_init \
  TF_CLI_ARGS_plan TF_CLI_ARGS_state TF_CLI_CONFIG_FILE TF_DATA_DIR \
  TF_PLUGIN_CACHE_DIR TF_REATTACH_PROVIDERS TF_WORKSPACE; do
  if [[ -n "${!name+x}" ]]; then
    die "Ambient ${name} is not allowed for Terraform state recovery."
  fi
done
unset DEBUG NODE_DEBUG NODE_OPTIONS PWDEBUG

[[ -n "${RUNNER_TEMP:-}" && -d "${RUNNER_TEMP}" && ! -L "${RUNNER_TEMP}" ]] \
  || die "RUNNER_TEMP must be an existing non-symlink directory."
runner_temp="$(realpath -e -- "${RUNNER_TEMP}")"
[[ "${runner_temp}" != "/" ]] || die "RUNNER_TEMP cannot be the filesystem root."
[[ -n "${GITHUB_OUTPUT:-}" && -f "${GITHUB_OUTPUT}" && ! -L "${GITHUB_OUTPUT}" ]] \
  || die "GITHUB_OUTPUT must be an existing regular non-symlink file."

require_command aws
require_command awk
require_command cp
require_command date
require_command jq
require_command sed
require_command sha256sum
require_command stat
require_command terraform
require_terraform_version

recovery_root="$(mktemp -d "${runner_temp}/fukamu-cycle-terraform-state-recovery.XXXXXXXX")"
chmod 700 -- "${recovery_root}"
state_file="${recovery_root}/live.tfstate"
checksum_file="${recovery_root}/live.tfstate.sha256"
backup_readback="${recovery_root}/backup-readback.tfstate"
checksum_readback="${recovery_root}/backup-readback.tfstate.sha256"
drill_readback="${recovery_root}/drill-readback.tfstate"
aws_stdout="${recovery_root}/aws.stdout"
aws_stderr="${recovery_root}/aws.stderr"
terraform_log="${recovery_root}/terraform.log"
aws_config="${recovery_root}/aws-config"
aws_credentials="${recovery_root}/aws-credentials"
: >"${aws_config}"
: >"${aws_credentials}"

export AWS_CLI_AUTO_PROMPT=off
export AWS_CONFIG_FILE="${aws_config}"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true
export AWS_MAX_ATTEMPTS=3
export AWS_PAGER=""
export AWS_REGION=auto
export AWS_RETRY_MODE=standard
export AWS_SHARED_CREDENTIALS_FILE="${aws_credentials}"

r2_endpoint="https://${TF_VAR_cloudflare_account_id}.r2.cloudflarestorage.com"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
[[ "${timestamp}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
  || die "UTC backup timestamp generation failed."
backup_key="fukamu-cycle/staging/state-backups/${COMMIT_SHA}/${timestamp}.tfstate"
checksum_key="${backup_key}.sha256"
drill_key="fukamu-cycle/staging/state-restore-drills/${COMMIT_SHA}/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/terraform.tfstate"
drill_lock_key="${drill_key}.tflock"
drill_cleanup_required=false

aws_call() {
  local phase="$1"
  shift
  : >"${aws_stdout}"
  : >"${aws_stderr}"
  if ! aws \
    --no-cli-pager \
    --output json \
    --endpoint-url "${r2_endpoint}" \
    --cli-connect-timeout 10 \
    --cli-read-timeout 30 \
    "$@" >"${aws_stdout}" 2>"${aws_stderr}"; then
    printf 'Error: R2 state recovery operation failed at phase=%s.\n' "${phase}" >&2
    return 1
  fi
}

remove_recovery_root() {
  case "${recovery_root}" in
    "${runner_temp}"/fukamu-cycle-terraform-state-recovery.*)
      rm -rf -- "${recovery_root}"
      ;;
    *) return 1 ;;
  esac
}

cleanup_drill() {
  local failed=0
  if [[ "${drill_cleanup_required}" == "true" ]]; then
    aws_call drill-state-delete \
      s3api delete-object \
      --bucket "${R2_STATE_BUCKET}" \
      --key "${drill_key}" || failed=1
    aws_call drill-lock-delete \
      s3api delete-object \
      --bucket "${R2_STATE_BUCKET}" \
      --key "${drill_lock_key}" || failed=1
  fi
  return "${failed}"
}

cleanup_on_exit() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT
  set +e
  cleanup_drill || cleanup_failed=1
  remove_recovery_root || cleanup_failed=1
  if ((cleanup_failed != 0)); then
    printf '%s\n' "Error: Isolated Terraform restore-drill cleanup failed." >&2
  fi
  if ((status == 0 && cleanup_failed != 0)); then
    status=1
  fi
  exit "${status}"
}
trap cleanup_on_exit EXIT

if ! (
  cd -- "${terraform_root}"
  terraform state pull >"${state_file}" 2>"${terraform_log}"
); then
  die "Terraform live state snapshot failed before apply."
fi
[[ -f "${state_file}" && ! -L "${state_file}" && -s "${state_file}" ]] \
  || die "Terraform state pull did not produce a regular non-empty state file."
state_size="$(stat -c '%s' -- "${state_file}")"
if [[ ! "${state_size}" =~ ^[0-9]+$ ]] || ((state_size > maximum_state_bytes)); then
  die "Terraform state snapshot exceeded the approved size bound."
fi
if ! jq -e \
  'type == "object" and
   (.version | type) == "number" and
   (.version | floor) == .version and
   .version >= 1 and
   (.serial | type) == "number" and
   (.serial | floor) == .serial and
   .serial >= 0 and
   (.lineage | type) == "string" and
   (.lineage | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))' \
  "${state_file}" >/dev/null 2>&1; then
  die "Terraform state snapshot has an invalid state envelope."
fi

state_digest="$(sha256sum "${state_file}" | awk '{print $1}')"
[[ "${state_digest}" =~ ^[0-9a-f]{64}$ ]] \
  || die "Terraform state checksum generation failed."
printf '%s\n' "${state_digest}" >"${checksum_file}"
printf 'Terraform state snapshot target: %s\n' "${backup_key}"

aws_call backup-state-upload \
  s3api put-object \
  --bucket "${R2_STATE_BUCKET}" \
  --key "${backup_key}" \
  --body "${state_file}" \
  --if-none-match '*' \
  || die "Terraform state backup upload failed before apply."
aws_call backup-checksum-upload \
  s3api put-object \
  --bucket "${R2_STATE_BUCKET}" \
  --key "${checksum_key}" \
  --body "${checksum_file}" \
  --if-none-match '*' \
  || die "Terraform state checksum upload failed before apply."

aws_call backup-state-readback \
  s3api get-object \
  --bucket "${R2_STATE_BUCKET}" \
  --key "${backup_key}" \
  "${backup_readback}" \
  || die "Terraform state backup read-back failed before apply."
aws_call backup-checksum-readback \
  s3api get-object \
  --bucket "${R2_STATE_BUCKET}" \
  --key "${checksum_key}" \
  "${checksum_readback}" \
  || die "Terraform state checksum read-back failed before apply."

checksum_readback_size="$(stat -c '%s' -- "${checksum_readback}")"
[[ "${checksum_readback_size}" == "65" ]] \
  || die "Uploaded Terraform state checksum has an invalid byte length."
readback_digest=''
if ! IFS= read -r readback_digest <"${checksum_readback}"; then
  die "Uploaded Terraform state checksum could not be read exactly."
fi
[[ "${readback_digest}" =~ ^[0-9a-f]{64}$ ]] \
  || die "Uploaded Terraform state checksum has an invalid format."
[[ "${readback_digest}" == "${state_digest}" ]] \
  || die "Uploaded Terraform state checksum does not match the local snapshot."
actual_readback_digest="$(sha256sum "${backup_readback}" | awk '{print $1}')"
[[ "${actual_readback_digest}" == "${state_digest}" ]] \
  || die "Uploaded Terraform state bytes do not match the local snapshot."

drill_cleanup_required=true
aws_call drill-state-upload \
  s3api put-object \
  --bucket "${R2_STATE_BUCKET}" \
  --key "${drill_key}" \
  --body "${backup_readback}" \
  --if-none-match '*' \
  || die "Isolated Terraform restore-drill copy failed."
aws_call drill-state-readback \
  s3api get-object \
  --bucket "${R2_STATE_BUCKET}" \
  --key "${drill_key}" \
  "${drill_readback}" \
  || die "Isolated Terraform restore-drill read-back failed."
drill_readback_digest="$(sha256sum "${drill_readback}" | awk '{print $1}')"
[[ "${drill_readback_digest}" == "${state_digest}" ]] \
  || die "Isolated Terraform restore-drill copy checksum does not match."

drill_workspace="${recovery_root}/workspace"
mkdir -p -- "${drill_workspace}"
for source_name in .terraform.lock.hcl main.tf outputs.tf variables.tf versions.tf; do
  cp -- "${terraform_root}/${source_name}" "${drill_workspace}/${source_name}"
done
drill_backend="${recovery_root}/drill-backend.hcl"
cp -- "${terraform_root}/backend.hcl.example" "${drill_backend}"
[[ "$(grep -Fxc -- 'bucket = "<R2_STATE_BUCKET_NAME>"' "${drill_backend}")" == "1" ]] \
  || die "Terraform backend template bucket placeholder is not exact."
[[ "$(grep -Fxc -- 'key    = "fukamu-cycle/staging/terraform.tfstate"' "${drill_backend}")" == "1" ]] \
  || die "Terraform backend template live key is not exact."
[[ "$(grep -Fxc -- '  s3 = "https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com"' "${drill_backend}")" == "1" ]] \
  || die "Terraform backend template account placeholder is not exact."
sed -i \
  -e "s|<R2_STATE_BUCKET_NAME>|${R2_STATE_BUCKET}|g" \
  -e "s|<CLOUDFLARE_ACCOUNT_ID>|${TF_VAR_cloudflare_account_id}|g" \
  -e "s|^key    = \"${live_state_key}\"$|key    = \"${drill_key}\"|" \
  "${drill_backend}"
[[ "$(grep -Fxc -- "key    = \"${drill_key}\"" "${drill_backend}")" == "1" ]] \
  || die "Isolated Terraform restore-drill backend key was not prepared exactly."

if ! (
  cd -- "${drill_workspace}"
  terraform init \
    -input=false \
    -reconfigure \
    -backend-config="${drill_backend}" >"${terraform_log}" 2>&1
); then
  die "Isolated Terraform restore-drill initialization failed."
fi
isolated_state="${recovery_root}/isolated.tfstate"
if ! (
  cd -- "${drill_workspace}"
  terraform state pull >"${isolated_state}" 2>"${terraform_log}"
); then
  die "Isolated Terraform restore-drill state pull failed."
fi
isolated_digest="$(sha256sum "${isolated_state}" | awk '{print $1}')"
[[ "${isolated_digest}" == "${state_digest}" ]] \
  || die "Isolated Terraform restore-drill state checksum does not match."
if ! (
  cd -- "${drill_workspace}"
  terraform plan \
    -refresh=false \
    -lock=false \
    -input=false \
    -no-color \
    -out="${recovery_root}/restore-drill.tfplan" >"${terraform_log}" 2>&1
); then
  die "Isolated Terraform restore-drill no-refresh plan failed."
fi

if ! cleanup_drill; then
  die "Isolated Terraform restore-drill cleanup failed."
fi
drill_cleanup_required=false
if ! remove_recovery_root; then
  die "Terraform state recovery temporary-file cleanup failed."
fi
trap - EXIT

{
  printf 'state_backup_key=%s\n' "${backup_key}"
  printf 'state_backup_checksum_key=%s\n' "${checksum_key}"
} >>"${GITHUB_OUTPUT}"
printf '%s\n' "Terraform state backup and isolated restore drill passed."
