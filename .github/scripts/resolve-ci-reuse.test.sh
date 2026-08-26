#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "${test_dir}"' EXIT

main_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
tested_tree="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
head_sha="cccccccccccccccccccccccccccccccccccccccc"
tested_commit="dddddddddddddddddddddddddddddddddddddddd"
artifact_name="pr-ci-18-${head_sha}-${tested_tree}"
python_hook_marker="${test_dir}/python-startup-hook-ran"
cat >"${test_dir}/sitecustomize.py" <<'PYTHON_HOOK'
import os
from pathlib import Path

Path(os.environ["RESOLVER_PYTHON_HOOK_MARKER"]).write_text("executed", encoding="utf-8")
PYTHON_HOOK

make_archive() {
  local archive_path="$1"
  local mode="$2"
  python3 - \
    "$archive_path" \
    "$mode" \
    "$main_sha" \
    "$tested_tree" \
    "$head_sha" \
    "$tested_commit" <<'PY'
import stat
import sys
import warnings
import zipfile

archive_path, mode, main_sha, tested_tree, head_sha, tested_commit = sys.argv[1:]

if mode == "corrupt":
    with open(archive_path, "wb") as target:
        target.write(b"not-a-zip")
    raise SystemExit(0)

payload = (
    "pull_request=18\n"
    f"head_sha={head_sha}\n"
    f"tested_commit={tested_commit}\n"
    f"tested_tree={tested_tree}\n"
    "workflow_run=42\n"
)
if mode == "wrong_pr":
    payload = payload.replace("pull_request=18", "pull_request=19")
elif mode == "wrong_head":
    payload = payload.replace(head_sha, "e" * 40)
elif mode == "wrong_commit":
    payload = payload.replace(tested_commit, "not-a-40-character-lowercase-commit")
elif mode == "wrong_tree":
    payload = payload.replace(tested_tree, "e" * 40)
elif mode == "wrong_run":
    payload = payload.replace("workflow_run=42", "workflow_run=43")
elif mode == "extra_line":
    payload += "unexpected=true\n"
elif mode == "reordered":
    lines = payload.splitlines()
    payload = "\n".join([lines[1], lines[0], *lines[2:]]) + "\n"
elif mode == "crlf":
    payload = payload.replace("\n", "\r\n")
elif mode == "no_final_newline":
    payload = payload[:-1] if payload.endswith("\n") else payload
elif mode == "oversized_payload":
    payload = "x" * 4097

def regular_member(name, contents, compression=zipfile.ZIP_DEFLATED):
    member = zipfile.ZipInfo(name, date_time=(2026, 8, 20, 0, 0, 0))
    member.create_system = 3
    member.external_attr = (stat.S_IFREG | 0o600) << 16
    member.compress_type = compression
    archive.writestr(member, contents)

warnings.simplefilter("ignore", UserWarning)
with zipfile.ZipFile(archive_path, "w") as archive:
    if mode == "missing":
        regular_member("other.txt", payload)
    elif mode == "path":
        regular_member("../attestation.txt", payload)
    elif mode == "absolute_path":
        regular_member("/attestation.txt", payload)
    elif mode == "symlink":
        member = zipfile.ZipInfo("attestation.txt", date_time=(2026, 8, 20, 0, 0, 0))
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(member, "other.txt")
    elif mode == "extra":
        regular_member("attestation.txt", payload)
        regular_member("other.txt", "extra")
    elif mode == "duplicate":
        regular_member("attestation.txt", payload)
        regular_member("attestation.txt", payload)
    elif mode == "unsupported_compression":
        regular_member("attestation.txt", payload, zipfile.ZIP_BZIP2)
    elif mode == "crc_corrupt":
        regular_member("attestation.txt", payload, zipfile.ZIP_STORED)
    else:
        regular_member("attestation.txt", payload)

if mode == "oversized_archive":
    with open(archive_path, "ab") as target:
        target.write(b"x" * (20 * 1024))
elif mode == "crc_corrupt":
    with open(archive_path, "rb") as source:
        corrupted = bytearray(source.read())
    marker = payload.encode("utf-8")
    offset = corrupted.find(marker)
    if offset < 0:
        raise SystemExit("stored payload marker was not found")
    corrupted[offset] ^= 0x01
    with open(archive_path, "wb") as target:
        target.write(corrupted)
PY
}

cat >"${test_dir}/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

endpoint=""
for argument in "$@"; do
  if [[ "$argument" == /repos/* ]]; then
    endpoint="$argument"
  fi
done

fail_if_requested() {
  local category="$1"
  if [[ "${FAKE_API_FAILURE:-none}" == "$category" ]]; then
    echo "Injected fake gh failure: ${category}" >&2
    exit 70
  fi
}

case "$endpoint" in
  */git/commits/"${FIXTURE_MAIN_SHA}")
    fail_if_requested main
    case "${FAKE_SCHEMA_MODE:-none}" in
      main)
        printf '{"sha":"%s","tree":[]}\n' "$FIXTURE_MAIN_SHA"
        ;;
      main_missing_sha)
        printf '{"tree":{"sha":"%s"}}\n' "$FIXTURE_TESTED_TREE"
        ;;
      main_wrong_sha)
        printf '{"sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","tree":{"sha":"%s"}}\n' \
          "$FIXTURE_TESTED_TREE"
        ;;
      *)
        printf '{"sha":"%s","tree":{"sha":"%s"}}\n' \
          "$FIXTURE_MAIN_SHA" \
          "$FIXTURE_TESTED_TREE"
        ;;
    esac
    ;;
  */commits/"${FIXTURE_MAIN_SHA}"/pulls?*)
    fail_if_requested pulls
    if [[ "${FAKE_SCHEMA_MODE:-none}" == "pulls" ]]; then
      printf '%s\n' '{"not":"an array"}'
    else
      printf '[{"number":18,"state":"closed","merged_at":"2026-08-20T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"main"},"head":{"sha":"%s","ref":"feature"}}]\n' \
        "$FIXTURE_MAIN_SHA" \
        "$FIXTURE_HEAD_SHA"
    fi
    ;;
  */pulls/18/files?*)
    fail_if_requested files
    case "${FAKE_SCHEMA_MODE:-none}:${FAKE_FILES_MODE:-code}" in
      files:*)
        printf '%s\n' '{"not":"an array"}'
        ;;
      *:control)
        printf '[{"filename":"%s","status":"modified"}]\n' \
          "${FAKE_CONTROL_PATH:-.github/workflows/ci.yml}"
        ;;
      *:renamed_control)
        printf '[{"filename":"backend/internal/domain/example.go","previous_filename":"%s","status":"renamed"}]\n' \
          "${FAKE_CONTROL_PATH:-.github/workflows/old.yml}"
        ;;
      *:count_mismatch)
        printf '%s\n' '[{"filename":"backend/internal/domain/example.go","status":"modified"}]'
        ;;
      *:duplicate_filename)
        printf '%s\n' '[{"filename":"backend/internal/domain/example.go","status":"modified"},{"filename":"backend/internal/domain/example.go","status":"modified"}]'
        ;;
      *:duplicate_current_previous)
        printf '%s\n' '[{"filename":"backend/internal/domain/renamed.go","previous_filename":"backend/internal/domain/example.go","status":"renamed"},{"filename":"backend/internal/domain/example.go","status":"modified"}]'
        ;;
      *:unexpected_previous)
        printf '%s\n' '[{"filename":"backend/internal/domain/example.go","previous_filename":"backend/internal/domain/old.go","status":"modified"}]'
        ;;
      *:renamed_without_previous)
        printf '%s\n' '[{"filename":"backend/internal/domain/example.go","status":"renamed"}]'
        ;;
      *)
        printf '%s\n' '[{"filename":"backend/internal/domain/example.go","status":"modified"}]'
        ;;
    esac
    ;;
  */pulls/18)
    fail_if_requested pull_detail
    if [[ "${FAKE_SCHEMA_MODE:-none}" == "pull_detail" ]]; then
      printf '%s\n' '{"number":"18"}'
    else
      changed_files=1
      case "${FAKE_FILES_MODE:-code}" in
        over_100)
          changed_files=101
          ;;
        count_mismatch)
          changed_files=2
          ;;
        duplicate_filename | duplicate_current_previous)
          changed_files=2
          ;;
      esac
      printf '{"number":18,"state":"closed","merged_at":"2026-08-20T00:00:00Z","merge_commit_sha":"%s","changed_files":%s,"base":{"ref":"main"},"head":{"sha":"%s","ref":"feature"}}\n' \
        "$FIXTURE_MAIN_SHA" \
        "$changed_files" \
        "$FIXTURE_HEAD_SHA"
    fi
    ;;
  */actions/workflows/ci.yml/runs)
    fail_if_requested runs
    if [[ "${FAKE_SCHEMA_MODE:-none}" == "runs" ]]; then
      printf '%s\n' '{"total_count":2,"workflow_runs":[]}'
    else
      case "${FAKE_RUNS_MODE:-valid}" in
        boolean_pull)
          pull_number=true
          run_path=".github/workflows/ci.yml"
          ;;
        wrong_pull)
          pull_number=19
          run_path=".github/workflows/ci.yml"
          ;;
        wrong_path)
          pull_number=18
          run_path=".github/workflows/other.yml"
          ;;
        *)
          pull_number=18
          run_path=".github/workflows/ci.yml"
          ;;
      esac
      printf '{"total_count":1,"workflow_runs":[{"id":42,"name":"CI","event":"pull_request","status":"completed","conclusion":"success","head_sha":"%s","head_branch":"feature","path":"%s","pull_requests":[{"number":%s}]}]}\n' \
        "$FIXTURE_HEAD_SHA" \
        "$run_path" \
        "$pull_number"
    fi
    ;;
  */actions/runs/42/jobs?*)
    fail_if_requested jobs
    case "${FAKE_SCHEMA_MODE:-none}:${FAKE_JOBS_MODE:-valid}" in
      jobs:*)
        printf '%s\n' '{"total_count":8,"jobs":[]}'
        ;;
      *:missing_attest)
        printf '%s\n' '{"total_count":7,"jobs":[{"name":"Reuse verified PR CI","status":"completed","conclusion":"skipped"},{"name":"workflow","status":"completed","conclusion":"success"},{"name":"Security, configuration, and documentation","status":"completed","conclusion":"success"},{"name":"frontend","status":"completed","conclusion":"success"},{"name":"backend","status":"completed","conclusion":"success"},{"name":"infrastructure","status":"completed","conclusion":"success"},{"name":"e2e","status":"completed","conclusion":"success"}]}'
        ;;
      *:reuse_succeeded)
        printf '%s\n' '{"total_count":8,"jobs":[{"name":"Reuse verified PR CI","status":"completed","conclusion":"success"},{"name":"workflow","status":"completed","conclusion":"success"},{"name":"Security, configuration, and documentation","status":"completed","conclusion":"success"},{"name":"frontend","status":"completed","conclusion":"success"},{"name":"backend","status":"completed","conclusion":"success"},{"name":"infrastructure","status":"completed","conclusion":"success"},{"name":"e2e","status":"completed","conclusion":"success"},{"name":"Attest tested PR tree","status":"completed","conclusion":"success"}]}'
        ;;
      *:attest_failed)
        printf '%s\n' '{"total_count":8,"jobs":[{"name":"Reuse verified PR CI","status":"completed","conclusion":"skipped"},{"name":"workflow","status":"completed","conclusion":"success"},{"name":"Security, configuration, and documentation","status":"completed","conclusion":"success"},{"name":"frontend","status":"completed","conclusion":"success"},{"name":"backend","status":"completed","conclusion":"success"},{"name":"infrastructure","status":"completed","conclusion":"success"},{"name":"e2e","status":"completed","conclusion":"success"},{"name":"Attest tested PR tree","status":"completed","conclusion":"failure"}]}'
        ;;
      *)
        printf '%s\n' '{"total_count":8,"jobs":[{"name":"Reuse verified PR CI","status":"completed","conclusion":"skipped"},{"name":"workflow","status":"completed","conclusion":"success"},{"name":"Security, configuration, and documentation","status":"completed","conclusion":"success"},{"name":"frontend","status":"completed","conclusion":"success"},{"name":"backend","status":"completed","conclusion":"success"},{"name":"infrastructure","status":"completed","conclusion":"success"},{"name":"e2e","status":"completed","conclusion":"success"},{"name":"Attest tested PR tree","status":"completed","conclusion":"success"}]}'
        ;;
    esac
    ;;
  */actions/runs/42/artifacts?*)
    fail_if_requested artifacts
    case "${FAKE_SCHEMA_MODE:-none}:${FAKE_ARTIFACT_MODE:-valid}" in
      artifacts:*)
        printf '%s\n' '{"total_count":2,"artifacts":[]}'
        ;;
      *:missing)
        printf '%s\n' '{"total_count":1,"artifacts":[{"id":9002,"name":"unrelated","expired":false,"workflow_run":{"id":42}}]}'
        ;;
      *:expired)
        printf '{"total_count":1,"artifacts":[{"id":9001,"name":"%s","expired":true,"workflow_run":{"id":42}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:duplicate)
        printf '{"total_count":2,"artifacts":[{"id":9001,"name":"%s","expired":false,"workflow_run":{"id":42}},{"id":9002,"name":"%s","expired":false,"workflow_run":{"id":42}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME" \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:duplicate_id)
        printf '{"total_count":2,"artifacts":[{"id":9001,"name":"unrelated","expired":false,"workflow_run":{"id":42}},{"id":9001,"name":"%s","expired":false,"workflow_run":{"id":42}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:with_unrelated)
        printf '{"total_count":2,"artifacts":[{"id":9002,"name":"unrelated","expired":false,"workflow_run":{"id":42}},{"id":9001,"name":"%s","expired":false,"workflow_run":{"id":42}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:missing_workflow_run)
        printf '{"total_count":1,"artifacts":[{"id":9001,"name":"%s","expired":false}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:missing_workflow_run_id)
        printf '{"total_count":1,"artifacts":[{"id":9001,"name":"%s","expired":false,"workflow_run":{}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:wrong_workflow_run_id)
        printf '{"total_count":1,"artifacts":[{"id":9001,"name":"%s","expired":false,"workflow_run":{"id":43}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:boolean_workflow_run_id)
        printf '{"total_count":1,"artifacts":[{"id":9001,"name":"%s","expired":false,"workflow_run":{"id":true}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *:string_workflow_run_id)
        printf '{"total_count":1,"artifacts":[{"id":9001,"name":"%s","expired":false,"workflow_run":{"id":"42"}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
      *)
        printf '{"total_count":1,"artifacts":[{"id":9001,"name":"%s","expired":false,"workflow_run":{"id":42}}]}\n' \
          "$FIXTURE_ARTIFACT_NAME"
        ;;
    esac
    ;;
  */actions/artifacts/9001/zip)
    fail_if_requested download
    command cat -- "$FAKE_ARCHIVE_PATH"
    ;;
  *)
    echo "Unexpected fake gh endpoint: ${endpoint}" >&2
    exit 64
    ;;
esac
FAKE_GH
chmod +x "${test_dir}/gh"

last_output=""
last_log=""

run_case() {
  local case_name="$1"
  local archive_mode="${2:-valid}"
  local files_mode="${3:-code}"
  local jobs_mode="${4:-valid}"
  local artifact_mode="${5:-valid}"
  local schema_mode="${6:-none}"
  local api_failure="${7:-none}"
  local event_name="${8:-push}"
  local runs_mode="${9:-valid}"
  local control_path="${10:-}"

  local archive_path="${test_dir}/${case_name}.zip"
  last_output="${test_dir}/${case_name}.output"
  last_log="${test_dir}/${case_name}.log"
  make_archive "$archive_path" "$archive_mode"
  : >"$last_output"

  if ! GITHUB_EVENT_NAME="$event_name" \
    FIXTURE_MAIN_SHA="$main_sha" \
    FIXTURE_TESTED_TREE="$tested_tree" \
    FIXTURE_HEAD_SHA="$head_sha" \
    FIXTURE_ARTIFACT_NAME="$artifact_name" \
    FAKE_ARCHIVE_PATH="$archive_path" \
    FAKE_FILES_MODE="$files_mode" \
    FAKE_JOBS_MODE="$jobs_mode" \
    FAKE_ARTIFACT_MODE="$artifact_mode" \
    FAKE_SCHEMA_MODE="$schema_mode" \
    FAKE_API_FAILURE="$api_failure" \
    FAKE_RUNS_MODE="$runs_mode" \
    FAKE_CONTROL_PATH="$control_path" \
    PYTHONPATH="${test_dir}" \
    RESOLVER_PYTHON_HOOK_MARKER="${python_hook_marker}" \
    PATH="${test_dir}:${PATH}" \
    bash "${script_dir}/resolve-ci-reuse.sh" \
    "$main_sha" \
    "owner/repository" \
    "$last_output" >"$last_log" 2>&1; then
    echo "Resolver crashed in case ${case_name}" >&2
    sed -n '1,200p' "$last_log" >&2
    exit 1
  fi
}

assert_common_output_shape() {
  local output_file="$1"
  if [[ "$(wc -l <"$output_file")" -ne 4 ]]; then
    echo "Unexpected resolver output shape: ${output_file}" >&2
    sed -n '1,20p' "$output_file" >&2
    exit 1
  fi
}

assert_reuse() {
  local case_name="$1"
  shift
  run_case "$case_name" "$@"
  assert_common_output_shape "$last_output"
  grep -qx 'reuse_pr_ci=true' "$last_output"
  grep -qx 'source_pr_number=18' "$last_output"
  grep -qx 'source_run_id=42' "$last_output"
  grep -qx "tested_tree=${tested_tree}" "$last_output"
}

assert_fallback() {
  local case_name="$1"
  shift
  run_case "$case_name" "$@"
  assert_common_output_shape "$last_output"
  grep -qx 'reuse_pr_ci=false' "$last_output"
  grep -qx 'source_pr_number=' "$last_output"
  grep -qx 'source_run_id=' "$last_output"
  grep -qx 'tested_tree=' "$last_output"
}

# A normal application-code PR with one exact artifact and attestation is reusable.
assert_reuse valid

# Artifact discovery and download are fail-closed.
assert_fallback artifact_with_unrelated valid code valid with_unrelated
assert_fallback missing_artifact valid code valid missing
assert_fallback expired_artifact valid code valid expired
assert_fallback duplicate_matching_artifact valid code valid duplicate
assert_fallback duplicate_artifact_id valid code valid duplicate_id
assert_fallback artifact_missing_workflow_run valid code valid missing_workflow_run
assert_fallback artifact_missing_workflow_run_id valid code valid missing_workflow_run_id
assert_fallback artifact_wrong_workflow_run_id valid code valid wrong_workflow_run_id
assert_fallback artifact_boolean_workflow_run_id valid code valid boolean_workflow_run_id
assert_fallback artifact_string_workflow_run_id valid code valid string_workflow_run_id
assert_fallback corrupt_download corrupt
assert_fallback missing_attestation_member missing
assert_fallback extra_archive_member extra
assert_fallback traversal_archive_member path
assert_fallback absolute_archive_member absolute_path
assert_fallback symlink_archive_member symlink
assert_fallback duplicate_archive_member duplicate
assert_fallback oversized_archive oversized_archive
assert_fallback oversized_payload oversized_payload
assert_fallback unsupported_archive_compression unsupported_compression
assert_fallback archive_crc_corruption crc_corrupt

# The payload is exactly five LF-terminated lines. Every bound identity is exact.
for payload_mode in \
  wrong_pr \
  wrong_head \
  wrong_commit \
  wrong_tree \
  wrong_run \
  extra_line \
  reordered \
  crlf \
  no_final_newline; do
  assert_fallback "payload_${payload_mode}" "$payload_mode"
done

# The selected run must contain exactly the canonical completed PR job set.
assert_fallback jobs_missing_attest valid code missing_attest
assert_fallback jobs_attest_failed valid code attest_failed
assert_fallback jobs_reuse_not_skipped valid code reuse_succeeded
assert_fallback run_wrong_pull valid code valid valid none none push wrong_pull
assert_fallback run_boolean_pull_number valid code valid valid none none push boolean_pull
assert_fallback run_wrong_workflow valid code valid valid none none push wrong_path

# API transport failures and malformed/paginated response shapes all fall back.
for failure in main pulls pull_detail files runs jobs artifacts download; do
  assert_fallback "api_failure_${failure}" valid code valid valid none "$failure"
done
for schema in main pulls pull_detail files runs jobs artifacts; do
  assert_fallback "schema_${schema}" valid code valid valid "$schema"
done
assert_fallback schema_main_missing_sha valid code valid valid main_missing_sha
assert_fallback schema_main_wrong_sha valid code valid valid main_wrong_sha
assert_fallback changed_files_over_100 valid over_100
assert_fallback changed_files_count_mismatch valid count_mismatch
assert_fallback changed_files_duplicate_filename valid duplicate_filename
assert_fallback changed_files_duplicate_current_previous valid duplicate_current_previous
assert_fallback changed_files_unexpected_previous valid unexpected_previous
assert_fallback changed_files_renamed_without_previous valid renamed_without_previous

# A PR that changes its own verifier, dependencies, or test/build policy is never reused.
for control_path in \
  .github/workflows/ci.yml \
  cloudflare/src/config/deployment-contract.test.mjs \
  .gitattributes \
  scripts/check-security.sh \
  package.json \
  sitecustomize.py \
  usercustomize.py \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  frontend/package.json \
  frontend/eslint.config.js \
  frontend/vite.config.mts \
  frontend/vitest.workspace.ts \
  frontend/prettier.config.cts \
  frontend/.prettierrc.json \
  frontend/.prettierignore \
  frontend/.eslintrc.cjs \
  .shellcheckrc \
  .pnpmfile.cjs \
  .pnpmfile.js \
  frontend/vite.config.ts \
  frontend/playwright.config.ts \
  backend/go.mod \
  infra/terraform/staging/.terraform.lock.hcl \
  .gitleaksignore \
  .gitignore \
  config/deployment-contract.json \
  config/future-gate-policy.json; do
  safe_case="$(printf '%s' "$control_path" | tr '/.' '__')"
  assert_fallback "control_${safe_case}" valid control valid valid none none push valid "$control_path"
done
assert_fallback renamed_control_path valid renamed_control
assert_fallback renamed_config_policy_previous valid renamed_control valid valid none none push valid cloudflare/src/config/deployment-contract.test.mjs

# Non-push events never consult or reuse a PR artifact.
assert_fallback pull_request_event valid code valid valid none none pull_request

[[ ! -e "${python_hook_marker}" ]] || {
  echo "Resolver executed candidate Python startup customization" >&2
  exit 1
}

echo 'CI reuse resolver tests passed.'
