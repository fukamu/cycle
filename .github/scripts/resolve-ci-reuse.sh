#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

main_sha="${1:?main commit SHA is required}"
repository="${2:?repository is required}"
output_file="${3:-${GITHUB_OUTPUT:-}}"

if [[ -z "$output_file" ]]; then
  echo "GITHUB_OUTPUT or an explicit output file is required" >&2
  exit 1
fi

write_output() {
  printf '%s=%s\n' "$1" "$2" >>"$output_file"
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
  fallback "CI reuse only applies to push events"
fi

if [[ ! "$main_sha" =~ ^[0-9a-f]{40}$ ]]; then
  fallback "Main commit SHA is not a canonical 40-character lowercase SHA"
fi

if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  fallback "Repository name is not canonical"
fi

for required_command in gh python3; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    fallback "Required CI reuse validator command is unavailable: ${required_command}"
  fi
done

validation_root="$(mktemp -d)" || fallback "Could not create a private CI reuse validation directory"
chmod 700 "$validation_root"
# shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap below.
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf -- "$validation_root"
  exit "$status"
}
trap cleanup EXIT

main_commit_json="${validation_root}/main-commit.json"
if ! gh api "/repos/${repository}/git/commits/${main_sha}" >"$main_commit_json"; then
  fallback "Could not resolve the main commit tree"
fi

main_tree="$(
  python3 -I - "$main_commit_json" "$main_sha" <<'PY'
import json
import sys

path, expected_sha = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as source:
        commit = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(2)

if not isinstance(commit, dict) or commit.get("sha") != expected_sha:
    raise SystemExit(2)
tree = commit.get("tree") if isinstance(commit, dict) else None
if not isinstance(tree, dict) or not isinstance(tree.get("sha"), str):
    raise SystemExit(2)
print(tree["sha"])
PY
)" || fallback "The main commit response was ambiguous"

if [[ ! "$main_tree" =~ ^[0-9a-f]{40}$ ]]; then
  fallback "Main commit tree is not a canonical 40-character lowercase SHA"
fi

pulls_json="${validation_root}/pulls.json"
if ! gh api \
  -H "Accept: application/vnd.github+json" \
  "/repos/${repository}/commits/${main_sha}/pulls?per_page=100" >"$pulls_json"; then
  fallback "Could not query pull requests for the main commit"
fi

pr_metadata="$(
  python3 -I - "$pulls_json" "$main_sha" <<'PY'
import json
import re
import sys

path, main_sha = sys.argv[1:]

try:
    with open(path, encoding="utf-8") as source:
        pulls = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(2)

if not isinstance(pulls, list) or len(pulls) >= 100:
    raise SystemExit(2)

matching = []
for pull in pulls:
    if not isinstance(pull, dict):
        raise SystemExit(2)
    base = pull.get("base")
    head = pull.get("head")
    required_types = (
        isinstance(pull.get("number"), int)
        and not isinstance(pull.get("number"), bool)
        and isinstance(pull.get("state"), str)
        and (pull.get("merged_at") is None or isinstance(pull.get("merged_at"), str))
        and isinstance(pull.get("merge_commit_sha"), str)
        and isinstance(base, dict)
        and isinstance(base.get("ref"), str)
        and isinstance(head, dict)
        and isinstance(head.get("sha"), str)
        and isinstance(head.get("ref"), str)
    )
    if not required_types:
        raise SystemExit(2)
    if (
        pull["state"] == "closed"
        and pull["merged_at"] is not None
        and pull["base"]["ref"] == "main"
        and pull["merge_commit_sha"] == main_sha
    ):
        matching.append(pull)

if len(matching) != 1:
    raise SystemExit(3)

pull = matching[0]
number = pull["number"]
head_sha = pull["head"]["sha"]
head_branch = pull["head"]["ref"]
if (
    number <= 0
    or not re.fullmatch(r"[0-9a-f]{40}", head_sha)
    or not head_branch
    or any(ord(character) < 0x20 or ord(character) == 0x7F for character in head_branch)
):
    raise SystemExit(2)

print(number)
print(head_sha)
print(head_branch)
PY
)" || fallback "The main commit did not resolve to exactly one unambiguous merged PR"

mapfile -t pr_fields <<<"$pr_metadata"
if [[ "${#pr_fields[@]}" -ne 3 ]]; then
  fallback "The merged PR metadata was ambiguous"
fi

pr_number="${pr_fields[0]}"
head_sha="${pr_fields[1]}"
head_branch="${pr_fields[2]}"

pull_detail_json="${validation_root}/pull-detail.json"
if ! gh api \
  -H "Accept: application/vnd.github+json" \
  "/repos/${repository}/pulls/${pr_number}" >"$pull_detail_json"; then
  fallback "Could not query the merged PR details"
fi

changed_files="$(
  python3 -I - \
    "$pull_detail_json" \
    "$main_sha" \
    "$pr_number" \
    "$head_sha" \
    "$head_branch" <<'PY'
import json
import sys

path, main_sha, pr_number_text, head_sha, head_branch = sys.argv[1:]
try:
    pr_number = int(pr_number_text)
    with open(path, encoding="utf-8") as source:
        pull = json.load(source)
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(2)

base = pull.get("base") if isinstance(pull, dict) else None
head = pull.get("head") if isinstance(pull, dict) else None
changed_files = pull.get("changed_files") if isinstance(pull, dict) else None
if (
    not isinstance(pull, dict)
    or pull.get("number") != pr_number
    or pull.get("state") != "closed"
    or not isinstance(pull.get("merged_at"), str)
    or pull.get("merge_commit_sha") != main_sha
    or not isinstance(base, dict)
    or base.get("ref") != "main"
    or not isinstance(head, dict)
    or head.get("sha") != head_sha
    or head.get("ref") != head_branch
    or not isinstance(changed_files, int)
    or isinstance(changed_files, bool)
    or changed_files < 0
):
    raise SystemExit(2)

print(changed_files)
PY
)" || fallback "The merged PR detail response was incomplete or ambiguous"

if [[ ! "$changed_files" =~ ^[0-9]+$ ]]; then
  fallback "The merged PR changed-file count was ambiguous"
fi
if ((changed_files > 100)); then
  fallback "The merged PR has more changed files than can be validated without pagination ambiguity"
fi

pull_files_json="${validation_root}/pull-files.json"
if ! gh api \
  -H "Accept: application/vnd.github+json" \
  "/repos/${repository}/pulls/${pr_number}/files?per_page=100" >"$pull_files_json"; then
  fallback "Could not query every changed file in the merged PR"
fi

files_status=0
python3 -I - "$pull_files_json" "$changed_files" <<'PY' || files_status=$?
import json
import re
import sys

path, expected_count_text = sys.argv[1:]
try:
    expected_count = int(expected_count_text)
    with open(path, encoding="utf-8") as source:
        files = json.load(source)
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(2)

if (
    not isinstance(files, list)
    or expected_count < 0
    or expected_count > 100
    or len(files) != expected_count
):
    raise SystemExit(2)

allowed_statuses = {"added", "removed", "modified", "renamed"}
paths = []
current_paths = set()
all_paths = set()
for item in files:
    if not isinstance(item, dict):
        raise SystemExit(2)
    filename = item.get("filename")
    status = item.get("status")
    if not isinstance(filename, str) or not filename or status not in allowed_statuses:
        raise SystemExit(2)
    if filename in current_paths or filename in all_paths:
        raise SystemExit(2)
    current_paths.add(filename)
    all_paths.add(filename)
    paths.append(filename)
    if status == "renamed":
        if "previous_filename" not in item:
            raise SystemExit(2)
        previous = item["previous_filename"]
        if not isinstance(previous, str) or not previous:
            raise SystemExit(2)
        if previous in all_paths:
            raise SystemExit(2)
        all_paths.add(previous)
        paths.append(previous)
    elif "previous_filename" in item:
        raise SystemExit(2)

def canonical(pathname):
    return (
        pathname
        and not pathname.startswith("/")
        and "\\" not in pathname
        and "\x00" not in pathname
        and all(part not in {"", ".", ".."} for part in pathname.split("/"))
    )

if not all(canonical(pathname) for pathname in paths):
    raise SystemExit(2)

exact_control_paths = {
    ".dockerignore",
    ".editorconfig",
    ".eslintignore",
    ".gitignore",
    ".gitattributes",
    ".gitleaks.toml",
    ".gitleaksignore",
    ".node-version",
    ".npmrc",
    ".nvmrc",
    ".pnpmfile.cjs",
    ".pnpmfile.js",
    ".prettierignore",
    ".shellcheckrc",
    ".tool-versions",
    "Dockerfile",
    "Dockerfile.local",
    "bun.lock",
    "bun.lockb",
    "compose.local.yaml",
    "config/deployment-contract.json",
    "cloudflare/src/config/deployment-contract.test.mjs",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "sitecustomize.py",
    "usercustomize.py",
    "turbo.json",
    "yarn.lock",
}

control_basename = re.compile(
    r"^(?:"
    r"Dockerfile(?:\.[^/]+)?|"
    r"bun\.lockb?|"
    r"compose(?:\.[^/]+)?\.ya?ml|"
    r"go\.(?:mod|sum|work|work\.sum)|"
    r"package(?:-lock)?\.json|"
    r"pnpm-lock\.yaml|pnpm-workspace\.yaml|"
    r"sqlc\.ya?ml|"
    r"tsconfig(?:\.[^/]+)?\.json|"
    r"vitest\.workspace\.(?:c?js|mjs|ts|cts|mts|json|jsonc)|"
    r"wrangler\.(?:json|jsonc|toml)|"
    r"yarn\.lock|"
    r"(?:babel|eslint|jest|playwright|prettier|rollup|stylelint|vite|vitest|webpack)"
    r"\.config\.(?:c?js|mjs|ts|cts|mts|json|jsonc)"
    r")$"
)

def controls_ci(pathname):
    basename = pathname.rsplit("/", 1)[-1]
    return (
        pathname in exact_control_paths
        or pathname.startswith(".github/")
        or pathname.startswith("config/")
        or pathname.startswith("scripts/")
        or basename in {
            ".dockerignore",
            ".editorconfig",
            ".eslintignore",
            ".gitignore",
            ".gitattributes",
            ".gitleaks.toml",
            ".gitleaksignore",
            ".npmrc",
            ".nvmrc",
            ".pnpmfile.cjs",
            ".pnpmfile.js",
            ".prettierignore",
            ".shellcheckrc",
            ".tool-versions",
            ".terraform.lock.hcl",
            "sitecustomize.py",
            "usercustomize.py",
        }
        or basename.startswith((".eslintrc", ".prettierrc"))
        or control_basename.fullmatch(basename) is not None
    )

if any(controls_ci(pathname) for pathname in paths):
    raise SystemExit(3)
PY

case "$files_status" in
  0)
    ;;
  3)
    fallback "The merged PR changed CI control-plane files and must run full main CI"
    ;;
  *)
    fallback "The merged PR changed-file response was incomplete or ambiguous"
    ;;
esac

expected_artifact="pr-ci-${pr_number}-${head_sha}-${main_tree}"

runs_json="${validation_root}/runs.json"
if ! gh api \
  --method GET \
  -H "Accept: application/vnd.github+json" \
  "/repos/${repository}/actions/workflows/ci.yml/runs" \
  -f event=pull_request \
  -f status=success \
  -f branch="$head_branch" \
  -f head_sha="$head_sha" \
  -f per_page=100 >"$runs_json"; then
  fallback "Could not query successful PR workflow runs"
fi

run_ids_text="$(
  python3 -I - "$runs_json" "$pr_number" "$head_sha" "$head_branch" <<'PY'
import json
import sys

path, pr_number_text, head_sha, head_branch = sys.argv[1:]
try:
    pr_number = int(pr_number_text)
    with open(path, encoding="utf-8") as source:
        response = json.load(source)
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(2)

if not isinstance(response, dict):
    raise SystemExit(2)
total_count = response.get("total_count")
runs = response.get("workflow_runs")
if (
    not isinstance(total_count, int)
    or isinstance(total_count, bool)
    or not isinstance(runs, list)
    or total_count != len(runs)
    or total_count > 100
):
    raise SystemExit(2)

seen_ids = set()
candidates = []
for run in runs:
    if not isinstance(run, dict):
        raise SystemExit(2)
    run_id = run.get("id")
    pull_requests = run.get("pull_requests")
    if (
        not isinstance(run_id, int)
        or isinstance(run_id, bool)
        or run_id <= 0
        or run_id in seen_ids
        or not isinstance(run.get("name"), str)
        or not isinstance(run.get("event"), str)
        or not isinstance(run.get("status"), str)
        or not isinstance(run.get("conclusion"), str)
        or not isinstance(run.get("head_sha"), str)
        or not isinstance(run.get("head_branch"), str)
        or not isinstance(run.get("path"), str)
        or not isinstance(pull_requests, list)
    ):
        raise SystemExit(2)
    seen_ids.add(run_id)
    pull_numbers = []
    for pull in pull_requests:
        if (
            not isinstance(pull, dict)
            or not isinstance(pull.get("number"), int)
            or isinstance(pull.get("number"), bool)
        ):
            raise SystemExit(2)
        pull_numbers.append(pull["number"])
    metadata_matches = (
        run["name"] == "CI"
        and run["event"] == "pull_request"
        and run["status"] == "completed"
        and run["conclusion"] == "success"
        and run["head_sha"] == head_sha
        and run["head_branch"] == head_branch
        and run["path"] == ".github/workflows/ci.yml"
    )
    if metadata_matches and pull_numbers == [pr_number]:
        candidates.append(("direct", run_id))
    elif metadata_matches and not pull_numbers:
        candidates.append(("commit", run_id))

if not candidates:
    raise SystemExit(3)

print("\n".join(f"{association}:{run_id}" for association, run_id in candidates))
PY
)" || fallback "No unambiguous successful PR workflow run matched the merged PR"

mapfile -t run_candidates <<<"$run_ids_text"
if [[ "${#run_candidates[@]}" -eq 0 ]]; then
  fallback "No successful PR workflow run matched the merged PR"
fi

run_ids=()
requires_commit_pull_lookup=false
for candidate in "${run_candidates[@]}"; do
  if [[ ! "$candidate" =~ ^(direct|commit):([1-9][0-9]*)$ ]]; then
    fallback "The PR workflow run association was ambiguous"
  fi
  run_ids+=("${BASH_REMATCH[2]}")
  if [[ "${BASH_REMATCH[1]}" == "commit" ]]; then
    requires_commit_pull_lookup=true
  fi
done

if [[ "$requires_commit_pull_lookup" == true ]]; then
  head_pulls_json="${validation_root}/head-pulls.json"
  if ! gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/${repository}/commits/${head_sha}/pulls?per_page=100" >"$head_pulls_json"; then
    fallback "Could not query pull requests associated with the PR head commit"
  fi

  python3 -I - \
    "$head_pulls_json" \
    "$main_sha" \
    "$pr_number" \
    "$head_sha" \
    "$head_branch" <<'PY' || fallback "The PR head commit did not resolve to the exact merged PR"
import json
import sys

path, main_sha, pr_number_text, head_sha, head_branch = sys.argv[1:]
try:
    pr_number = int(pr_number_text)
    with open(path, encoding="utf-8") as source:
        pulls = json.load(source)
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(2)

if not isinstance(pulls, list) or len(pulls) != 1:
    raise SystemExit(2)

pull = pulls[0]
base = pull.get("base") if isinstance(pull, dict) else None
head = pull.get("head") if isinstance(pull, dict) else None
if (
    not isinstance(pull, dict)
    or not isinstance(pull.get("number"), int)
    or isinstance(pull.get("number"), bool)
    or pull["number"] != pr_number
    or pull.get("state") != "closed"
    or not isinstance(pull.get("merged_at"), str)
    or pull.get("merge_commit_sha") != main_sha
    or not isinstance(base, dict)
    or base.get("ref") != "main"
    or not isinstance(head, dict)
    or head.get("sha") != head_sha
    or head.get("ref") != head_branch
):
    raise SystemExit(2)
PY
fi

validate_jobs() {
  local jobs_file="$1"
  python3 -I - "$jobs_file" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as source:
        response = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(2)

expected = {
    "Reuse verified PR CI": "skipped",
    "workflow": "success",
    "Security, configuration, and documentation": "success",
    "frontend": "success",
    "backend": "success",
    "infrastructure": "success",
    "e2e": "success",
    "Attest tested PR tree": "success",
}
if not isinstance(response, dict):
    raise SystemExit(2)
total_count = response.get("total_count")
jobs = response.get("jobs")
if (
    not isinstance(total_count, int)
    or isinstance(total_count, bool)
    or not isinstance(jobs, list)
    or total_count != len(jobs)
    or total_count > 100
):
    raise SystemExit(2)

actual = {}
for job in jobs:
    if not isinstance(job, dict):
        raise SystemExit(2)
    name = job.get("name")
    status = job.get("status")
    conclusion = job.get("conclusion")
    if (
        not isinstance(name, str)
        or not isinstance(status, str)
        or not isinstance(conclusion, str)
        or name in actual
    ):
        raise SystemExit(2)
    actual[name] = (status, conclusion)

if set(actual) != set(expected):
    raise SystemExit(3)
for name, conclusion in expected.items():
    if actual[name] != ("completed", conclusion):
        raise SystemExit(3)
PY
}

select_artifact() {
  local artifacts_file="$1"
  local artifact_name="$2"
  local expected_run_id="$3"
  python3 -I - "$artifacts_file" "$artifact_name" "$expected_run_id" <<'PY'
import json
import re
import sys

path, expected_name, expected_run_id_text = sys.argv[1:]
if re.fullmatch(r"[1-9][0-9]*", expected_run_id_text) is None:
    raise SystemExit(2)
expected_run_id = int(expected_run_id_text)
try:
    with open(path, encoding="utf-8") as source:
        response = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(2)

if not isinstance(response, dict):
    raise SystemExit(2)
total_count = response.get("total_count")
artifacts = response.get("artifacts")
if (
    not isinstance(total_count, int)
    or isinstance(total_count, bool)
    or not isinstance(artifacts, list)
    or total_count != 1
    or len(artifacts) != 1
):
    raise SystemExit(2)

artifact = artifacts[0]
if not isinstance(artifact, dict):
    raise SystemExit(2)
artifact_id = artifact.get("id")
name = artifact.get("name")
expired = artifact.get("expired")
workflow_run = artifact.get("workflow_run")
workflow_run_id = workflow_run.get("id") if isinstance(workflow_run, dict) else None
if (
    not isinstance(artifact_id, int)
    or isinstance(artifact_id, bool)
    or artifact_id <= 0
    or not isinstance(name, str)
    or not name
    or not isinstance(expired, bool)
    or not isinstance(workflow_run, dict)
    or not isinstance(workflow_run_id, int)
    or isinstance(workflow_run_id, bool)
    or workflow_run_id <= 0
    or workflow_run_id != expected_run_id
):
    raise SystemExit(2)
if name != expected_name or expired:
    raise SystemExit(4)
print(artifact_id)
PY
}

validate_attestation_archive() {
  local archive_file="$1"
  local expected_run_id="$2"
  python3 -I - \
    "$archive_file" \
    "$pr_number" \
    "$head_sha" \
    "$main_tree" \
    "$expected_run_id" <<'PY'
import os
import re
import stat
import sys
import zipfile
import zlib

archive_path, pr_number, head_sha, tested_tree, run_id = sys.argv[1:]
max_archive_bytes = 16 * 1024
max_payload_bytes = 4096

try:
    archive_size = os.path.getsize(archive_path)
    if archive_size <= 0 or archive_size > max_archive_bytes:
        raise SystemExit(2)
    with zipfile.ZipFile(archive_path, "r") as archive:
        members = archive.infolist()
        if len(members) != 1:
            raise SystemExit(2)
        member = members[0]
        unix_mode = member.external_attr >> 16
        file_type = stat.S_IFMT(unix_mode)
        if (
            member.filename != "attestation.txt"
            or member.is_dir()
            or member.flag_bits & 0x1
            or file_type not in {0, stat.S_IFREG}
            or member.compress_type
            not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
            or member.file_size < 0
            or member.compress_size < 0
            or member.compress_size > archive_size
        ):
            raise SystemExit(2)
        with archive.open(member, "r") as source:
            payload = source.read(4097)
            if (
                len(payload) > max_payload_bytes
                or len(payload) != member.file_size
                or source.read(1)
            ):
                raise SystemExit(2)
        if zlib.crc32(payload) & 0xFFFFFFFF != member.CRC:
            raise SystemExit(2)
except (
    OSError,
    EOFError,
    KeyError,
    NotImplementedError,
    RuntimeError,
    ValueError,
    zipfile.BadZipFile,
    zipfile.LargeZipFile,
    zlib.error,
):
    raise SystemExit(2)

try:
    text = payload.decode("utf-8", errors="strict")
except UnicodeDecodeError:
    raise SystemExit(2)

pattern = re.compile(
    rf"pull_request={re.escape(pr_number)}\n"
    rf"head_sha={re.escape(head_sha)}\n"
    rf"tested_commit=([0-9a-f]{{40}})\n"
    rf"tested_tree={re.escape(tested_tree)}\n"
    rf"workflow_run={re.escape(run_id)}\n"
)
if pattern.fullmatch(text) is None:
    raise SystemExit(3)
PY
}

for run_id in "${run_ids[@]}"; do
  if [[ ! "$run_id" =~ ^[1-9][0-9]*$ ]]; then
    fallback "The PR workflow run identifier was ambiguous"
  fi

  jobs_json="${validation_root}/jobs-${run_id}.json"
  if ! gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/${repository}/actions/runs/${run_id}/jobs?filter=latest&per_page=100" >"$jobs_json"; then
    fallback "Could not query the PR workflow run jobs"
  fi

  jobs_status=0
  validate_jobs "$jobs_json" || jobs_status=$?
  case "$jobs_status" in
    0)
      ;;
    3)
      continue
      ;;
    *)
      fallback "The PR workflow run jobs response was ambiguous"
      ;;
  esac

  artifacts_json="${validation_root}/artifacts-${run_id}.json"
  if ! gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/${repository}/actions/runs/${run_id}/artifacts?per_page=100" >"$artifacts_json"; then
    fallback "Could not query the PR workflow run artifacts"
  fi

  artifact_status=0
  artifact_id="$(select_artifact "$artifacts_json" "$expected_artifact" "$run_id")" || artifact_status=$?
  case "$artifact_status" in
    0)
      ;;
    4)
      continue
      ;;
    *)
      fallback "The PR workflow run artifact response was ambiguous"
      ;;
  esac

  archive_file="${validation_root}/attestation-${run_id}.zip"
  if ! gh api \
    -H "Accept: application/vnd.github+json" \
    "/repos/${repository}/actions/artifacts/${artifact_id}/zip" >"$archive_file"; then
    fallback "Could not download the PR workflow run attestation"
  fi
  if ! validate_attestation_archive "$archive_file" "$run_id"; then
    fallback "The PR workflow run attestation archive or payload was invalid"
  fi

  write_output reuse_pr_ci true
  write_output source_pr_number "$pr_number"
  write_output source_run_id "$run_id"
  write_output tested_tree "$main_tree"
  echo "::notice::Reusing attested PR CI for PR #${pr_number}, run ${run_id}, at tree ${main_tree}"
  exit 0
done

fallback "No successful PR workflow run had the exact validated attestation"
