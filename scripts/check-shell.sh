#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"

if (($# > 0)); then
  [[ "$1" == "--help" && $# -eq 1 ]] || die "This command accepts no options."
  printf '%s\n' "Usage: ./scripts/check-shell.sh"
  exit 0
fi

require_command docker
require_local_docker_context >/dev/null

shell_files=()
mapfile -d '' shell_files < <(
  find "${repo_root}/scripts" "${repo_root}/.github/scripts" \
    -type f -name '*.sh' -print0 | sort -z
)
(("${#shell_files[@]}" > 0)) || die "No Bash scripts were found for shell quality checks."

relative_files=()
for file in "${shell_files[@]}"; do
  relative_files+=(".${file#"${repo_root}"}")
done

bash -n "${shell_files[@]}"
docker run --rm \
  --volume "${repo_root}:/src:ro" \
  --workdir /src \
  koalaman/shellcheck:v0.11.0 \
  --external-sources "${relative_files[@]}"
docker run --rm \
  --volume "${repo_root}:/src:ro" \
  --workdir /src \
  mvdan/shfmt:v3.13.1 \
  -d -i 2 -ci -bn "${relative_files[@]}"
bash "${script_dir}/tests/run.sh"
