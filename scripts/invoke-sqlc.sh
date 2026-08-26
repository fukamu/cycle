#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
backend_path="${repo_root}/backend"
required_version="1.31.1"
docker_image="sqlc/sqlc:${required_version}"
go_package="github.com/sqlc-dev/sqlc/cmd/sqlc@v${required_version}"
managed_tool_dir="${repo_root}/.tmp/tools/sqlc-${required_version}"
managed_sqlc="${managed_tool_dir}/sqlc"
runner="auto"
commands=()

usage() {
  cat <<'EOF'
Usage: ./scripts/invoke-sqlc.sh [--runner auto|host|docker|go] compile [generate]

Run pinned sqlc commands with a matching host binary, a disposable Docker
container, or a repository-local temporary Go tool.
EOF
}

while (($# > 0)); do
  case "$1" in
    --runner)
      (($# >= 2)) || die "--runner requires a value."
      runner="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    --*) die "Unknown option: $1" ;;
    *)
      commands+=("$1")
      shift
      ;;
  esac
done

case "${runner}" in
  auto | host | docker | go) ;;
  *) die "--runner must be auto, host, docker, or go." ;;
esac
(("${#commands[@]}" > 0)) || die "At least one sqlc command is required."
for command_name in "${commands[@]}"; do
  case "${command_name}" in
    compile | generate) ;;
    *) die "Unsupported sqlc command: ${command_name}" ;;
  esac
done

host_sqlc_version() {
  command -v sqlc >/dev/null 2>&1 || return 1
  local output
  output="$(sqlc version 2>/dev/null)" || return 1
  output="${output#v}"
  [[ "${output}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s\n' "${output}"
}

docker_server_available() {
  command -v docker >/dev/null 2>&1 \
    && docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

host_version=""
host_version="$(host_sqlc_version || true)"
selected_runner="${runner}"
if [[ "${runner}" == "auto" ]]; then
  if [[ "${host_version}" == "${required_version}" ]]; then
    selected_runner="host"
  elif docker_server_available; then
    [[ -z "${host_version}" ]] \
      || warn "Host sqlc ${host_version} does not match required version ${required_version}; using Docker."
    selected_runner="docker"
  elif command -v go >/dev/null 2>&1; then
    [[ -z "${host_version}" ]] \
      || warn "Host sqlc ${host_version} does not match required version ${required_version}; using the pinned temporary Go tool."
    selected_runner="go"
  else
    die "sqlc ${required_version} is unavailable. Install it, start Docker, or install Go; see docs/development.md."
  fi
fi

if [[ "${selected_runner}" == "host" && "${host_version}" != "${required_version}" ]]; then
  [[ -n "${host_version}" ]] || host_version="not found"
  die "Host sqlc ${required_version} is required; found: ${host_version}."
fi
if [[ "${selected_runner}" == "docker" ]] && ! docker_server_available; then
  die "Docker runner was requested, but the Docker server is unavailable."
fi
if [[ "${selected_runner}" == "go" ]]; then
  require_command go
fi

cd -- "${backend_path}"
for command_name in "${commands[@]}"; do
  case "${selected_runner}" in
    host)
      printf 'Running sqlc %s with host sqlc %s.\n' "${command_name}" "${required_version}"
      sqlc "${command_name}"
      ;;
    docker)
      printf 'Running sqlc %s with disposable Docker image %s.\n' "${command_name}" "${docker_image}"
      docker run --rm \
        --user "$(id -u):$(id -g)" \
        --volume "${backend_path}:/src" \
        --workdir /src \
        "${docker_image}" "${command_name}"
      ;;
    go)
      if [[ ! -x "${managed_sqlc}" ]]; then
        printf 'Building temporary sqlc %s tool with Go.\n' "${required_version}"
        mkdir -p -- "${managed_tool_dir}"
        GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly \
          GOBIN="${managed_tool_dir}" go install "${go_package}"
      fi
      printf 'Running sqlc %s with temporary tool %s.\n' "${command_name}" "${managed_sqlc}"
      "${managed_sqlc}" "${command_name}"
      ;;
  esac
done
