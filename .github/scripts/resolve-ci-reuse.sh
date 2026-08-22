#!/usr/bin/env bash

set -Eeuo pipefail

main_sha="${1:?main commit SHA is required}"
repository="${2:?repository is required}"
output_file="${3:?GitHub output file is required}"

write_output() {
  printf '%s=%s\n' "$1" "$2" >>"${output_file}"
}

fallback() {
  write_output reuse_pr_ci false
  write_output source_pr_number ""
  write_output source_run_id ""
  write_output tested_tree ""
  echo "::notice::$1 Running the full CI suite."
  exit 0
}

if [[ "${GITHUB_EVENT_NAME:-}" != "push" ]]; then
  fallback "PR CI reuse applies only to pushes to main."
fi

if ! main_commit_json="$(
  gh api \
    -H 'Accept: application/vnd.github+json' \
    "/repos/${repository}/git/commits/${main_sha}"
)"; then
  fallback "Could not read the main commit."
fi

if ! main_tree="$(jq -er '.tree.sha' <<<"${main_commit_json}" | tr -d '\r')"; then
  fallback "Could not resolve the main commit tree."
fi

if ! pulls_json="$(
  gh api \
    -H 'Accept: application/vnd.github+json' \
    "/repos/${repository}/commits/${main_sha}/pulls?per_page=100"
)"; then
  fallback "Could not find the pull request associated with the main commit."
fi

if ! matching_prs="$(
  jq -er \
    --arg main_sha "${main_sha}" \
    '[.[]
      | select(
          .state == "closed" and
          .merged_at != null and
          .base.ref == "main" and
          .merge_commit_sha == $main_sha
        )
      | {
          number,
          head_sha: .head.sha,
          head_branch: .head.ref
        }
    ]' <<<"${pulls_json}"
)"; then
  fallback "Could not validate the pull request associated with the main commit."
fi

if ! matching_pr_count="$(jq -er 'length' <<<"${matching_prs}")"; then
  fallback "Could not count pull requests associated with the main commit."
fi
if [[ ! "${matching_pr_count}" =~ ^[0-9]+$ ]] || ((matching_pr_count != 1)); then
  fallback "The main commit is not associated with exactly one merged pull request."
fi

if ! pr_number="$(jq -er '.[0].number' <<<"${matching_prs}" | tr -d '\r')" \
  || ! head_sha="$(jq -er '.[0].head_sha' <<<"${matching_prs}" | tr -d '\r')" \
  || ! head_branch="$(jq -er '.[0].head_branch' <<<"${matching_prs}" | tr -d '\r')"; then
  fallback "Could not resolve the merged pull request metadata."
fi
artifact_name="pr-ci-${pr_number}-${head_sha}-${main_tree}"

if ! runs_json="$(
  gh api \
    --method GET \
    -H 'Accept: application/vnd.github+json' \
    "/repos/${repository}/actions/workflows/ci.yml/runs" \
    -f event=pull_request \
    -f status=success \
    -f head_sha="${head_sha}" \
    -f per_page=100
)"; then
  fallback "Could not list successful CI runs for pull request #${pr_number}."
fi

mapfile -t run_ids < <(
  jq -r \
    --arg head_sha "${head_sha}" \
    --arg head_branch "${head_branch}" \
    '.workflow_runs[]
      | select(
          .event == "pull_request" and
          .conclusion == "success" and
          .head_sha == $head_sha and
          .head_branch == $head_branch and
          (.path | startswith(".github/workflows/ci.yml"))
        )
      | .id' <<<"${runs_json}" \
    | tr -d '\r'
)

for run_id in "${run_ids[@]}"; do
  if ! artifacts_json="$(
    gh api \
      -H 'Accept: application/vnd.github+json' \
      "/repos/${repository}/actions/runs/${run_id}/artifacts?per_page=100"
  )"; then
    continue
  fi

  if jq -e \
    --arg artifact_name "${artifact_name}" \
    '.artifacts[] | select(.name == $artifact_name and .expired == false)' \
    <<<"${artifacts_json}" >/dev/null; then
    write_output reuse_pr_ci true
    write_output source_pr_number "${pr_number}"
    write_output source_run_id "${run_id}"
    write_output tested_tree "${main_tree}"
    echo "::notice::Reusing successful PR #${pr_number} CI run ${run_id}; tested tree ${main_tree} exactly matches main."
    exit 0
  fi
done

fallback "No unexpired successful PR CI attestation exactly matches main tree ${main_tree}."
