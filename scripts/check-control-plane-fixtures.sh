#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
mode="working-tree"
base_revision=''
head_revision=''

usage() {
  cat <<'EOF'
Usage: ./scripts/check-control-plane-fixtures.sh [--working-tree|--staged|--range BASE_SHA HEAD_SHA]

Run the repository gate/control-plane negative fixture suite when the selected
candidate changes a CI trust-boundary path. Only a complete inventory made up
entirely of known application paths may skip the suite; ambiguity runs it.
EOF
}

if (($# > 0)); then
  case "$1" in
    --working-tree | --staged)
      (($# == 1)) || die "$1 accepts no additional arguments."
      mode="${1#--}"
      ;;
    --range)
      (($# == 3)) || die "--range requires BASE_SHA and HEAD_SHA."
      mode="range"
      base_revision="$2"
      head_revision="$3"
      ;;
    --help)
      (($# == 1)) || die "--help accepts no additional arguments."
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
fi

is_canonical_path() {
  local relative_path="$1"
  local backslash=$'\\'

  [[ -n "${relative_path}" && "${relative_path}" != /* &&
    "${relative_path}" != *"${backslash}"* && "${relative_path}" != *'//'* &&
    "${relative_path}" != '.' && "${relative_path}" != '..' &&
    "${relative_path}" != ./* && "${relative_path}" != ../* &&
    "${relative_path}" != */../* && "${relative_path}" != */.. &&
    "${relative_path}" != *$'\n'* && "${relative_path}" != *$'\r'* ]]
}

is_control_plane_path() {
  local relative_path="$1"
  local basename="${relative_path##*/}"

  case "${relative_path}" in
    .github/* | .fukamu/* | scripts/* | config/* | infra/* | AGENTS.md | \
      .dockerignore | .editorconfig | .env.example | .eslintignore | \
      .gitattributes | .gitignore | .gitleaks.toml | .gitleaksignore | \
      .node-version | .npmrc | .nvmrc | .pnpmfile.cjs | .pnpmfile.js | \
      .prettierignore | .shellcheckrc | .tool-versions | Dockerfile | \
      Dockerfile.* | compose.local.yaml | package.json | package-lock.json | \
      pnpm-lock.yaml | pnpm-workspace.yaml | sitecustomize.py | turbo.json | \
      usercustomize.py | yarn.lock | bun.lock | bun.lockb | \
      backend/cmd/configcheck/* | backend/sqlc.yaml | backend/sqlc.yml | \
      cloudflare/src/config/* | \
      cloudflare/legacy-retirement/* | frontend/.env.example | \
      frontend/e2e/staging-critical*.mjs | frontend/e2e/staging-csrf-rollout*.mjs | \
      frontend/public/_headers)
      return 0
      ;;
  esac

  case "${basename}" in
    .dockerignore | .editorconfig | .env.example | .eslintignore | \
      .gitattributes | .gitignore | .gitleaks.toml | .gitleaksignore | \
      .npmrc | .nvmrc | .pnpmfile.cjs | .pnpmfile.js | .prettierignore | \
      .shellcheckrc | .terraform.lock.hcl | .tool-versions | \
      sitecustomize.py | usercustomize.py | go.mod | go.sum | go.work | \
      go.work.sum | package.json | package-lock.json | pnpm-lock.yaml | \
      pnpm-workspace.yaml | sqlc.yaml | sqlc.yml | yarn.lock | bun.lock | \
      bun.lockb)
      return 0
      ;;
  esac

  case "${basename}" in
    Dockerfile.* | *.Dockerfile | compose.*.yaml | compose.*.yml | \
      docker-compose*.yaml | docker-compose*.yml | tsconfig*.json | \
      wrangler.json | wrangler.jsonc | wrangler.toml | babel.config.* | \
      eslint.config.* | jest.config.* | playwright.config.* | \
      prettier.config.* | rollup.config.* | stylelint.config.* | \
      vite.config.* | vitest.config.* | vitest.workspace.* | \
      webpack.config.* | .eslintrc* | .prettierrc*)
      return 0
      ;;
  esac

  return 1
}

is_application_path() {
  local relative_path="$1"

  case "${relative_path}" in
    README.md | docs/*.md | backend/*.go | backend/*.sql | \
      backend/internal/ai/prompts/*.txt | backend/testdata/*.jsonl | \
      frontend/index.html | frontend/src/*.css | frontend/src/*.ts | \
      frontend/src/*.tsx | frontend/e2e/*.mjs | frontend/e2e/*.ts | \
      frontend/vite/*.ts | cloudflare/src/*.mjs | cloudflare/src/*.ts)
      return 0
      ;;
  esac
  return 1
}

inventory_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-cycle-control-plane.XXXXXXXX")"
manifest="${inventory_root}/changes.nul"
: >"${manifest}"
cleanup_inventory() {
  [[ ! -d "${inventory_root}" ]] || rm -rf -- "${inventory_root}"
}
trap cleanup_inventory EXIT

append_manifest_record() {
  local status="$1"
  local old_mode="$2"
  local new_mode="$3"
  local relative_path="$4"

  printf '%s\0%s\0%s\0%s\0' \
    "${status}" "${old_mode}" "${new_mode}" "${relative_path}" >>"${manifest}"
}

append_diff_inventory() {
  local label="$1"
  shift
  local raw_inventory="${inventory_root}/${label}.raw"
  local raw_fd
  local header
  local relative_path
  local destination_path
  local old_mode
  local new_mode
  local status

  if ! trusted_git -C "${repo_root}" diff \
    --raw --abbrev=40 -z --no-ext-diff --no-textconv \
    --find-renames=50% --find-copies=50% --find-copies-harder \
    "$@" >"${raw_inventory}"; then
    return 1
  fi

  exec {raw_fd}<"${raw_inventory}"
  while true; do
    header=''
    if ! IFS= read -r -d '' header <&"${raw_fd}"; then
      [[ -z "${header}" ]] || {
        exec {raw_fd}<&-
        return 1
      }
      break
    fi
    if [[ ! "${header}" =~ ^:([0-7]{6})[[:space:]]([0-7]{6})[[:space:]][0-9a-f]{40}[[:space:]][0-9a-f]{40}[[:space:]]([A-Z][0-9]*)$ ]]; then
      exec {raw_fd}<&-
      return 1
    fi
    old_mode="${BASH_REMATCH[1]}"
    new_mode="${BASH_REMATCH[2]}"
    status="${BASH_REMATCH[3]}"
    if ! IFS= read -r -d '' relative_path <&"${raw_fd}"; then
      exec {raw_fd}<&-
      return 1
    fi
    append_manifest_record "${status}" "${old_mode}" "${new_mode}" "${relative_path}"
    if [[ "${status}" == R* || "${status}" == C* ]]; then
      if ! IFS= read -r -d '' destination_path <&"${raw_fd}"; then
        exec {raw_fd}<&-
        return 1
      fi
      append_manifest_record "${status}" "${old_mode}" "${new_mode}" "${destination_path}"
    fi
  done
  exec {raw_fd}<&-
}

append_untracked_inventory() {
  local untracked_inventory="${inventory_root}/untracked.nul"
  local untracked_fd
  local relative_path
  local new_mode

  if ! trusted_git -C "${repo_root}" ls-files --others --exclude-standard -z \
    >"${untracked_inventory}"; then
    return 1
  fi

  exec {untracked_fd}<"${untracked_inventory}"
  while true; do
    relative_path=''
    if ! IFS= read -r -d '' relative_path <&"${untracked_fd}"; then
      [[ -z "${relative_path}" ]] || {
        exec {untracked_fd}<&-
        return 1
      }
      break
    fi
    new_mode='invalid'
    if is_canonical_path "${relative_path}" \
      && [[ -f "${repo_root}/${relative_path}" && ! -L "${repo_root}/${relative_path}" ]]; then
      new_mode='100644'
      [[ ! -x "${repo_root}/${relative_path}" ]] || new_mode='100755'
    fi
    append_manifest_record A 000000 "${new_mode}" "${relative_path}"
  done
  exec {untracked_fd}<&-
}

inventory_complete=true
case "${mode}" in
  working-tree)
    append_diff_inventory unstaged -- || inventory_complete=false
    if [[ "${inventory_complete}" == "true" ]]; then
      append_diff_inventory staged --cached -- || inventory_complete=false
    fi
    if [[ "${inventory_complete}" == "true" ]]; then
      append_untracked_inventory || inventory_complete=false
    fi
    ;;
  staged)
    append_diff_inventory staged --cached -- || inventory_complete=false
    ;;
  range)
    if [[ ! "${base_revision}" =~ ^[0-9a-f]{40}$ ||
      ! "${head_revision}" =~ ^[0-9a-f]{40}$ ]] \
      || ! trusted_git -C "${repo_root}" cat-file -e "${base_revision}^{commit}" 2>/dev/null \
      || ! trusted_git -C "${repo_root}" cat-file -e "${head_revision}^{commit}" 2>/dev/null \
      || ! trusted_git -C "${repo_root}" merge-base --is-ancestor \
        "${base_revision}" "${head_revision}" 2>/dev/null; then
      inventory_complete=false
    elif ! append_diff_inventory range "${base_revision}" "${head_revision}" --; then
      inventory_complete=false
    fi
    ;;
esac

run_fixtures=false
reason='application_only'
entry_count=0
declare -A seen_paths=()

if [[ "${inventory_complete}" != "true" ]]; then
  run_fixtures=true
  reason='classification_failed'
else
  exec {manifest_fd}<"${manifest}"
  while IFS= read -r -d '' status <&"${manifest_fd}"; do
    if ! IFS= read -r -d '' old_mode <&"${manifest_fd}" \
      || ! IFS= read -r -d '' new_mode <&"${manifest_fd}" \
      || ! IFS= read -r -d '' relative_path <&"${manifest_fd}"; then
      run_fixtures=true
      reason='classification_failed'
      break
    fi

    ((entry_count += 1))
    if ((entry_count > 100)); then
      run_fixtures=true
      reason='change_limit_exceeded'
      break
    fi
    if ! is_canonical_path "${relative_path}" \
      || [[ -n "${seen_paths["${relative_path}"]+present}" ]]; then
      run_fixtures=true
      reason='ambiguous_path_inventory'
      break
    fi
    seen_paths["${relative_path}"]=1

    case "${status}:${old_mode}:${new_mode}" in
      A:000000:100644 | A:000000:100755 | \
        M:100644:100644 | M:100644:100755 | \
        M:100755:100644 | M:100755:100755 | \
        D:100644:000000 | D:100755:000000) ;;
      *)
        run_fixtures=true
        reason='rename_or_type_change'
        break
        ;;
    esac

    if is_control_plane_path "${relative_path}"; then
      run_fixtures=true
      reason='control_plane_change'
      break
    fi
    if ! is_application_path "${relative_path}"; then
      run_fixtures=true
      reason='unknown_path'
      break
    fi
  done
  exec {manifest_fd}<&-

  if ((entry_count == 0)); then
    run_fixtures=true
    reason='empty_change_inventory'
  fi
fi

if [[ "${run_fixtures}" == "true" ]]; then
  printf 'Change classification: %s. Running gate/control-plane negative fixtures.\n' "${reason}"
  bash "${script_dir}/tests/run.sh"
else
  printf '%s\n' \
    'Change classification: application_only. Gate/control-plane negative fixtures are not applicable.'
fi
