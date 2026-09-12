#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

target_sha="${1:-}"
repository="${GITHUB_REPOSITORY:-}"

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

[[ "$#" -eq 1 && "${target_sha}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "Security audit release gate requires one exact lowercase commit SHA."
[[ "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "Security audit release gate requires a valid GITHUB_REPOSITORY."
[[ -n "${GH_TOKEN:-}" ]] \
  || fail "Security audit release gate requires GitHub Actions read access."
for required_command in gh jq; do
  command -v "${required_command}" >/dev/null 2>&1 \
    || fail "Security audit release gate command is unavailable: ${required_command}."
done

validation_root="$(mktemp -d)" \
  || fail "Could not create a private security audit validation directory."
chmod 700 "${validation_root}"
trap 'rm -rf -- "${validation_root}"' EXIT

workflow_runs_api="/repos/${repository}/actions/workflows/security-audit.yml/runs"
main_ref_file="${validation_root}/main-ref.json"
completed_runs_file="${validation_root}/completed-runs.json"

if ! gh api \
  --method GET \
  -H 'Accept: application/vnd.github+json' \
  "/repos/${repository}/git/ref/heads/main" \
  >"${main_ref_file}" 2>/dev/null; then
  fail "Could not resolve the current main commit."
fi

current_main_sha="$({
  jq -ser \
    '
      if (
        length == 1 and
        (.[0] | type) == "object" and
        .[0].ref == "refs/heads/main" and
        (.[0].object | type) == "object" and
        .[0].object.type == "commit" and
        (.[0].object.sha | type) == "string" and
        (.[0].object.sha | test("^[0-9a-f]{40}$"))
      ) then
        .[0].object.sha
      else
        error("invalid current main response")
      end
    ' \
    "${main_ref_file}" 2>/dev/null
} || true)"

[[ "${current_main_sha}" == "${target_sha}" ]] \
  || fail "Security audit release gate target is not the current main commit."

if ! gh api \
  --paginate \
  --method GET \
  -H 'Accept: application/vnd.github+json' \
  "${workflow_runs_api}" \
  -f branch=main \
  -f status=completed \
  -f per_page=100 \
  >"${completed_runs_file}" 2>/dev/null; then
  fail "Could not resolve completed security audit history."
fi

audit_gate_state="$({
  jq -ser \
    --arg repository "${repository}" \
    '
      def valid_run:
        (type == "object") and
        (.id | type) == "number" and (.id | floor) == .id and .id > 0 and
        (.run_number | type) == "number" and
          (.run_number | floor) == .run_number and .run_number > 0 and
        (.run_attempt | type) == "number" and
          (.run_attempt | floor) == .run_attempt and .run_attempt > 0 and
        .name == "Security audit" and
        .path == ".github/workflows/security-audit.yml" and
        (.event == "schedule" or .event == "workflow_dispatch") and
        .status == "completed" and
        (.conclusion == "success" or
         .conclusion == "failure" or
         .conclusion == "cancelled" or
         .conclusion == "timed_out" or
         .conclusion == "action_required" or
         .conclusion == "startup_failure" or
         .conclusion == "stale" or
         .conclusion == "neutral" or
         .conclusion == "skipped") and
        (.head_sha | type) == "string" and
          (.head_sha | test("^[0-9a-f]{40}$")) and
        .head_branch == "main" and
        (.head_repository | type) == "object" and
        .head_repository.full_name == $repository;
      if length > 0 then
        . as $pages
        | if all($pages[];
            (type == "object") and
            (.total_count | type) == "number" and
            (.total_count | floor) == .total_count and
            .total_count >= 0 and
            (.workflow_runs | type) == "array"
          ) then . else error("invalid security audit page") end
        | ($pages[0].total_count) as $total
        | if all($pages[]; .total_count == $total) then .
          else error("inconsistent security audit totals") end
        | [$pages[].workflow_runs[]] as $runs
        | if (
            ($runs | length) == $total and
            all($runs[]; valid_run) and
            ([$runs[].id] | unique | length) == ($runs | length) and
            ([$runs[].run_number] | unique | length) == ($runs | length)
          ) then . else error("invalid security audit history") end
        | [$runs[] | select(.event == "schedule" and .conclusion != "success") | .run_number]
          as $blocking
        | if ($blocking | length) == 0 then "clear"
          else ($blocking | max) as $boundary
          | [$runs[] |
              select(
                .conclusion == "success" and
                .run_attempt == 1 and
                .run_number > $boundary
              )]
            | if length > 0 then "clear" else "blocked" end
          end
      else
        error("invalid paginated security audit response")
      end
    ' \
    "${completed_runs_file}" 2>/dev/null
} || true)"

[[ "${audit_gate_state}" == "clear" || "${audit_gate_state}" == "blocked" ]] \
  || fail "Security audit history was invalid or ambiguous."
[[ "${audit_gate_state}" == "clear" ]] \
  || fail "A fresh successful full security audit is required after the latest non-successful scheduled audit."
