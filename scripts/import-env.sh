#!/usr/bin/env bash

if ((BASH_VERSINFO[0] < 5)); then
  printf '%s\n' "Error: Bash 5.0 or newer is required." >&2
  if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    exit 1
  fi
  return 1
fi

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' "Error: source this script so variables are loaded into the current shell:" >&2
  printf '%s\n' "  source ./scripts/import-env.sh [--file PATH]" >&2
  exit 1
fi

_fukamu_cycle_import_env() {
  local -
  set -Eeuo pipefail
  local IFS=$'\n\t'

  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  local env_path="${script_dir}/../.env"
  local loaded=0
  local line
  local name
  local value

  while (($# > 0)); do
    case "$1" in
      --file)
        (($# >= 2)) || {
          printf '%s\n' "Error: --file requires a path." >&2
          return 1
        }
        env_path="$2"
        shift 2
        ;;
      --help)
        printf '%s\n' "Usage: source ./scripts/import-env.sh [--file PATH]"
        return 0
        ;;
      *)
        printf 'Error: unknown option: %s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  if [[ ! -f "${env_path}" ]]; then
    printf 'Error: environment file was not found: %s\n' "${env_path}" >&2
    return 1
  fi

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    if [[ "${line}" =~ ^[[:space:]]*$ || "${line}" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ ! "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      printf 'Error: unsupported environment line in %s.\n' "${env_path}" >&2
      return 1
    fi
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if ! declare -gx "${name}=${value}"; then
      printf 'Error: environment variable cannot be set: %s\n' "${name}" >&2
      return 1
    fi
    ((loaded += 1))
  done <"${env_path}"

  printf 'Loaded %d environment variables from %s into the current shell.\n' \
    "${loaded}" "${env_path}"
}

_fukamu_cycle_import_status=0
_fukamu_cycle_import_env "$@" || _fukamu_cycle_import_status=$?
unset -f _fukamu_cycle_import_env
if ((_fukamu_cycle_import_status == 0)); then
  unset _fukamu_cycle_import_status
  return 0
fi
unset _fukamu_cycle_import_status
return 1
