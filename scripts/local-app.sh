#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
compose_file="${repo_root}/compose.local.yaml"
port=8080
detached=false
down=false
keep_running=false
started=false

usage() {
  cat <<'EOF'
Usage: ./scripts/local-app.sh [--port PORT] [--detached]
       ./scripts/local-app.sh --down

Build and start the isolated local application on a local Docker daemon.
Without --detached, pressing Enter stops it and removes its disposable DB.
EOF
}

while (($# > 0)); do
  case "$1" in
    --port)
      (($# >= 2)) || die "--port requires a value."
      port="$2"
      shift 2
      ;;
    --detached)
      detached=true
      shift
      ;;
    --down)
      down=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [[ ! "${port}" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  die "--port must be an integer from 1024 to 65535."
fi
if [[ "${down}" == "true" && "${detached}" == "true" ]]; then
  die "--down and --detached cannot be used together."
fi

require_command docker
require_local_docker_context >/dev/null
compose_args=(
  compose
  --project-name fukamu-cycle-local
  --file "${compose_file}"
)

stop_local_app() {
  docker "${compose_args[@]}" down --volumes --remove-orphans
}

if [[ "${down}" == "true" ]]; then
  stop_local_app
  printf '%s\n' "FUKAMU Cycle local environment was removed."
  exit 0
fi

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ "${started}" == "true" && "${keep_running}" == "false" ]]; then
    if ! stop_local_app; then
      warn "Automatic cleanup failed. Run './scripts/local-app.sh --down'."
      ((exit_code == 0)) && exit_code=1
    fi
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

require_command curl
export FUKAMU_CYCLE_LOCAL_PORT="${port}"
docker "${compose_args[@]}" up --build --detach --remove-orphans app
started=true

ready_url="http://127.0.0.1:${port}/readyz"
ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if curl --fail --silent --show-error --max-time 2 "${ready_url}" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != "true" ]]; then
  docker "${compose_args[@]}" logs --no-color || true
  die "FUKAMU Cycle did not become ready at ${ready_url}."
fi

printf 'FUKAMU Cycle is ready: http://localhost:%s\n' "${port}"
printf '%s\n' "The database is disposable and external AI/authentication services are disabled."
if [[ "${detached}" == "true" ]]; then
  keep_running=true
  printf '%s\n' "Run './scripts/local-app.sh --down' to stop and remove it."
else
  read -r -p "Press Enter to stop and remove the local environment"
fi
