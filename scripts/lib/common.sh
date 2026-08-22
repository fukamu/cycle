#!/usr/bin/env bash

if ((BASH_VERSINFO[0] < 5)); then
  printf '%s\n' "Error: Bash 5.0 or newer is required." >&2
  exit 1
fi

set -Eeuo pipefail
IFS=$'\n\t'

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 \
    || die "Required command '${command_name}' was not found. See docs/development.md."
}

require_standard_tool_versions() {
  require_command node
  require_command pnpm
  require_command go

  local node_version
  local node_major
  local pnpm_version
  local go_version

  node_version="$(node --version)"
  node_version="${node_version#v}"
  node_major="${node_version%%.*}"
  if [[ ! "${node_major}" =~ ^[0-9]+$ ]] || ((node_major < 24)); then
    die "Node.js 24 or newer is required; found ${node_version}."
  fi

  pnpm_version="$(pnpm --version)"
  [[ "${pnpm_version}" == "11.22.0" ]] \
    || die "pnpm 11.22.0 is required for reproducible local/CI builds; found ${pnpm_version}."

  go_version="$(go env GOVERSION)"
  go_version="${go_version#go}"
  [[ "${go_version}" == "1.26.6" ]] \
    || die "Go 1.26.6 is required for reproducible local/CI builds; found ${go_version}."
}

require_disposable_test_database_url() {
  local database_url="${1:-}"
  local local_test_database_pattern='^postgres(ql)?://[^/]+@(127\.0\.0\.1|localhost|\[::1\]):[0-9]+/[^/?#]*_test(\?[^#]*)?$'

  [[ -n "${database_url}" ]] \
    || die "Set TEST_DATABASE_URL to a disposable PostgreSQL test database."
  [[ "${database_url}" =~ ${local_test_database_pattern} ]] \
    || die "TEST_DATABASE_URL must target a localhost PostgreSQL database whose name ends in _test."
}

resolve_repo_root() {
  local script_path="$1"
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${script_path}")" && pwd -P)"
  realpath -e -- "${script_dir}/.."
}

require_local_docker_context() {
  local endpoint
  if ! endpoint="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null)"; then
    die "Could not inspect the Docker context. No local operation was started."
  fi
  endpoint="${endpoint//$'\r'/}"
  case "${endpoint}" in
    unix://* | npipe://*) ;;
    *) die "Refusing Docker context '${endpoint}': only a local Docker daemon is allowed." ;;
  esac
  printf '%s\n' "${endpoint}"
}

assert_safe_repo_target() {
  local repo_root="$1"
  local target="$2"
  local canonical_target
  canonical_target="$(realpath -m -- "${target}")"

  case "${canonical_target}" in
    "${repo_root}/"*) ;;
    *) die "Refusing to remove a path outside the repository: ${canonical_target}" ;;
  esac
  [[ "${canonical_target}" != "${repo_root}" ]] \
    || die "Refusing to remove the repository root."
}

urlencode() {
  local value="$1"
  local encoded=""
  local character
  local index
  local hex

  local LC_ALL=C
  for ((index = 0; index < ${#value}; index++)); do
    character="${value:index:1}"
    case "${character}" in
      [a-zA-Z0-9.~_-]) encoded+="${character}" ;;
      *)
        printf -v hex '%%%02X' "'${character}"
        encoded+="${hex}"
        ;;
    esac
  done
  printf '%s' "${encoded}"
}
