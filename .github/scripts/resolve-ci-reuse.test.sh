#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "${test_dir}"' EXIT

main_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
tested_tree="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
head_sha="cccccccccccccccccccccccccccccccccccccccc"
artifact_name="pr-ci-18-${head_sha}-${tested_tree}"

cat >"${test_dir}/gh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
endpoint=""
for argument in "\$@"; do
  if [[ "\${argument}" == /repos/* ]]; then
    endpoint="\${argument}"
  fi
done
case "\${endpoint}" in
  */git/commits/${main_sha})
    printf '%s\n' '{"tree":{"sha":"${tested_tree}"}}'
    ;;
  */commits/${main_sha}/pulls*)
    printf '%s\n' '[{"number":18,"state":"closed","merged_at":"2026-08-20T00:00:00Z","merge_commit_sha":"${main_sha}","base":{"ref":"main"},"head":{"sha":"${head_sha}","ref":"feature"}}]'
    ;;
  */actions/workflows/ci.yml/runs)
    printf '%s\n' '{"workflow_runs":[{"id":42,"event":"pull_request","conclusion":"success","head_sha":"${head_sha}","head_branch":"feature","path":".github/workflows/ci.yml"}]}'
    ;;
  */actions/runs/42/artifacts*)
    if [[ "\${FAKE_MATCHING_ARTIFACT:-false}" == "true" ]]; then
      printf '%s\n' '{"artifacts":[{"name":"${artifact_name}","expired":false}]}'
    else
      printf '%s\n' '{"artifacts":[{"name":"pr-ci-18-${head_sha}-dddddddddddddddddddddddddddddddddddddddd","expired":false}]}'
    fi
    ;;
  *)
    echo "Unexpected fake gh endpoint: \${endpoint}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${test_dir}/gh"

run_resolver() {
  local event_name="$1"
  local matching_artifact="$2"
  local output_file="$3"
  GITHUB_EVENT_NAME="${event_name}" \
    FAKE_MATCHING_ARTIFACT="${matching_artifact}" \
    PATH="${test_dir}:${PATH}" \
    bash "${script_dir}/resolve-ci-reuse.sh" \
    "${main_sha}" \
    "owner/repository" \
    "${output_file}"
}

matching_output="${test_dir}/matching-output"
run_resolver push true "${matching_output}"
grep -qx 'reuse_pr_ci=true' "${matching_output}"
grep -qx 'source_pr_number=18' "${matching_output}"
grep -qx 'source_run_id=42' "${matching_output}"
grep -qx "tested_tree=${tested_tree}" "${matching_output}"

mismatch_output="${test_dir}/mismatch-output"
run_resolver push false "${mismatch_output}"
grep -qx 'reuse_pr_ci=false' "${mismatch_output}"

pull_request_output="${test_dir}/pull-request-output"
run_resolver pull_request false "${pull_request_output}"
grep -qx 'reuse_pr_ci=false' "${pull_request_output}"

echo 'CI reuse resolver tests passed.'
