#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"
container_name="pdcai-postgres"
database_name="pdcai"
confirm_database_name=""
dry_run=false
confirmed=false

usage() {
  cat <<'EOF'
Usage: ./scripts/reset-local-db.sh \
  --database-name NAME \
  --confirm-database-name NAME \
  [--container-name NAME] [--dry-run | --yes]

Permanently drop, recreate, and migrate one allowlisted database in a running
local PostgreSQL 17 Docker container. Real deletion requires both an exact
database-name confirmation and --yes.
EOF
}

while (($# > 0)); do
  case "$1" in
    --container-name)
      (($# >= 2)) || die "--container-name requires a value."
      container_name="$2"
      shift 2
      ;;
    --database-name)
      (($# >= 2)) || die "--database-name requires a value."
      database_name="$2"
      shift 2
      ;;
    --confirm-database-name)
      (($# >= 2)) || die "--confirm-database-name requires a value."
      confirm_database_name="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --yes)
      confirmed=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "${database_name}" =~ ^pdcai(_dev|_test)?$ ]] \
  || die "--database-name must be pdcai, pdcai_dev, or pdcai_test. No database was changed."
[[ "${container_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || die "--container-name must be a valid local Docker container name. No database was changed."
[[ -n "${confirm_database_name}" ]] \
  || die "--confirm-database-name is required. No database was changed."
[[ "${confirm_database_name}" == "${database_name}" ]] \
  || die "Confirmation did not match --database-name exactly. No database was changed."
[[ "${APP_ENV:-}" != "production" ]] \
  || die "Refusing to reset a database while APP_ENV=production."
[[ "${dry_run}" != "true" || "${confirmed}" != "true" ]] \
  || die "--dry-run and --yes cannot be used together."

target_description="database '${database_name}' in local Docker container '${container_name}'"
if [[ "${dry_run}" == "true" ]]; then
  printf 'Would permanently delete all data, recreate, and migrate %s.\n' "${target_description}"
  exit 0
fi
[[ "${confirmed}" == "true" ]] \
  || die "--yes is required for a real reset. No database was changed."

require_command docker
require_command go
require_local_docker_context >/dev/null

container_state="$(docker inspect --format '{{.State.Status}}' "${container_name}")" \
  || die "Could not inspect container '${container_name}'. No database was changed."
container_image="$(docker inspect --format '{{.Config.Image}}' "${container_name}")" \
  || die "Could not inspect container '${container_name}'. No database was changed."
container_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${container_name}")" \
  || die "Could not inspect container '${container_name}'. No database was changed."

[[ "${container_state}" == "running" ]] \
  || die "Container '${container_name}' is not running. No database was changed."
[[ "${container_image}" =~ ^postgres:17(-|$) ]] \
  || die "Container '${container_name}' does not use the expected PostgreSQL 17 image. No database was changed."

postgres_user=""
postgres_password=""
while IFS= read -r environment_entry; do
  case "${environment_entry}" in
    POSTGRES_USER=*) postgres_user="${environment_entry#POSTGRES_USER=}" ;;
    POSTGRES_PASSWORD=*) postgres_password="${environment_entry#POSTGRES_PASSWORD=}" ;;
  esac
done <<<"${container_environment}"
[[ -n "${postgres_user}" && -n "${postgres_password}" ]] \
  || die "POSTGRES_USER/POSTGRES_PASSWORD are unavailable on '${container_name}'. No database was changed."

host_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "${container_name}")" \
  || die "Container '${container_name}' does not expose PostgreSQL to a local host port. No database was changed."
[[ "${host_port}" =~ ^[0-9]+$ ]] \
  || die "Container '${container_name}' does not expose PostgreSQL to a local host port. No database was changed."

go_version="$(go env GOVERSION)"
go_version="${go_version#go}"
[[ "${go_version}" == "1.26.6" ]] \
  || die "Go 1.26.6 is required before reset so migrations can run. No database was changed."

docker exec "${container_name}" \
  dropdb --username "${postgres_user}" --if-exists --force "${database_name}" \
  || die "dropdb failed; the reset was not completed."
docker exec "${container_name}" \
  createdb --username "${postgres_user}" --owner "${postgres_user}" "${database_name}" \
  || die "createdb failed; the database may be absent and requires manual recovery."

encoded_user="$(urlencode "${postgres_user}")"
encoded_password="$(urlencode "${postgres_password}")"
database_url="postgres://${encoded_user}:${encoded_password}@127.0.0.1:${host_port}/${database_name}?sslmode=disable"
(
  cd -- "${repo_root}/backend"
  DATABASE_URL="${database_url}" MIGRATIONS_DIR=migrations go run ./cmd/migrate
) || die "Migration failed. The local database exists but may be empty or partially migrated."

printf "Local database '%s' was recreated and migrated.\n" "${database_name}"
