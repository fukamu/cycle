#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/common.sh
source "${script_dir}/lib/common.sh"
repo_root="$(resolve_repo_root "${BASH_SOURCE[0]}")"

if (($# > 0)); then
  [[ "$1" == "--help" && $# -eq 1 ]] || die "This command accepts no options."
  printf '%s\n' "Usage: ./scripts/check-docker-context.sh"
  exit 0
fi

require_command docker
require_local_docker_context >/dev/null
docker buildx version >/dev/null 2>&1 \
  || die "Docker Buildx is required for build-context inspection."

audit_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-cycle-docker-context.XXXXXXXX")"
trap 'rm -rf -- "${audit_root}"' EXIT
context_dir="${audit_root}/context"
mkdir -p -- "${context_dir}"

cp -- "${repo_root}/.dockerignore" "${context_dir}/.dockerignore"
for dockerfile_name in Dockerfile Dockerfile.local; do
  cp -- \
    "${repo_root}/scripts/fixtures/docker-context-audit.Dockerfile" \
    "${context_dir}/${dockerfile_name}"
  dockerfile_ignore="${repo_root}/${dockerfile_name}.dockerignore"
  if [[ -f "${dockerfile_ignore}" ]]; then
    cp -- "${dockerfile_ignore}" "${context_dir}/${dockerfile_name}.dockerignore"
  fi
done

allowed_path="audit-visible/context-marker.txt"
mkdir -p -- "$(dirname -- "${context_dir}/${allowed_path}")"
printf '%s\n' "benign visible context marker" >"${context_dir}/${allowed_path}"

forbidden_paths=(
  ".env"
  ".env.local"
  ".env.production.local"
  "frontend/.env.local"
  "backend/.env.test"
  "node_modules/root-package/context-canary.txt"
  "frontend/node_modules/frontend-package/context-canary.txt"
  "cloudflare/node_modules/cloudflare-package/context-canary.txt"
  ".pnpm-store/context-canary.txt"
  "cloudflare/.dev.vars"
  "cloudflare/.dev.vars.local"
  "cloudflare/.wrangler/dry-run/context-canary.txt"
  "audit-private.pem"
  "nested/audit-private.key"
  "nested/audit-client.p12"
  "nested/audit-client.pfx"
  "gha-creds-m3-audit.json"
  "credentials/gha-creds-m3-audit.json"
  "fukamu-cycle-worker-secrets.json"
  "runner/fukamu-cycle-worker-secrets.json"
  "logs/context-audit.log"
  "infra/terraform/staging/.terraform/providers/context-canary.txt"
  "infra/terraform/staging/terraform.tfstate"
  "infra/terraform/staging/terraform.tfstate.backup"
  "infra/terraform/staging/audit.tfplan"
  "infra/terraform/staging/backend.hcl"
  "infra/terraform/staging/fukamu-cycle-staging-backend.hcl"
  "infra/terraform/staging/terraform.tfvars"
  "infra/terraform/staging/audit.tfvars"
  "infra/terraform/staging/audit.tfvars.json"
  "infra/terraform/staging/crash.log"
  "infra/terraform/staging/crash.context-audit.log"
)

for relative_path in "${forbidden_paths[@]}"; do
  canary_path="${context_dir}/${relative_path}"
  mkdir -p -- "$(dirname -- "${canary_path}")"
  printf '%s\n' "benign forbidden context canary" >"${canary_path}"
done

leaked_paths=()
for dockerfile_name in Dockerfile Dockerfile.local; do
  output_dir="${audit_root}/output-${dockerfile_name//./-}"
  docker buildx build \
    --file "${context_dir}/${dockerfile_name}" \
    --network=none \
    --no-cache \
    --output "type=local,dest=${output_dir}" \
    --progress=plain \
    "${context_dir}"

  [[ -f "${output_dir}/context/${allowed_path}" ]] \
    || die "Docker context inspection did not export the allowed marker for ${dockerfile_name}."

  for relative_path in "${forbidden_paths[@]}"; do
    if [[ -e "${output_dir}/context/${relative_path}" ]]; then
      leaked_paths+=("${dockerfile_name}: ${relative_path}")
    fi
  done
done

if ((${#leaked_paths[@]} > 0)); then
  printf '%s\n' "Error: Forbidden synthetic files reached a Docker build context:" >&2
  printf '  %s\n' "${leaked_paths[@]}" >&2
  exit 1
fi

printf '%s\n' "Docker build contexts exclude environment, dependency, credential, and Terraform artifacts."
